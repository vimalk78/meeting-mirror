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
