import { describe, it, expect } from "vitest";
import { nthLastAssistant, isConversationMessage } from "./index-helpers.js";
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
