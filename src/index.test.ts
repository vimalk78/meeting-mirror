import { describe, it, expect } from "vitest";
import { nthLastAssistant, isConversationMessage } from "./index-helpers.js";
import { escapeHtml, renderMarkdown, renderTally, formatMessage } from "../page/page.js";
import { pageView, boardLinkState } from "../page/page.js";
import { resyncFromBranch } from "./index-helpers.js";
import { formatPollResult } from "./index.js";
import type { MirrorMessage } from "./state.js";

const msgs: MirrorMessage[] = [
	{ role: "user", text: "first prompt", timestamp: 1 },
	{ role: "assistant", text: "first reply", timestamp: 2 },
	{ role: "user", text: "second prompt", timestamp: 3 },
	{ role: "assistant", text: "second reply", timestamp: 4 },
];

describe("pageView", () => {
	it("main vs board, local and relay paths", () => {
		expect(pageView("/")).toEqual({ view: "main", base: "" });
		expect(pageView("/board")).toEqual({ view: "board", base: "" });
		expect(pageView("/s/ols-4596")).toEqual({ view: "main", base: "/s/ols-4596" });
		expect(pageView("/s/ols-4596/board")).toEqual({ view: "board", base: "/s/ols-4596" });
		expect(pageView("/s/board")).toEqual({ view: "main", base: "/s/board" });
		expect(pageView("/s/board/board/")).toEqual({ view: "board", base: "/s/board" });
	});
});

describe("boardLinkState", () => {
	it("none / active / new from screen and seen name", () => {
		expect(boardLinkState(null, "a.html")).toBe("none");
		expect(boardLinkState({ name: "a.html" }, "a.html")).toBe("active");
		expect(boardLinkState({ name: "b.html" }, "a.html")).toBe("new");
		expect(boardLinkState({ name: "a.html" }, null)).toBe("new");
	});
});

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

