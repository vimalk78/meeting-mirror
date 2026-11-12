import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { uuidv7 } from "@earendil-works/pi-ai";
import { networkInterfaces } from "node:os";
import { MirrorState, type Poll } from "./state.js";
import { Hub } from "./hub.js";
import { LocalServer, type Transport } from "./transport.js";
import { RelayClient, RoomBusyError } from "./relay-client.js";
import { CLEARED_ROOM_MARKER, STORED_ROOM_TYPE, findStoredRoom, type Room } from "./rooms.js";
import { decideForget, decideShare, relayChangePrompt } from "./index-share.js";
import { parsePollArgs, extractPoll, ExtractionError } from "./extract.js";
import { nthLastAssistant, resyncFromBranch, type BranchEntry } from "./index-helpers.js";
import { BoardWatcher } from "./board-watcher.js";
import { membersText, allVotedNotice } from "../page/page.js";

/** Notice when /poll is run while another poll is open or revealed. */
export function existingPollNotice(poll: Poll, revealed: boolean): string {
	const state = revealed ? "already revealed" : "open";
	return `A poll is ${state} ("${poll.question.slice(0, 60)}${poll.question.length > 60 ? "…" : ""}"). Run /reveal to show its results and /poll-close before opening a new one.`;
}

/** Single notify for /reveal: the result plus the close hint in one
 * message, because a second toast would replace the first. */
export function revealNotice(
	poll: Poll | null,
	votes: { username: string; choice: string; remark: string }[],
): string {
	return `${formatPollResult(poll, votes)}\nRun /poll-close when the team has seen the results.`;
}

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

/** The spec's confirmation prompt, verbatim structure. */
function confirmPrompt(roomName: string): string {
	return `Room "${roomName}" has not been shared from this pi session before.

If your team has used this room already, continue from that conversation instead:

  - Your own earlier session: quit, then reopen it with  pi --resume
  - A teammate's session: ask them for the session file, then open it with
      pi --session <file>.jsonl
    Session files are in ~/.pi/agent/sessions/<project-folder>/
    If you have an /export HTML file: open it in a browser, click "↓ JSONL"
    at the top right, then use  pi --session <downloaded>.jsonl
  - You only have the room link: run  /mirror share <link>
    (keeps the team's link, but shows this session's conversation)

Start "${roomName}" as a new room? Any existing link for this room will stop working.`;
}

