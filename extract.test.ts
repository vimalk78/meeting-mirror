import { describe, it, expect } from "vitest";
import { parsePollArgs, buildExtractionPrompt, extractPoll, PollArgError } from "./extract.js";
import type { CompleteFn } from "./extract.js";

describe("parsePollArgs", () => {
	it("empty string → index form, n=1", () => {
		expect(parsePollArgs("")).toEqual({ kind: "index", n: 1 });
	});

	it("whitespace-only string → index form, n=1", () => {
		expect(parsePollArgs("   ")).toEqual({ kind: "index", n: 1 });
	});

	it('"2" → index form, n=2', () => {
		expect(parsePollArgs("2")).toEqual({ kind: "index", n: 2 });
	});

	it('"Which? | A | B" → manual poll with keys A and B', () => {
		const result = parsePollArgs("Which? | A option | B option");
		expect(result).toEqual({
			kind: "manual",
			poll: {
				question: "Which?",
				options: [
					{ key: "A", label: "A option" },
					{ key: "B", label: "B option" },
				],
			},
		});
	});

	it("four segments → question plus three options, keys A B C", () => {
		const result = parsePollArgs("Q | one | two | three");
		if (result.kind !== "manual") throw new Error("expected manual");
		expect(result.poll.options.map((o) => o.key)).toEqual(["A", "B", "C"]);
		expect(result.poll.options[2]?.label).toBe("three");
	});

	it("single segment without pipe → throws PollArgError naming valid forms", () => {
		expect(() => parsePollArgs("just a question")).toThrow(/\/poll/);
	});

	it('"0" → throws', () => {
		expect(() => parsePollArgs("0")).toThrow();
	});

	it('"-1" → throws', () => {
		expect(() => parsePollArgs("-1")).toThrow();
	});

	it('"abc" → throws', () => {
		expect(() => parsePollArgs("abc")).toThrow();
	});

	it("manual form with fewer than 2 options → throws", () => {
		expect(() => parsePollArgs("Q | only")).toThrow();
	});

	it("manual form with empty question → throws", () => {
		expect(() => parsePollArgs("  | a | b")).toThrow();
	});
});

describe("buildExtractionPrompt", () => {
	it("contains the message text fenced in <message> tags and demands JSON-only output", () => {
		const prompt = buildExtractionPrompt("Should we build A or B?");
		expect(prompt).toContain("<message>\nShould we build A or B?\n</message>");
		expect(prompt).toContain('"question": string, "options": string[]');
		expect(prompt).toContain("ONLY valid JSON");
		expect(prompt).toContain('"Yes", "No"');
	});
});

describe("extractPoll", () => {
	const msg = "Two approaches: A local server, or B relay through internal host.";

	it("valid JSON response → Poll with keys A and B", async () => {
		const complete: CompleteFn = async () =>
				'{"question": "Which transport?", "options": ["Local server", "Relay"]}';
		const poll = await extractPoll(msg, complete);
		expect(poll).toEqual({
			question: "Which transport?",
			options: [
				{ key: "A", label: "Local server" },
				{ key: "B", label: "Relay" },
			],
		});
	});

	it("JSON wrapped in markdown fences is still parsed", async () => {
		const complete: CompleteFn = async () =>
			'```json\n{"question": "Q?", "options": ["x", "y"]}\n```';
		const poll = await extractPoll(msg, complete);
		expect(poll.options).toHaveLength(2);
	});

	it("zero options → ExtractionError mentioning pipe syntax", async () => {
		const complete: CompleteFn = async () => '{"question": "Q?", "options": []}';
		await expect(extractPoll(msg, complete)).rejects.toThrow(/pipe/);
	});

	it("one option → ExtractionError", async () => {
		const complete: CompleteFn = async () => '{"question": "Q?", "options": ["only"]}';
		await expect(extractPoll(msg, complete)).rejects.toThrow(/pipe/);
	});

	it("invalid JSON twice → ExtractionError mentioning pipe syntax", async () => {
		const complete: CompleteFn = async () => "not json at all";
		await expect(extractPoll(msg, complete)).rejects.toThrow(/pipe/);
	});

	it("empty question → ExtractionError", async () => {
		const complete: CompleteFn = async () => '{"question": "", "options": ["x", "y"]}';
		await expect(extractPoll(msg, complete)).rejects.toThrow(/pipe/);
	});

	it("retries once on invalid JSON then succeeds", async () => {
		let calls = 0;
		const complete: CompleteFn = async () => {
			calls++;
			return calls === 1 ? "oops" : '{"question": "Q?", "options": ["x", "y"]}';
		};
		const poll = await extractPoll(msg, complete);
		expect(poll.options).toHaveLength(2);
		expect(calls).toBe(2);
	});
});
