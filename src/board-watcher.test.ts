import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "./hub.js";
import { MirrorState } from "./state.js";
import type { HubEvent } from "./hub.js";
import { BoardWatcher } from "./board-watcher.js";

let tmp: string;
let events: HubEvent[];
let hub: Hub;
let watcher: BoardWatcher | null = null;

const TPL = "<body><!-- BRANDING --><!-- CONTENT --></body>";

function makeSession(id = "s1"): { state: string; content: string } {
	const dir = join(tmp, ".superpowers", "brainstorm", id);
	mkdirSync(join(dir, "state"), { recursive: true });
	mkdirSync(join(dir, "content"), { recursive: true });
	writeFileSync(join(dir, "state", "server-info"), "{}\n");
	writeFileSync(join(dir, "state", "server.pid"), "42\n");
	return { state: join(dir, "state"), content: join(dir, "content") };
}

function writeScreen(content: string, name: string, html: string, mtime?: number): void {
	writeFileSync(join(content, name), html);
	if (mtime !== undefined) utimesSync(join(content, name), mtime / 1000, mtime / 1000);
}

function newWatcher(): BoardWatcher {
	watcher = new BoardWatcher(hub, tmp, {
		intervalMs: 60_000, // never fires during a test; poll() is called directly
		isAlive: () => true,
		loadTemplate: () => TPL,
	});
	watcher.start();
	return watcher;
}

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "mm-watch-"));
	events = [];
	hub = new Hub(new MirrorState());
	hub.subscribe((e) => events.push(e));
});

afterEach(() => {
	watcher?.stop();
	watcher = null;
	rmSync(tmp, { recursive: true, force: true });
});

describe("BoardWatcher", () => {
	it("no session → first poll publishes board null, then silence", () => {
		const w = newWatcher();
		w.poll();
		expect(events).toEqual([{ type: "board", screen: null }]);
		expect(hub.board).toBeNull();
		w.poll();
		w.poll();
		expect(events.length).toBe(1); // no repeated null events
	});

	it("new screen → one board event with rendered html", () => {
		const { content } = makeSession();
		writeScreen(content, "a.html", "<p>A</p>");
		newWatcher().poll();
		expect(events).toEqual([
			{ type: "board", screen: { name: "a.html", html: expect.stringContaining("<p>A</p>") } },
		]);
		expect(events[0]).toHaveProperty("type", "board");
	});

	it("unchanged screen → no second event; rewritten (new mtime) → event", () => {
		const { content } = makeSession();
		writeScreen(content, "a.html", "<p>A</p>", 1000);
		const w = newWatcher();
		w.poll();
		expect(events.length).toBe(1);
		w.poll();
		expect(events.length).toBe(1); // unchanged
		writeScreen(content, "a.html", "<p>A2</p>", 2000);
		w.poll();
		expect(events.length).toBe(2);
		expect(events[1]).toMatchObject({ type: "board", screen: { name: "a.html" } });
	});

	it("session stops → board null event", () => {
		const { state, content } = makeSession();
		writeScreen(content, "a.html", "<p>A</p>", 1000);
		const w = newWatcher();
		w.poll();
		expect(events.length).toBe(1);
		writeFileSync(join(state, "server-stopped"), "{}\n");
		w.poll();
		expect(events[1]).toEqual({ type: "board", screen: null });
		expect(hub.board).toBeNull();
	});

	it("template loaded once per session", () => {
		const { content } = makeSession();
		writeScreen(content, "a.html", "<p>A</p>", 1000);
		let calls = 0;
		watcher = new BoardWatcher(hub, tmp, {
			intervalMs: 60_000,
			isAlive: () => true,
			loadTemplate: () => {
				calls++;
				return TPL;
			},
		});
		watcher.start();
		watcher.poll();
		writeScreen(content, "b.html", "<p>B</p>", 2000);
		watcher.poll();
		writeScreen(content, "b.html", "<p>B2</p>", 3000);
		watcher.poll();
		expect(calls).toBe(1);
	});

	it("errors never escape poll()", () => {
		const { content } = makeSession();
		writeScreen(content, "a.html", "<p>A</p>", 1000);
		watcher = new BoardWatcher(hub, tmp, {
			intervalMs: 60_000,
			isAlive: () => true,
			loadTemplate: () => {
				throw new Error("boom");
			},
		});
		watcher.start();
		expect(() => watcher!.poll()).not.toThrow();
		// dir removed between polls
		rmSync(join(tmp, ".superpowers"), { recursive: true, force: true });
		expect(() => watcher!.poll()).not.toThrow();
	});
});

describe("BoardWatcher transient read errors", () => {
	it("a screen that fails to read is retried on the next poll", async () => {
		if (process.getuid?.() === 0) return; // chmod 000 does not block root
		const { content } = makeSession();
		writeScreen(content, "a.html", "<p>A</p>", 1000);
		const w = newWatcher();
		w.poll();
		expect(events.length).toBe(1);
		// same screen rewritten unreadable: render fails, poll must not throw
		writeScreen(content, "a.html", "<p>A2</p>", 2000);
		chmodSync(join(content, "a.html"), 0o000);
		expect(() => w.poll()).not.toThrow();
		expect(events.length).toBe(1); // not published yet
		// readable again, same mtime: the next poll must pick it up
		chmodSync(join(content, "a.html"), 0o644);
		w.poll();
		expect(events.length).toBe(2);
		expect(events[1]).toMatchObject({ type: "board", screen: { name: "a.html" } });
	});
});

describe("BoardWatcher fresh start", () => {
	it("a new watcher clears a board left by a previous share when no companion runs", () => {
		hub.setBoard({ name: "old.html", html: "<p>old</p>" }); // left by the previous share
		newWatcher().poll();
		expect(hub.board).toBeNull();
		expect(events).toContainEqual({ type: "board", screen: null });
	});
});
