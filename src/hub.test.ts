import { describe, it, expect } from "vitest";
import { Hub } from "./hub.js";
import { MirrorState } from "./state.js";
import type { HubEvent } from "./hub.js";

const poll = {
	question: "Which?",
	options: [
		{ key: "A", label: "One" },
		{ key: "B", label: "Two" },
	],
};

const state = () => new MirrorState();

describe("Hub identify", () => {
	it("identifies a client and the snapshot reports you for that client only", () => {
		const h = new Hub(state());
		const reply = h.identify({ clientId: "c1", username: "Alice" });
		expect(reply).toEqual({ status: 200, body: { name: "Alice" } });
		const { snapshot } = h.open("c1");
		expect(snapshot.you).toBe("Alice");
		expect(h.open("c9").snapshot.you).toBeNull();
	});

	it("conflict: same name from another client with an open connection → 409 with the conflict message", () => {
		const h = new Hub(state());
		h.identify({ clientId: "c1", username: "John" });
		h.open("c1");
		const reply = h.identify({ clientId: "c2", username: " John " });
		expect(reply.status).toBe(409);
		expect(reply.body).toEqual({
			error: "John is already in the room. Choose another name, for example John K.",
		});
	});

	it("handover: name frees when its owner has no open connection", () => {
		const h = new Hub(state());
		h.identify({ clientId: "c1", username: "John" });
		const conn1 = h.open("c1").connId;
		h.close(conn1);
		// no open connection: c2 may take the name
		expect(h.identify({ clientId: "c2", username: "John" }).status).toBe(200);
		// original owner rejoins while c2 is present → conflict
		h.open("c2");
		expect(h.identify({ clientId: "c1", username: "John" }).status).toBe(409);
	});

	it("same client renames; old name is freed", () => {
		const h = new Hub(state());
		h.identify({ clientId: "c1", username: "Alice" });
		h.open("c1");
		expect(h.identify({ clientId: "c1", username: "Bob" }).status).toBe(200);
		expect(h.identify({ clientId: "c2", username: "Alice" }).status).toBe(200);
	});

	it("invalid identify → 400; 501st client → 503", () => {
		const h = new Hub(state());
		expect(h.identify({ username: "x" }).status).toBe(400);
		expect(h.identify({ clientId: "c1", username: "  " }).status).toBe(400);
		for (let i = 0; i < 500; i++) {
			h.identify({ clientId: `c${i}`, username: `u${i}` });
		}
		expect(h.identify({ clientId: "c501", username: "late" }).status).toBe(503);
	});
});

describe("Hub vote", () => {
	it("vote from a client that never joined → 401 join first", () => {
		const h = new Hub(state());
		h.open("c9");
		const reply = h.vote({ clientId: "c9", choice: "A" });
		expect(reply).toEqual({ status: 401, body: { error: "join first" } });
	});

	it("vote from an identified client reaches the poll", () => {
		const s = state();
		const h = new Hub(s);
		h.identify({ clientId: "c1", username: "Alice" });
		h.open("c1");
		s.openPoll(poll);
		expect(h.vote({ clientId: "c1", choice: "A", remark: "x".repeat(600) }).status).toBe(200);
		const reveal = s.reveal()[0] as { votes: { username: string; remark: string }[] };
		expect(reveal.votes).toEqual([{ username: "Alice", choice: "A", remark: "x".repeat(500) }]);
	});
});

describe("Hub members", () => {
	it("members with votes and voteCount while a poll is open", () => {
		const s = state();
		const h = new Hub(s);
		h.identify({ clientId: "c1", username: "Alice" });
		h.identify({ clientId: "c2", username: "Bob" });
		expect(h.memberList()).toEqual({ members: [], voteCount: null }); // no connections yet
		h.open("c1");
		h.open("c2");
		expect(h.memberList()).toEqual({
			members: [
				{ name: "Alice", voted: false },
				{ name: "Bob", voted: false },
			],
			voteCount: null,
		});

		s.openPoll(poll);
		h.vote({ clientId: "c1", choice: "A" });
		expect(h.memberList()).toEqual({
			members: [
				{ name: "Alice", voted: true },
				{ name: "Bob", voted: false },
			],
			voteCount: 1,
		});

		s.reveal();
		expect(h.memberList()).toEqual({
			members: [
				{ name: "Alice", voted: false },
				{ name: "Bob", voted: false },
			],
			voteCount: 1,
		});
	});

	it("presence requires an open connection; two tabs count once", () => {
		const s = state();
		const h = new Hub(s);
		h.identify({ clientId: "c1", username: "Alice" });
		const connA = h.open("c1").connId;
		const connB = h.open("c1").connId;
		s.openPoll(poll);
		h.vote({ clientId: "c1", choice: "A" });
		expect(h.memberList().members).toEqual([{ name: "Alice", voted: true }]);
		h.close(connA);
		expect(h.memberList().members).toEqual([{ name: "Alice", voted: true }]);
		h.close(connB);
		expect(h.memberList().members).toEqual([]);
	});

	it("unjoined connections are not members; name frees after last close, tick resets on reopen", () => {
		const s = state();
		const h = new Hub(s);
		h.open("c9"); // never joined
		h.identify({ clientId: "c1", username: "Alice" });
		h.open("c1");
		expect(h.memberList().members).toEqual([{ name: "Alice", voted: false }]);
	});
});

