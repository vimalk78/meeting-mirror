import { describe, it, expect, afterEach } from "vitest";
import { MirrorState } from "./state.js";
import { LocalServer } from "./transport.js";

const poll = {
	question: "Which?",
	options: [
		{ key: "A", label: "First" },
		{ key: "B", label: "Second" },
	],
};

let server: LocalServer | null = null;
afterEach(async () => {
	await server?.stop();
	server = null;
});

async function start(): Promise<{ state: MirrorState; base: string }> {
	const state = new MirrorState();
	server = new LocalServer(state, { port: 0 });
	await server.start();
	return { state, base: server.url };
}

/** Open an SSE connection; returns a queue of parsed events and a close fn. */
function sseConnect(base: string): { events: any[]; ready: Promise<void>; close: () => void } {
	const events: any[] = [];
	const controller = new AbortController();
	const ready = (async () => {
		const res = await fetch(`${base}/events`, { signal: controller.signal });
		const reader = res.body!.getReader();
		const decoder = new TextDecoder();
		let buf = "";
		(async () => {
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					buf += decoder.decode(value, { stream: true });
					let idx;
					while ((idx = buf.indexOf("\n\n")) !== -1) {
						const frame = buf.slice(0, idx);
						buf = buf.slice(idx + 2);
						const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
						if (dataLine) events.push(JSON.parse(dataLine.slice(5).trim()));
					}
				}
			} catch {
				/* aborted */
			}
		})();
		// wait for first event (the snapshot)
		while (events.length === 0) await new Promise((r) => setTimeout(r, 10));
	})();
	return { events, ready, close: () => controller.abort() };
}

describe("LocalServer", () => {
	it("GET / returns 200 with HTML", async () => {
		const { base } = await start();
		const res = await fetch(`${base}/`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		const body = await res.text();
		expect(body).toContain("<!DOCTYPE html>");
	});

	it("GET /page.css and /page.js serve their files", async () => {
		const { base } = await start();
		expect((await fetch(`${base}/page.css`)).status).toBe(200);
		expect((await fetch(`${base}/page.js`)).status).toBe(200);
	});

	it("SSE connection receives snapshot with prior messages", async () => {
		const { state, base } = await start();
		state.appendMessage({ role: "user", text: "prior", timestamp: 1 });
		const conn = sseConnect(base);
		await conn.ready;
		expect(conn.events[0]).toEqual({
			type: "snapshot",
			snapshot: { messages: [{ role: "user", text: "prior", timestamp: 1 }], poll: null, revealed: null },
		});
		conn.close();
	});

	it("appendMessage after connect → SSE receives transcript_delta", async () => {
		const { state, base } = await start();
		const conn = sseConnect(base);
		await conn.ready;
		state.appendMessage({ role: "assistant", text: "live", timestamp: 2 });
		await new Promise((r) => setTimeout(r, 100));
		const last = conn.events[conn.events.length - 1];
		expect(last).toEqual({
			type: "transcript_delta",
			message: { role: "assistant", text: "live", timestamp: 2 },
		});
		conn.close();
	});

	it("poll flow: open, vote, reveal → SSE receives poll_reveal with username", async () => {
		const { state, base } = await start();
		const conn = sseConnect(base);
		await conn.ready;
		state.openPoll(poll);

		const voteRes = await fetch(`${base}/vote`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ username: "alice", choice: "A", remark: "hi" }),
		});
		expect(voteRes.status).toBe(200);

		state.reveal();
		await new Promise((r) => setTimeout(r, 100));
		const last = conn.events[conn.events.length - 1];
		expect(last.type).toBe("poll_reveal");
		expect(last.votes).toEqual([{ username: "alice", choice: "A", remark: "hi" }]);
		conn.close();
	});

	it("vote with no poll open → 409", async () => {
		const { base } = await start();
		const res = await fetch(`${base}/vote`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ username: "x", choice: "A", remark: "" }),
		});
		expect(res.status).toBe(409);
	});

	it("vote with unknown choice → 409", async () => {
		const { state, base } = await start();
		state.openPoll(poll);
		const res = await fetch(`${base}/vote`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ username: "x", choice: "Z", remark: "" }),
		});
		expect(res.status).toBe(409);
	});

	it("POST /identify with non-empty username → 204; empty → 400", async () => {
		const { base } = await start();
		const ok = await fetch(`${base}/identify`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ username: "bob" }),
		});
		expect(ok.status).toBe(204);
		const bad = await fetch(`${base}/identify`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ username: "  " }),
		});
		expect(bad.status).toBe(400);
	});

	it("binds a non-loopback address by default so teammates can reach it", async () => {
		const { base } = await start();
		// base uses the display host; verify reachability on a real local IP
		const { networkInterfaces } = await import("node:os");
		const nets = networkInterfaces();
		const lanIp = Object.values(nets)
			.flat()
			.find((n) => n && n.family === "IPv4" && !n.internal)?.address;
		if (!lanIp) return; // no network besides loopback in this environment
		const port = new URL(base).port;
		const res = await fetch(`http://${lanIp}:${port}/`);
		expect(res.status).toBe(200);
	});

	it("stop() closes the server", async () => {
		const { base } = await start();
		const s = server!;
		await s.stop();
		await expect(fetch(`${base}/`)).rejects.toThrow();
	});
});
