import type { MirrorMessage } from "./state.js";

/**
 * Return the Nth-last assistant message from the conversation log.
 * Throws a PollArgError-style Error naming how many assistant messages exist
 * when n is out of range.
 */
export function nthLastAssistant(messages: MirrorMessage[], n: number): MirrorMessage {
	const assistantMessages = messages.filter((m) => m.role === "assistant");
	if (n < 1 || n > assistantMessages.length) {
		throw new Error(
			`Only ${assistantMessages.length} assistant message${assistantMessages.length === 1 ? "" : "s"} available; cannot use /poll ${n}.`,
		);
	}
	return assistantMessages[assistantMessages.length - n]!;
}

type ContentBlock = {
	type?: string;
	text?: string;
};

/** A conversation message as pi exposes it (subset of fields we read). */
export type SessionMessage = {
	role?: string;
	content?: unknown;
	timestamp?: number;
};

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		const block = part as ContentBlock;
		if (block && block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		}
	}
	return parts.join("\n");
}

/** Extract the displayable text of a session message, "" when none. */
export function messageText(message: SessionMessage): string {
	return textOf(message.content).trim();
}

/**
 * True when the message is one the team page should see: user or assistant
 * role, with non-empty text. Excludes slash-command invocations (user
 * messages starting with "/"), tool results, and system messages.
 */
export function isConversationMessage(message: SessionMessage): boolean {
	const role = message.role;
	if (role !== "user" && role !== "assistant") return false;
	const text = messageText(message);
	if (text === "") return false;
	if (role === "user" && text.startsWith("/")) return false;
	return true;
}

export type BranchEntry = {
	id?: string;
	type?: string;
	message?: SessionMessage;
};

/**
 * Append every unseen conversation entry from a session branch to the mirror
 * state. Tracks entries by id when present (so a rewound or forked branch
 * never duplicates), falling back to positional keys for id-less entries.
 * Returns true when anything was appended.
 */
export function resyncFromBranch(
	branch: BranchEntry[],
	seen: Set<string>,
	append: (message: { role: "user" | "assistant"; text: string; timestamp?: number }) => void,
	reset?: (messages: { role: "user" | "assistant"; text: string; timestamp?: number }[]) => void,
): boolean {
	const keyOf = (entry: BranchEntry, i: number): string =>
		typeof entry.id === "string" && entry.id !== "" ? entry.id : `#${i}`;
	const branchKeys = new Set(branch.map((entry, i) => keyOf(entry, i)));
	let rewound = false;
	for (const key of seen) {
		if (!branchKeys.has(key)) {
			rewound = true;
			break;
		}
	}
	if (rewound && reset) {
		// The session was rewound or forked: rebuild the transcript from the
		// active branch instead of appending, and re-seed the seen set.
		seen.clear();
		const messages: { role: "user" | "assistant"; text: string; timestamp?: number }[] = [];
		for (let i = 0; i < branch.length; i++) {
			const entry = branch[i]!;
			seen.add(keyOf(entry, i));
			if (entry.type !== "message" || !entry.message) continue;
			if (isConversationMessage(entry.message)) {
				messages.push({
					role: entry.message.role === "user" ? "user" : "assistant",
					text: messageText(entry.message),
					timestamp: entry.message.timestamp,
				});
			}
		}
		reset(messages);
		return true;
	}
	let appended = false;
	for (let i = 0; i < branch.length; i++) {
		const entry = branch[i]!;
		const key = keyOf(entry, i);
		if (seen.has(key)) continue;
		seen.add(key);
		if (entry.type !== "message" || !entry.message) continue;
		if (isConversationMessage(entry.message)) {
			append({
				role: entry.message.role === "user" ? "user" : "assistant",
				text: messageText(entry.message),
				timestamp: entry.message.timestamp,
			});
			appended = true;
		}
	}
	return appended;
}
