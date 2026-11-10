import { describe, it, expect } from "vitest";
import { MirrorState, type MirrorMessage } from "./state.js";

const msg = (role: "user" | "assistant", text: string): MirrorMessage => ({
	role,
	text,
	timestamp: 1000,
});

describe("MirrorState transcript", () => {
	it("appendMessage stores messages and getSnapshot returns them", () => {
		const s = new MirrorState();
		s.appendMessage(msg("user", "hello"));
		s.appendMessage(msg("assistant", "hi there"));
		expect(s.getSnapshot().messages).toHaveLength(2);
		expect(s.getSnapshot().messages[1]?.text).toBe("hi there");
	});

	it("subscribe receives transcript_delta on append, unsubscribe stops it", () => {
		const s = new MirrorState();
		const received: unknown[] = [];
		const off = s.subscribe((e) => received.push(e));
		s.appendMessage(msg("user", "x"));
		off();
		s.appendMessage(msg("user", "y"));
		expect(received).toHaveLength(1);
		expect(received[0]).toMatchObject({
			type: "transcript_delta",
			message: { role: "user", text: "x" },
		});
	});
});

describe("MirrorState poll lifecycle", () => {
	const poll = {
		question: "Which?",
		options: [
			{ key: "A", label: "First" },
			{ key: "B", label: "Second" },
		],
	};

	it("records the opening position and preserves it across later messages and reveal", () => {
		const s = new MirrorState();
		s.appendMessage(msg("assistant", "options"));
		expect(s.openPoll(poll)).toEqual([{ type: "poll_open", poll, anchor: 1 }]);
		s.appendMessage(msg("user", "question"));
		s.reveal();
		expect(s.getSnapshot().pollAnchor).toBe(1);
		const reset = s.resetMessages([msg("assistant", "fork options"), msg("user", "fork question")]);
		expect(reset).toEqual([{ type: "transcript_reset", snapshot: s.getSnapshot() }]);
		expect(s.getSnapshot().pollAnchor).toBe(1);
	});

	it("openPoll emits poll_open", () => {
		const s = new MirrorState();
		const events = s.openPoll(poll);
		expect(events).toEqual([
			{
				type: "poll_open",
				poll,
				anchor: 0,
			},
		]);
		expect(s.getSnapshot().poll).toEqual(poll);
	});

	it("openPoll throws while a poll is already open", () => {
		const s = new MirrorState();
		s.openPoll(poll);
		expect(() => s.openPoll(poll)).toThrow(/poll.*open/i);
	});

	it("castVote before any poll throws", () => {
		const s = new MirrorState();
		expect(() => s.castVote("u", "A", "")).toThrow(/no poll/i);
	});

	it("castVote with unknown choice key throws", () => {
		const s = new MirrorState();
		s.openPoll(poll);
		expect(() => s.castVote("u", "Z", "")).toThrow(/unknown/i);
	});

	it("castVote emits no event; voters() exposes who voted", () => {
		const s = new MirrorState();
		s.openPoll(poll);
		const received: unknown[] = [];
		s.subscribe((e) => received.push(e));
		s.castVote("alice", "A", "");
		s.castVote("bob", "B", "");
		s.castVote("alice", "B", ""); // replace, count stays 2
		expect(received).toEqual([]);
		expect(s.voters()).toEqual(["alice", "bob"]);
		s.closePoll();
		expect(s.voters()).toEqual([]);
	});

	it("castVote replaces an earlier vote by the same username", () => {
		const s = new MirrorState();
		s.openPoll(poll);
		s.castVote("u", "A", "first");
		s.castVote("u", "B", "changed my mind");
		const votes = s.reveal()[0] as { votes: { username: string; choice: string; remark: string }[] };
		expect(votes.votes).toEqual([
			{ username: "u", choice: "B", remark: "changed my mind" },
		]);
	});

	it("reveal emits poll_reveal with names and remarks in insertion order", () => {
		const s = new MirrorState();
		s.openPoll(poll);
		s.castVote("alice", "A", "cheap");
		s.castVote("bob", "B", "");
		const events = s.reveal();
		expect(events).toEqual([
			{
				type: "poll_reveal",
				votes: [
					{ username: "alice", choice: "A", remark: "cheap" },
					{ username: "bob", choice: "B", remark: "" },
				],
			},
		]);
		expect(s.getSnapshot().revealed).toEqual([
			{ username: "alice", choice: "A", remark: "cheap" },
			{ username: "bob", choice: "B", remark: "" },
		]);
	});

	it("snapshot includes the current vote count for an open poll", () => {
		const s = new MirrorState();
		s.openPoll(poll);
		expect(s.getSnapshot().voteCount).toBe(0);
		s.castVote("alice", "A", "");
		s.castVote("bob", "B", "");
		s.castVote("alice", "B", ""); // replace, count stays 2
		expect(s.getSnapshot().voteCount).toBe(2);
		s.reveal();
		expect(s.getSnapshot().voteCount).toBe(2); // survives reveal
		s.closePoll();
		expect(s.getSnapshot().voteCount).toBeNull();
	});

	it("resetMessages replaces the transcript without touching poll state and emits transcript_reset", () => {
		const s = new MirrorState();
		s.appendMessage(msg("user", "old branch"));
		s.openPoll(poll);
		s.castVote("alice", "A", "");
		const received: unknown[] = [];
		s.subscribe((e) => received.push(e));
		s.resetMessages([msg("user", "new branch a"), msg("assistant", "new branch b")]);
		expect(s.getSnapshot().messages.map((m) => m.text)).toEqual(["new branch a", "new branch b"]);
		expect(s.getSnapshot().poll).toEqual(poll); // poll untouched
		expect(s.getSnapshot().voteCount).toBe(1);
		expect(received).toEqual([{ type: "transcript_reset", snapshot: s.getSnapshot() }]);
	});

	it("closePoll emits poll_close and clears state; snapshot after reopen has empty poll area", () => {
		const s = new MirrorState();
		s.openPoll(poll);
		s.castVote("u", "A", "");
		s.reveal();
		expect(s.closePoll()).toEqual([{ type: "poll_close" }]);
		expect(s.getSnapshot().poll).toBeNull();
		expect(s.getSnapshot().revealed).toBeNull();
		// reopen works after close
		expect(() => s.openPoll(poll)).not.toThrow();
		expect(s.getSnapshot().poll).toEqual(poll);
	});

	it("castVote after reveal throws a message naming the reveal", () => {
		const s = new MirrorState();
		s.openPoll(poll);
		s.reveal();
		expect(() => s.castVote("u", "A", "")).toThrow(/already been revealed/i);
	});
});

describe("reveal error messages (user report: misleading)", () => {
	it("reveal after reveal says already revealed, not 'no poll'", () => {
		const s = new MirrorState();
		s.openPoll({ question: "Q?", options: [{ key: "A", label: "a" }] });
		s.reveal();
		expect(() => s.reveal()).toThrow(/already been revealed/i);
	});
});
