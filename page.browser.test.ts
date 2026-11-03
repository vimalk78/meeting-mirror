// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

let stream: { onmessage?: (event: { data: string }) => void };
const message = (text: string, role: "user" | "assistant" = "assistant") => ({ role, text, timestamp: 1000 });
const poll = { question: "Choose", options: [{ key: "A", label: "One" }, { key: "B", label: "Two" }] };
const vote = [{ username: "Ada", choice: "A", remark: "ok" }];
function send(event: unknown) {
	stream.onmessage?.({ data: JSON.stringify(event) });
}
function texts() {
	return [...document.querySelectorAll("#transcript > *")].map((node) =>
		node.id === "poll-card" ? node.textContent?.trim() : node.querySelector(".text")?.textContent?.trim(),
	);
}
async function start() {
	await import("./page.js");
}

beforeEach(() => {
	vi.resetModules();
	localStorage.clear();
	document.body.innerHTML = `
		<div id="identify-overlay" class="hidden"><input id="username-input"><button id="username-button">Join</button></div>
		<div id="identity-chip" class="hidden"></div>
		<main id="transcript"><div id="poll-card"></div></main>
		<button id="jump-latest" class="hidden"></button>`;
	vi.stubGlobal("EventSource", class {
		onmessage?: (event: { data: string }) => void;
		constructor() { stream = this; }
	});
	vi.stubGlobal("scrollTo", vi.fn());
});

describe("browser poll placement", () => {
	it("keeps revealed poll between the opening message and later question/answer after reconnect", async () => {
		await start();
		send({ type: "snapshot", sessionId: "s", snapshot: { messages: [message("options")], poll: null, revealed: null, voteCount: null, pollAnchor: null } });
		send({ type: "poll_open", poll, anchor: 1 });
		send({ type: "poll_reveal", votes: vote });
		send({ type: "transcript_delta", message: message("question", "user") });
		send({ type: "transcript_delta", message: message("answer") });
		expect(texts()).toEqual(["options", expect.stringContaining("VOTE RESULTS"), "question", "answer"]);
		send({ type: "snapshot", sessionId: "s", snapshot: { messages: [message("options"), message("question", "user"), message("answer")], poll, revealed: vote, voteCount: 1, pollAnchor: 1 } });
		expect(texts()).toEqual(["options", expect.stringContaining("VOTE RESULTS"), "question", "answer"]);
	});

	it("retains an open poll at its anchor and restores the vote count after a branch reset", async () => {
		await start();
		send({ type: "snapshot", sessionId: "s", snapshot: { messages: [message("options")], poll, revealed: null, voteCount: 2, pollAnchor: 1 } });
		send({ type: "transcript_delta", message: message("later") });
		expect(texts()).toEqual(["options", expect.stringContaining("2 votes in"), "later"]);
		send({ type: "transcript_reset", snapshot: { messages: [message("new options"), message("new later")], poll, revealed: null, voteCount: 2, pollAnchor: 1 } });
		expect(texts()).toEqual(["new options", expect.stringContaining("2 votes in"), "new later"]);
	});

	it("clamps the anchor when a rewind removes the opening message", async () => {
		await start();
		send({ type: "snapshot", sessionId: "s", snapshot: { messages: [message("options"), message("other")], poll, revealed: vote, voteCount: 1, pollAnchor: 2 } });
		send({ type: "transcript_reset", snapshot: { messages: [message("fork")], poll, revealed: vote, voteCount: 1, pollAnchor: 2 } });
		expect(texts()).toEqual(["fork", expect.stringContaining("VOTE RESULTS")]);
	});

	it("never scrolls automatically on new messages or snapshot restore", async () => {
		await start();
		send({ type: "snapshot", sessionId: "s", snapshot: { messages: [message("options")], poll: null, revealed: null, voteCount: null, pollAnchor: null } });
		send({ type: "transcript_delta", message: message("new reply") });
		expect(window.scrollTo).not.toHaveBeenCalled();
	});

	it("retains a revealed poll after branch reset, and orders later messages after it", async () => {
		await start();
		send({ type: "snapshot", sessionId: "s", snapshot: { messages: [message("options")], poll, revealed: vote, voteCount: 1, pollAnchor: 1 } });
		send({ type: "transcript_reset", snapshot: { messages: [message("fork options"), message("fork question", "user")], poll, revealed: vote, voteCount: 1, pollAnchor: 1 } });
		send({ type: "transcript_delta", message: message("fork answer") });
		expect(texts()).toEqual(["fork options", expect.stringContaining("VOTE RESULTS"), "fork question", "fork answer"]);
	});
});
