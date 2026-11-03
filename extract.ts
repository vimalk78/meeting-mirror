import type { Poll } from "./state.js";

export class PollArgError extends Error {}

/**
 * Parse the argument string of `/poll`.
 * - "" or whitespace → { kind: "index", n: 1 } (LLM extraction from last assistant message)
 * - "N" (positive integer) → { kind: "index", n: N }
 * - "question | option | option" → { kind: "manual", poll } (keys A, B, C, ...)
 */
export function parsePollArgs(args: string): { kind: "index"; n: number } | { kind: "manual"; poll: Poll } {
	const trimmed = args.trim();
	if (trimmed === "") {
		return { kind: "index", n: 1 };
	}
	if (/^\d+$/.test(trimmed)) {
		const n = Number.parseInt(trimmed, 10);
		if (n < 1) {
			throw new PollArgError(`Message index must be >= 1, got ${n}`);
		}
		return { kind: "index", n };
	}
	if (trimmed.includes("|")) {
		return { kind: "manual", poll: parsePipeSyntax(trimmed) };
	}
	throw new PollArgError(
		`Invalid /poll argument. Use "/poll", "/poll N" (Nth-last message), or "/poll question | option | option".`,
	);
}

function parsePipeSyntax(s: string): Poll {
	const segments = s.split("|").map((part) => part.trim());
	const question = segments[0] ?? "";
	const optionLabels = segments.slice(1);
	if (question === "") {
		throw new PollArgError("Question (before the first |) must not be empty.");
	}
	const validLabels = optionLabels.filter((l) => l !== "");
	if (validLabels.length !== optionLabels.length || validLabels.length < 2) {
		throw new PollArgError("Provide at least two non-empty options: /poll question | option | option");
	}
	const keys = ["A", "B", "C", "D", "E", "F", "G", "H"];
	return {
		question,
		options: validLabels.map((label, i) => ({ key: keys[i] ?? String(i + 1), label })),
	};
}