describe("renderMarkdown — full structures", () => {
	it("renders ATX headings", () => {
		const html = renderMarkdown("## Title");
		expect(html).toContain("<h2>Title</h2>");
	});

	it("renders unordered lists", () => {
		const html = renderMarkdown("- one\n- two");
		expect(html).toContain("<ul>");
		expect(html).toContain("<li>one</li>");
		expect(html).toContain("<li>two</li>");
	});

	it("renders ordered lists", () => {
		const html = renderMarkdown("1. first\n2. second");
		expect(html).toContain("<ol>");
		expect(html).toContain("<li>first</li>");
	});

	it("ordered lists keep their starting number across sections (user report: numbering restarts)", () => {
		const html = renderMarkdown("## A\n\n1. one\n2. two\n\n## B\n\n3. three\n4. four");
		expect(html).toContain("<ol><li>one</li><li>two</li></ol>");
		expect(html).toContain('<ol start="3"><li>three</li><li>four</li></ol>');
	});

	it("an item separated by a blank line keeps its number", () => {
		const html = renderMarkdown("17. seventeen\n\n18. eighteen");
		expect(html).toContain('<ol start="17"><li>seventeen</li></ol>');
		expect(html).toContain('<ol start="18"><li>eighteen</li></ol>');
	});

	it("renders blockquotes", () => {
		const html = renderMarkdown("> quoted text");
		expect(html).toContain("<blockquote>");
		expect(html).toContain("quoted text");
	});

	it("renders GFM tables with header and body cells", () => {
		const html = renderMarkdown("| Col A | Col B |\n|---|---|\n| 1 | 2 |\n| three | four |");
		expect(html).toContain("<table");
		expect(html).toContain("<th>Col A</th>");
		expect(html).toContain("<th>Col B</th>");
		expect(html).toContain("<td>1</td>");
		expect(html).toContain("<td>four</td>");
	});

	it("escapes HTML inside table cells", () => {
		const html = renderMarkdown("| a | b |\n|---|---|\n| <script> | x |");
		expect(html).toContain("&lt;script&gt;");
		expect(html).not.toContain("<script>");
	});

	it("column alignment from the delimiter row", () => {
		const html = renderMarkdown("| a | b |\n|:---|---:|\n| 1 | 2 |");
		expect(html).toContain('<th style="text-align:left">a</th>');
		expect(html).toContain('<th style="text-align:right">b</th>');
	});

	it("a paragraph line with a pipe is not eaten by the table parser when no delimiter follows", () => {
		const html = renderMarkdown("see a | b in this sentence\n\nnext");
		expect(html).toContain("<p>see a | b in this sentence</p>");
	});

	it("renders fenced code blocks with escaped content", () => {
		const html = renderMarkdown("```\nlet x = '<b>';\n```");
		expect(html).toContain("<pre><code>");
		expect(html).not.toContain("<b>");
		expect(html).toContain("&lt;b&gt;");
	});

	it("renders links with http(s) hrefs only", () => {
		const html = renderMarkdown("see [docs](https://example.com)");
		expect(html).toContain('<a href="https://example.com"');
		expect(html).toContain("docs</a>");
		const evil = renderMarkdown("[x](javascript:alert(1))");
		expect(evil).not.toContain('href="javascript');
	});

	it("renders italics", () => {
		const html = renderMarkdown("a *word* b");
		expect(html).toContain("<em>word</em>");
	});

	it("joins soft line breaks inside a paragraph", () => {
		const html = renderMarkdown("line one\nline two");
		expect(html).toContain("line one");
		expect(html).toContain("line two");
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

	it("detects a rewind/fork and rebuilds via reset instead of appending", () => {
		const seen = new Set<string>();
		const appended: string[] = [];
		let resetWith: string[] | null = null;
		// first sync over the original branch
		const original = [user("1", "q"), assistant("2", "old reply")];
		resyncFromBranch(original as never, seen, (m) => appended.push(m.text));
		expect(appended).toEqual(["q", "old reply"]);
		// fork: same prefix, abandoned tail, divergent new entry
		const forked = [user("1", "q"), assistant("2b", "new reply")];
		resyncFromBranch(
			forked as never,
			seen,
			(m) => appended.push(m.text),
			(messages) => (resetWith = messages.map((m) => m.text)),
		);
		expect(resetWith).toEqual(["q", "new reply"]);
		expect(appended).toEqual(["q", "old reply"]); // nothing appended on rebuild
		// the seen set now matches the forked branch: no further rewind
		let resetAgain: string[] | null = null;
		resyncFromBranch(
			[...forked, user("4", "more")] as never,
			seen,
			(m) => appended.push(m.text),
			(messages) => (resetAgain = messages.map((m) => m.text)),
		);
		expect(resetAgain).toBeNull();
		expect(appended).toEqual(["q", "old reply", "more"]);
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

describe("formatPollResult", () => {
	it("formats counts with voter names and attributed remarks", () => {
		const poll = {
			question: "Which approach?",
			options: [
				{ key: "A", label: "Local server" },
				{ key: "B", label: "Relay" },
			],
		};
		const votes = [
			{ username: "alice", choice: "A", remark: "" },
			{ username: "bob", choice: "A", remark: "" },
			{ username: "kim", choice: "B", remark: "safer" },
		];
		const text = formatPollResult(poll, votes);
		expect(text).toContain("[Poll result] Which approach?");
		expect(text).toContain("A — Local server: 2 votes (alice, bob)");
		expect(text).toContain("B — Relay: 1 vote (kim)");
		expect(text).toContain("- kim (B): safer");
	});

	it("handles no poll and empty votes", () => {
		expect(formatPollResult(null, [])).toBe("No poll result.");
	});
});

describe("reveal notice (user report: result hidden by second toast)", () => {
	it("combines the poll result and the close hint into one message", async () => {
		const { revealNotice } = await import("./index.js");
		const msg = revealNotice(
			{ question: "Ship?", options: [{ key: "A", label: "yes" }, { key: "B", label: "no" }] },
			[
				{ username: "Ann", choice: "A", remark: "" },
				{ username: "Bob", choice: "B", remark: "" },
			],
		);
		expect(msg).toContain("[Poll result] Ship?");
		expect(msg).toContain("A — yes: 1 vote (Ann)");
		expect(msg).toContain("/poll-close");
	});
});

describe("existing poll notice (user report: prompt shown for a doomed poll)", () => {
	it("names the open poll and the commands to finish it", async () => {
		const { existingPollNotice } = await import("./index.js");
		const msg = existingPollNotice({ question: "Ship?", options: [{ key: "A", label: "yes" }] }, false);
		expect(msg).toContain("Ship?");
		expect(msg).toContain("/reveal");
		expect(msg).toContain("/poll-close");
		const revealed = existingPollNotice({ question: "Ship?", options: [{ key: "A", label: "yes" }] }, true);
		expect(revealed).toContain("already revealed");
	});
});