describe("Hub events", () => {
	it("emits members on identify, vote, poll_open, poll_reveal, poll_close and presence changes", () => {
		const s = state();
		const h = new Hub(s);
		const events: HubEvent[] = [];
		h.subscribe((e) => events.push(e));
		h.identify({ clientId: "c1", username: "Alice" });
		const conn = h.open("c1").connId;
		const types = () => events.map((e) => e.type);
		expect(types()).toContain("members");
		events.length = 0;
		s.openPoll(poll);
		expect(types()).toEqual(["poll_open", "members"]);
		events.length = 0;
		h.vote({ clientId: "c1", choice: "A" });
		expect(types()).toContain("members");
		events.length = 0;
		s.reveal();
		expect(types()).toContain("members");
		events.length = 0;
		s.closePoll();
		expect(types()).toContain("members");
		events.length = 0;
		h.close(conn);
		// Alice has no connection now: presence change emits members
		expect(types()).toContain("members");
	});

	it("forwards transcript_delta unchanged and never emits vote_cast", () => {
		const s = state();
		const h = new Hub(s);
		const events: HubEvent[] = [];
		h.subscribe((e) => events.push(e));
		s.openPoll(poll);
		h.identify({ clientId: "c1", username: "Alice" });
		h.open("c1");
		s.appendMessage({ role: "assistant", text: "hi", timestamp: 1 });
		h.vote({ clientId: "c1", choice: "A" });
		const types = new Set(events.map((e) => e.type));
		expect(types.has("transcript_delta")).toBe(true);
		expect((events as { type: string }[]).some((e) => e.type === "vote_cast")).toBe(false);
	});
});

describe("Hub sessionId", () => {
	it("is a non-empty string and stable for the instance", () => {
		const h = new Hub(state());
		expect(typeof h.sessionId).toBe("string");
		expect(h.sessionId.length).toBeGreaterThan(0);
		expect(h.open("c1").snapshot.sessionId).toBe(h.sessionId);
	});
});

describe("name handover (review fix 5)", () => {
	it("taking over a departed member's name drops the old binding", () => {
		const hub = new Hub(new MirrorState());
		expect(hub.identify({ clientId: "c1", username: "John" }).status).toBe(200);
		hub.close(hub.open("c1").connId); // John's browser leaves
		expect(hub.identify({ clientId: "c2", username: "John" }).status).toBe(200);
		hub.open("c2");
		// the original browser reconnects: it must re-identify, not silently be John again
		const reopened = hub.open("c1");
		expect(reopened.snapshot.you).toBe(null);
		expect(hub.memberList().members.map((m) => m.name)).toEqual(["John"]);
	});
});

describe("poll_close clears member vote state (code review)", () => {
	it("members event after closePoll shows no ticks and voteCount null", () => {
		const state = new MirrorState();
		const hub = new Hub(state);
		hub.open("c1");
		hub.identify({ clientId: "c1", username: "Alice" });
		state.openPoll({ question: "q", options: [{ key: "A", label: "a" }, { key: "B", label: "b" }] });
		hub.vote({ clientId: "c1", choice: "A" });
		const events: any[] = [];
		hub.subscribe((e: unknown) => events.push(e));
		state.closePoll();
		const members = events.find((e: any) => e.type === "members");
		expect(members).toBeDefined();
		expect(members.members).toEqual([{ name: "Alice", voted: false }]);
		expect(members.voteCount).toBeNull();
	});
});