export default function meetingMirror(pi: ExtensionAPI): void {
	let state: MirrorState | null = null;
	let hub: Hub | null = null;
	let server: Transport | null = null;
	/** Watches the companion for the visual board while shared. */
	let board: BoardWatcher | null = null;
	/** Notifies from places without a command ctx (hub event subscription). */
	let uiNotify: ((msg: string, level: "info" | "warning") => void) | null = null;
	/** One all-voted notice per open poll. */
	let allVotedNotified = false;

	const ensureState = (): MirrorState => {
		if (!state) throw new Error("Meeting Mirror is not active in this session.");
		return state;
	};

	// Resync the page state from the session branch, appending conversation
	// entries we have not yet seen. Tracks entry ids, so a rewound or forked
	// branch never duplicates or silently stops updating.
	const seenEntries = new Set<string>();
	const storedRoom = (ctx: { sessionManager: { getBranch: () => BranchEntry[] } }, name?: string): Room | null =>
		findStoredRoom(ctx.sessionManager.getBranch() as never, name);
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

	/** All non-internal IPv4 addresses of this machine, for the notify URL. */
	/**
	 * IPv4 addresses teammates could plausibly reach, for the notify URL.
	 * Skips loopback, virtual bridges (docker/libvirt/veth), and VPN tunnel
	 * gateways (tun*), keeping physical NICs and mesh interfaces like wt0.
	 */
	const allAddresses = (): string[] => {
		const found: string[] = [];
		for (const [name, nets] of Object.entries(networkInterfaces())) {
			if (/^(docker|virbr|veth|tun|br-)/.test(name)) continue;
			for (const net of nets ?? []) {
				if (net.family === "IPv4" && !net.internal) found.push(net.address);
			}
		}
		return found;
	};

	/** Port from MEETING_MIRROR_PORT, else the LocalServer default. */
	const configuredPort = (() => {
		const raw = process.env.MEETING_MIRROR_PORT;
		const n = raw ? Number.parseInt(raw, 10) : NaN;
		return Number.isInteger(n) && n > 0 && n < 65536 ? n : undefined;
	})();

	/** Bind address from MEETING_MIRROR_HOST (e.g. "127.0.0.1", "wt0" IP), else all interfaces. */
	const configuredHost = process.env.MEETING_MIRROR_HOST?.trim() || undefined;

	pi.on("session_start", async (_event, ctx) => {
		state = new MirrorState();
		hub = new Hub(state);
		uiNotify = (msg, level) => ctx.ui.notify(msg, level);
		allVotedNotified = false;
		// Guide the moderator: when every present member has voted, say so once.
		hub.subscribe((event) => {
			if (event.type === "poll_open" || event.type === "poll_reveal" || event.type === "poll_close") {
				allVotedNotified = false;
				return;
			}
			if (event.type !== "members" || allVotedNotified || !state || !hub) return;
			const notice = allVotedNotice(state.getSnapshot(), hub.memberList());
			if (notice) {
				allVotedNotified = true;
				uiNotify?.(notice, "info");
			}
		});
		seenEntries.clear();
		resync(ctx);
		// Sharing is opt-in: the session stays private until /mirror share.
		ctx.ui.notify("Meeting Mirror: session is private. Use /mirror share to share it.", "info");
	});

	pi.on("session_shutdown", async () => {
		await server?.stop();
		server = null;
		board?.stop();
		board = null;
		state = null;
	});

	// Relay finished conversation messages to the page after each agent run.
	pi.on("agent_end", async (_event, ctx) => {
		resync(ctx);
	});

	const startSharing = async (args: string, ctx: {
		ui: { notify: (msg: string, level: "info" | "warning") => void; select: (title: string, options: string[]) => Promise<string | undefined> };
		sessionManager: { getBranch: () => BranchEntry[] };
		cwd: string;
	}): Promise<void> => {
		if (server) {
			ctx.ui.notify("Meeting Mirror is already shared.", "info");
			return;
		}
		ensureState();
		const stored = storedRoom(ctx);
		const decision = decideShare(args, stored, (name) => storedRoom(ctx, name), process.env.MEETING_MIRROR_RELAY);

		if (decision.mode === "error") {
			ctx.ui.notify(decision.message, "warning");
			return;
		}

		if (decision.mode === "local") {
			server = new LocalServer(hub!, { port: configuredPort, host: configuredHost });
			try {
				await server.start();
				const local = server as LocalServer;
				const port = local.url.split(":").pop();
				const urls = allAddresses().map((a) => `http://${a}:${port}/?key=${local.key}`);
				ctx.ui.notify(`Meeting Mirror page: ${local.pageUrl}${urls.length ? ` (teammates: ${urls.join(", ")})` : ""}`, "info");
				board = new BoardWatcher(hub!, ctx.cwd);
				board.start();
			} catch (err) {
				server = null;
				ctx.ui.notify(`Meeting Mirror failed to start: ${err instanceof Error ? err.message : err}`, "warning");
			}
			return;
		}

		// relay mode
		let room = decision.room;
		if (decision.needsConfirm) {
			const answer = await ctx.ui.select(
				decision.replaces ? relayChangePrompt(decision.replaces, room) : confirmPrompt(room.name),
				["No", "Yes, start a new room"],
			);
			if (answer !== "Yes, start a new room") return;
		}
		const client = new RelayClient(hub!, room, {
			onLost: (reason) => {
				server = null;
				board?.stop();
				board = null;
				ctx.ui.notify(
					reason === "replaced"
						? `Meeting Mirror: another moderator took over room ${room.name}.`
						: `Meeting Mirror: lost room ${room.name}.`,
					"warning",
				);
			},
		});
		try {
			await client.start();
		} catch (err) {
			if (err instanceof RoomBusyError) {
				ctx.ui.notify(`Room ${room.name} is busy: another moderator is sharing it.`, "warning");
				return;
			}
			ctx.ui.notify(`Meeting Mirror failed to reach the relay: ${err instanceof Error ? err.message : err}`, "warning");
			return;
		}
		server = client;
		board = new BoardWatcher(hub!, ctx.cwd);
		board.start();
		ctx.ui.notify(`Meeting Mirror room: ${client.pageUrl}`, "info");
		if (decision.isNew) {
			pi.appendEntry(STORED_ROOM_TYPE, room);
		}
	};

	const stopSharing = async (ctx: { ui: { notify: (msg: string, level: "info" | "warning") => void } }): Promise<void> => {
		if (!server) {
			ctx.ui.notify("Meeting Mirror is not shared.", "info");
			return;
		}
		await server.stop();
		server = null;
		board?.stop();
		board = null;
		ctx.ui.notify("Meeting Mirror: session is now private. Connected pages will disconnect.", "info");
	};

	pi.registerCommand("mirror", {
		description: "Share status, or /mirror share [name|link] | /mirror unshare | /mirror forget",
		handler: async (args, ctx) => {
			const action = args.trim();
			if (action === "unshare") {
				await stopSharing(ctx);
				return;
			}
			if (action === "forget") {
				const forget = decideForget(server !== null, storedRoom(ctx));
				if (forget.action === "forget") pi.appendEntry(STORED_ROOM_TYPE, CLEARED_ROOM_MARKER);
				ctx.ui.notify(forget.message, forget.action === "forget" ? "info" : "warning");
				return;
			}
			if (action.startsWith("share")) {
				const shareArgs = action.slice(5).trim();
				await startSharing(shareArgs, ctx);
				return;
			}
			if (action !== "") {
				ctx.ui.notify("Usage: /mirror [share [name|link] | unshare | forget]", "warning");
				return;
			}
			if (!server) {
				ctx.ui.notify("Meeting Mirror: session is private. Use /mirror share to share it.", "info");
				return;
			}
			const snapshot = ensureState().getSnapshot();
			const votes =
				snapshot.poll === null
					? "no poll open"
					: snapshot.revealed
						? `poll revealed: ${snapshot.poll.question} (${snapshot.voteCount} votes)`
						: `poll open: ${snapshot.poll.question} (${snapshot.voteCount} votes in, hidden)`;
			const members = membersText(hub!.memberList());
			ctx.ui.notify(`${server.pageUrl} — ${votes}${members ? `\n${members}` : ""}`, "info");
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
					ctx.ui.notify(revealNotice(ensureState().getSnapshot().poll, revealEvent.votes), "info");
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
			const snapshot = s.getSnapshot();
			if (snapshot.poll) {
				// bail out before extraction and the confirm dialog: opening is doomed
				ctx.ui.notify(existingPollNotice(snapshot.poll, snapshot.revealed !== null), "warning");
				return;
			}
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
				ctx.ui.notify("Poll opened on the Meeting Mirror page. /reveal shows the results, /poll-close closes the poll.", "info");
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
				ctx.ui.notify("Poll closed. The page no longer shows it.", "info");
			} catch (err) {
				ctx.ui.notify(err instanceof Error ? err.message : "No poll is open.", "warning");
			}
		},
	});
}
