import { describe, it, expect } from "vitest";
import { nthLastAssistant, isConversationMessage } from "./index-helpers.js";
import { escapeHtml, renderMarkdown, renderTally, formatMessage } from "./page.js";
import { resyncFromBranch } from "./index-helpers.js";
import type { MirrorMessage } from "./state.js";

const msgs: MirrorMessage[] = [
	{ role: "user", text: "first prompt", timestamp: 1 },
	{ role: "assistant", text: "first reply", timestamp: 2 },
	{ role: "user", text: "second prompt", timestamp: 3 },
	{ role: "assistant", text: "second reply", timestamp: 4 },
];

describe("nthLastAssistant", () => {
	it("n=1 returns the last assistant message", () => {
		expect(nthLastAssistant(msgs, 1).text).toBe("second reply");
	});

	it("n=2 returns the previous assistant message", () => {
		expect(nthLastAssistant(msgs, 2).text).toBe("first reply");
	});

	it("n out of range throws naming how many assistant messages exist", () => {
		expect(() => nthLastAssistant(msgs, 3)).toThrow(/2 assistant message/);
		expect(() => nthLastAssistant(msgs, 0)).toThrow();
	});
});

describe("isConversationMessage", () => {
	it("user text message → true", () => {
		expect(isConversationMessage({ role: "user", content: "hello" })).toBe(true);
	});

	it("assistant text message → true", () => {
		expect(isConversationMessage({ role: "assistant", content: [{ type: "text", text: "hi" }] })).toBe(true);
	});

	it("user message starting with / (command invocation) → false", () => {
		expect(isConversationMessage({ role: "user", content: "/poll 2" })).toBe(false);
	});

	it("tool message → false", () => {
		expect(isConversationMessage({ role: "tool", content: "result" })).toBe(false);
	});

	it("system message → false", () => {
		expect(isConversationMessage({ role: "system", content: "sys" })).toBe(false);
	});

	it("assistant message with only tool calls → false", () => {
		expect(
			isConversationMessage({
				role: "assistant",
				content: [{ type: "tool_call", name: "bash", arguments: {} }],
			}),
		).toBe(false);
	});

	it("assistant message with text and tool calls → true", () => {
		expect(
			isConversationMessage({
				role: "assistant",
				content: [
					{ type: "text", text: "let me check" },
					{ type: "tool_call", name: "bash", arguments: {} },
				],
			}),
		).toBe(true);
	});
});

describe("escapeHtml", () => {
	it("escapes script tags into entities", () => {
		expect(escapeHtml("<script>alert(1)</script>")).toBe(
			"&lt;script&gt;alert(1)&lt;/script&gt;",
		);
	});
});

describe("renderMarkdown", () => {
	it("renders bold and code, escaping HTML first", () => {
		const html = renderMarkdown("**bold** and `code`");
		expect(html).toContain("<strong>bold</strong>");
		expect(html).toContain("<code>code</code>");
	});

	it("raw script tags stay escaped", () => {
		const html = renderMarkdown("hello <script>alert(1)</script>");
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;");
	});

	it("paragraphs become separate <p> blocks", () => {
		const html = renderMarkdown("one\n\ntwo");
		expect(html).toContain("<p>one</p>");
		expect(html).toContain("<p>two</p>");
	});
});

describe("renderTally", () => {
	it("renders one bar per option with proportional widths, voter names, and attributed remarks", () => {
		const options = [
			{ key: "A", label: "First" },
			{ key: "B", label: "Second" },
		];
		const votes = [
			{ username: "alice", choice: "A", remark: "cheap" },
			{ username: "bob", choice: "A", remark: "" },
			{ username: "kim", choice: "B", remark: "safer" },
		];
		const html = renderTally(votes, options);
		expect(html).toContain("First");
		expect(html).toContain("Second");
		expect(html).toContain("width: 100%"); // A: 2 votes, max option
		expect(html).toContain("width: 50%"); // B: 1 vote, half of max
		expect(html).toContain("alice");
		expect(html).toContain("bob");
		expect(html).toContain("kim");
		expect(html).toContain("cheap");
		expect(html).toContain("safer");
	});

	it("escapes remark text", () => {
		const html = renderTally([{ username: "x", choice: "A", remark: "<b>bold</b>" }], [{ key: "A", label: "o" }]);
		expect(html).not.toContain("<b>bold</b>");
	});
});

describe("formatMessage", () => {
	it("includes role label, timestamp, and escaped markdown text", () => {
		const m: MirrorMessage = { role: "assistant", text: "**hi** <script>", timestamp: 0 };
		const html = formatMessage(m);
		expect(html).toContain("PI");
		expect(html).toContain("<strong>hi</strong>");
		expect(html).not.toContain("<script>");
	});
});

describe("resyncFromBranch", () => {
	type Entry = { id?: string; type?: string; message?: { role?: string; content?: unknown } };
	const user = (id: string, text: string): Entry => ({ id, type: "message", message: { role: "user", content: text } });
	const assistant = (id: string, text: string): Entry => ({ id, type: "message", message: { role: "assistant", content: text } });

	it("appends unseen conversation entries and skips non-message and command entries", () => {
		const seen = new Set<string>();
		const appended: { role: string; text: string }[] = [];
		const branch = [user("1", "hi"), { id: "2", type: "compaction" }, assistant("3", "hello"), user("4", "/poll")];
		const changed = resyncFromBranch(branch as never, seen, (m) => appended.push({ role: m.role, text: m.text }));
		expect(changed).toBe(true);
		expect(appended).toEqual([
			{ role: "user", text: "hi" },
			{ role: "assistant", text: "hello" },
		]);
		expect([...seen]).toEqual(["1", "2", "3", "4"]);
	});

	it("is a no-op when the branch has no unseen entries", () => {
		const seen = new Set(["1"]);
		const appended: unknown[] = [];
		const changed = resyncFromBranch([user("1", "hi")] as never, seen, (m) => appended.push(m));
		expect(changed).toBe(false);
		expect(appended).toEqual([]);
	});

	it("handles a rewound or forked branch without duplicates", () => {
		const seen = new Set<string>(["1", "2"]);
		const appended: { role: string; text: string }[] = [];
		// fork: same prefix, divergent new entry with a new id
		const branch = [user("1", "hi"), assistant("2b", "different reply")];
		resyncFromBranch(branch as never, seen, (m) => appended.push({ role: m.role, text: m.text }));
		expect(appended).toEqual([{ role: "assistant", text: "different reply" }]);
	});

	it("preserves the original message timestamp", () => {
		const seen = new Set<string>();
		const appended: { text: string; timestamp?: number }[] = [];
		const branch = [
			{ id: "1", type: "message", message: { role: "assistant", content: "old reply", timestamp: 12345 } },
		];
		resyncFromBranch(branch as never, seen, (m) => appended.push({ text: m.text, timestamp: m.timestamp }));
		expect(appended[0]).toEqual({ text: "old reply", timestamp: 12345 });
	});

	it("tracks entries by id when present, by index otherwise", () => {
		const seen = new Set<string>();
		const appended: unknown[] = [];
		const noIds = [user("", "a"), user("", "b")];
		resyncFromBranch(noIds as never, seen, (m) => appended.push(m));
		expect(appended).toHaveLength(2);
		// second run over the same id-less branch must not duplicate
		resyncFromBranch(noIds as never, seen, (m) => appended.push(m));
		expect(appended).toHaveLength(2);
	});
});
