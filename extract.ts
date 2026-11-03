import type { Poll } from "./state.js";

export class PollArgError extends Error {}
export class ExtractionError extends Error {}

export type CompleteFn = (prompt: string) => Promise<string>;

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
	if (validLabels.length > 8) {
		throw new PollArgError("A poll supports at most 8 options.");
	}
	const keys = ["A", "B", "C", "D", "E", "F", "G", "H"];
	return {
		question,
		options: validLabels.map((label, i) => ({ key: keys[i] ?? String(i + 1), label })),
	};
}

export function buildExtractionPrompt(messageText: string): string {
	return `You are extracting a poll from a message written by an AI assistant
during a brainstorming session.

The message presents a question and a small set of distinct options
for the team to choose between. Extract them.

Return ONLY valid JSON in this exact shape, with no other text:
{"question": string, "options": string[]}

Rules:
- "question": the question being put to the team, in the message's own
  words where possible. If no explicit question exists, summarize the
  choice being offered in one sentence.
- "options": 2 to 4 options the message presents, in the original
  order. Keep each option's own wording; shorten only if it is too
  long to read as a button label.
- If the question is yes/no or agree/disagree in nature, use
  "options": ["Yes", "No"] (or ["Agree", "Disagree"]).
- If the message does not present a choice between distinct options,
  return {"question": "", "options": []}.

Message:
<message>
${messageText}
</message>`;
}

export async function extractPoll(messageText: string, complete: CompleteFn): Promise<Poll> {
	const prompt = buildExtractionPrompt(messageText);
	for (let attempt = 1; attempt <= 2; attempt++) {
		const raw = await complete(prompt);
		const parsed = tryParse(raw);
		if (parsed) {
			const { question, options } = parsed;
			if (
				typeof question === "string" &&
				question.trim() !== "" &&
				Array.isArray(options) &&
				options.length >= 2 &&
				options.length <= 8 &&
				options.every((o) => typeof o === "string" && o.trim() !== "")
			) {
				const keys = ["A", "B", "C", "D", "E", "F", "G", "H"];
				return {
					question: question.trim(),
					options: options.map((label, i) => ({ key: keys[i] ?? String(i + 1), label: label.trim() })),
				};
			}
		}
	}
	throw new ExtractionError(
		"Could not extract a poll from that message. Use pipe syntax instead: /poll question | option | option",
	);
}

function tryParse(raw: string): { question?: unknown; options?: unknown } | null {
	let text = raw.trim();
	const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
	if (fenced) text = fenced[1] ?? "";
	try {
		const obj: unknown = JSON.parse(text);
		if (obj && typeof obj === "object" && !("question" in obj) ) return null;
		return obj as { question?: unknown; options?: unknown };
	} catch {
		return null;
	}
}
