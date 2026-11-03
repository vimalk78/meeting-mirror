import { describe, it, expect } from "vitest";
import { parsePollArgs } from "./extract.js";

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

	it("single segment without pipe → throws", () => {
		expect(() => parsePollArgs("just a question")).toThrow(/pipe/i);
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
