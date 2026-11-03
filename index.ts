import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { uuidv7 } from "@earendil-works/pi-ai";
import { networkInterfaces } from "node:os";
import { MirrorState, type Poll } from "./state.js";
import { LocalServer } from "./transport.js";
import { parsePollArgs, extractPoll, ExtractionError } from "./extract.js";
import { nthLastAssistant, resyncFromBranch, type BranchEntry } from "./index-helpers.js";

/** Human-readable poll result, used for the terminal notify and the
 * injected session message. */
export function formatPollResult(
	poll: Poll | null,
	votes: { username: string; choice: string; remark: string }[],
): string {
	if (!poll) return "No poll result.";
	const counts = new Map<string, string[]>();
	for (const v of votes) {
		const names = counts.get(v.choice) ?? [];
		names.push(v.username);
		counts.set(v.choice, names);
	}
	const lines = [`[Poll result] ${poll.question}`];
	for (const o of poll.options) {
		const names = counts.get(o.key) ?? [];
		lines.push(`${o.key} — ${o.label}: ${names.length} vote${names.length === 1 ? "" : "s"}${names.length ? ` (${names.join(", ")})` : ""}`);
	}
	const remarks = votes.filter((v) => v.remark.trim() !== "");
	if (remarks.length > 0) {
		lines.push("Remarks:");
		for (const v of remarks) lines.push(`- ${v.username} (${v.choice}): ${v.remark}`);
	}
	return lines.join("\n");
}

export default function meetingMirror(pi: ExtensionAPI): void {
	let state: MirrorState | null = null;
	let server: LocalServer | null = null;

	const ensureState = (): MirrorState => {
		if (!state) throw new Error("Meeting Mirror is not active in this session.");
		return state;
	};

	// Resync the page state from the session branch, appending conversation
	// entries we have not yet seen. Tracks entry ids, so a rewound or forked
	// branch never duplicates or silently stops updating.
	const seenEntries = new Set<string>();
	const resync = (ctx: { sessionManager: { getBranch: () => BranchEntry[] } }): void => {
		if (!state) return;
		resyncFromBranch(
			ctx.sessionManager.getBranch(),
			seenEntries,
			(m) => state!.appendMessage({ ...m, timestamp: m.timestamp ?? Date.now() }),
			// Rewind/fork: replace the transcript; poll state survives.
			(messages) =>
				state!.resetMessages(messages.map((m) => ({ ...m, timestamp: m.timestamp ?? Date.now() }))),
		);
	};

	/** First non-internal IPv4 address of this machine, for the notify URL. */
	const lanAddress = (): string | null => {
		for (const nets of Object.values(networkInterfaces())) {
			for (const net of nets ?? []) {
				if (net.family === "IPv4" && !net.internal) return net.address;
			}
		}
		return null;
	};

	pi.on("session_start", async (_event, ctx) => {
		state = new MirrorState();
		seenEntries.clear();
		resync(ctx);
		server = new LocalServer(state);
		try {
			await server.start();
			const lan = lanAddress();
			ctx.ui.notify(`Meeting Mirror page: ${server.url}${lan ? ` (teammates: http://${lan}:${server.url.split(":").pop()})` : ""}`, "info");
		} catch (err) {
			server = null;
			ctx.ui.notify(`Meeting Mirror failed to start: ${err instanceof Error ? err.message : err}`, "warning");
		}
	});

	pi.on("session_shutdown", async () => {
		await server?.stop();
		server = null;
		state = null;
	});

	// Relay finished conversation messages to the page after each agent run.
	pi.on("agent_end", async (_event, ctx) => {
		resync(ctx);
	});

	pi.registerCommand("mirror", {
		description: "Show the Meeting Mirror page URL and vote count",
		handler: async (_args, ctx) => {
			if (!server) {
				ctx.ui.notify("Meeting Mirror is not running.", "warning");
				return;
			}
			const snapshot = ensureState().getSnapshot();
			const votes =
				snapshot.poll === null
				? "no poll open"
				: snapshot.revealed
					? `poll revealed: ${snapshot.poll.question} (${snapshot.voteCount} votes)`
					: `poll open: ${snapshot.poll.question} (${snapshot.voteCount} votes in, hidden)`;
			ctx.ui.notify(`${server.url} — ${votes}`, "info");
		},
	});

	pi.registerCommand("reveal", {
		description: "Reveal the current poll's votes on the Meeting Mirror page and in the terminal",
		handler: async (_args, ctx) => {
			try {
				const events = ensureState().reveal();
				const revealEvent = events.find((e) => e.type === "poll_reveal");
				if (revealEvent && revealEvent.type === "poll_reveal") {
					// Display only — terminal and page. Nothing enters the model's
					// context; the moderator relays or overrides as they choose.
					ctx.ui.notify(formatPollResult(ensureState().getSnapshot().poll, revealEvent.votes), "info");
				}
			} catch (err) {
				ctx.ui.notify(err instanceof Error ? err.message : "No poll is open.", "warning");
			}
		},
	});

	pi.registerCommand("poll", {
		description: "Open a poll: /poll [N] extracts from the Nth-last message, /poll q | opt | opt is manual",
		handler: async (args, ctx) => {
			const s = ensureState();
			let parsed;
			try {
				parsed = parsePollArgs(args);
			} catch (err) {
				ctx.ui.notify(err instanceof Error ? err.message : "Invalid /poll argument.", "warning");
				return;
			}

			let poll: Poll;
			if (parsed.kind === "manual") {
				poll = parsed.poll;
			} else {
				let source: { role: "user" | "assistant"; text: string; timestamp: number };
				try {
					source = nthLastAssistant(s.getSnapshot().messages, parsed.n);
				} catch (err) {
					ctx.ui.notify(err instanceof Error ? err.message : "Cannot find that message.", "warning");
					return;
				}
				const complete = async (prompt: string): Promise<string> => {
					const model = ctx.model ?? ctx.modelRegistry.getAvailable()[0];
					if (!model) throw new ExtractionError("No model available for poll extraction.");
					if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
						throw new ExtractionError("No authentication configured for the session model.");
					}
					const response = await ctx.modelRegistry.complete(
						model,
						{
							messages: [
								{
									role: "user" as const,
									content: [{ type: "text" as const, text: prompt }],
									timestamp: Date.now(),
								},
							],
						},
						{
							reasoningEffort: "low",
							cacheRetention: "none",
							sessionId: uuidv7(),
						},
					);
					return response.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n");
				};
				try {
					poll = await extractPoll(source.text, complete);
				} catch (err) {
					ctx.ui.notify(
						err instanceof Error ? err.message : "Poll extraction failed.",
						"warning",
					);
					return;
				}
			}

			// Terminal confirm: Enter to open, e to edit, Esc to cancel.
			const lines = [`Poll from: "${poll.question.slice(0, 60)}${poll.question.length > 60 ? "…" : ""}"`];
			poll.options.forEach((o) => lines.push(`  ${o.key} — ${o.label}`));
			lines.push("Open this poll?");
			const choice = await ctx.ui.select(lines.join("\n"), ["Open poll", "Edit", "Cancel"]);
			if (!choice || choice === "Cancel") return;

			let finalPoll = poll;
			if (choice === "Edit") {
				const question = await ctx.ui.input("Question", poll.question);
				if (question === undefined) return;
				const options: { key: string; label: string }[] = [];
				for (let i = 0; i < poll.options.length; i++) {
					const label = await ctx.ui.input(`Option ${poll.options[i]!.key}`, poll.options[i]!.label);
					if (label === undefined) return;
					options.push({ key: poll.options[i]!.key, label });
				}
				finalPoll = { question, options };
			}

			try {
				s.openPoll(finalPoll);
				ctx.ui.notify("Poll opened on the Meeting Mirror page.", "info");
			} catch (err) {
				ctx.ui.notify(err instanceof Error ? err.message : "Could not open poll.", "warning");
			}
		},
	});

	pi.registerCommand("poll-close", {
		description: "Close the current poll",
		handler: async (_args, ctx) => {
			try {
				ensureState().closePoll();
			} catch (err) {
				ctx.ui.notify(err instanceof Error ? err.message : "No poll is open.", "warning");
			}
		},
	});
}
