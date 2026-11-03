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

	it("SSE connection receives snapshot with a sessionId", async () => {
		const { state, base } = await start();
		state.appendMessage({ role: "user", text: "prior", timestamp: 1 });
		const conn = sseConnect(base);
		await conn.ready;
		expect(conn.events[0]).toMatchObject({
			type: "snapshot",
			sessionId: expect.any(String),
			snapshot: { messages: [{ role: "user", text: "prior", timestamp: 1 }], poll: null, revealed: null, voteCount: null },
		});
		conn.close();
	});

	it("a restarted server reports a different sessionId", async () => {
		const { state, base } = await start();
		const conn1 = sseConnect(base);
		await conn1.ready;
		const id1 = conn1.events[0].sessionId;
		conn1.close();
		await server!.stop();
		const server2 = new LocalServer(state, { port: 0 });
		server = server2;
		await server2.start();
		const conn2 = sseConnect(server2.url);
		await conn2.ready;
		expect(conn2.events[0].sessionId).not.toBe(id1);
		conn2.close();
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

		const idRes = await fetch(`${base}/identify`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ username: "alice" }),
		});
		const { token } = await idRes.json();
		const voteRes = await fetch(`${base}/vote`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ token, username: "alice", choice: "A", remark: "hi" }),
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
		const idRes = await fetch(`${base}/identify`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ username: "x" }),
		});
		const { token } = await idRes.json();
		const res = await fetch(`${base}/vote`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ token, username: "x", choice: "A", remark: "" }),
		});
		expect(res.status).toBe(409);
	});

	it("vote with unknown choice → 409", async () => {
		const { state, base } = await start();
		state.openPoll(poll);
		const idRes = await fetch(`${base}/identify`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ username: "x" }),
		});
		const { token } = await idRes.json();
		const res = await fetch(`${base}/vote`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ token, username: "x", choice: "Z", remark: "" }),
		});
		expect(res.status).toBe(409);
	});

	it("POST /identify with empty username → 400", async () => {
		const { base } = await start();
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

	it("rejects vote without a Content-Type of application/json (CSRF guard)", async () => {
		const { state, base } = await start();
		state.openPoll(poll);
		const res = await fetch(`${base}/vote`, {
			method: "POST",
			headers: { "content-type": "text/plain" },
			body: JSON.stringify({ token: "t", username: "x", choice: "A", remark: "" }),
		});
		expect(res.status).toBe(415);
	});

	it("identify returns a token; voting requires a matching token and username", async () => {
		const { state, base } = await start();
		state.openPoll(poll);
		const idRes = await fetch(`${base}/identify`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ username: "alice" }),
		});
		const { token } = await idRes.json();
		expect(typeof token).toBe("string");
		expect(token.length).toBeGreaterThan(10);

		// vote without token → 401
		const noToken = await fetch(`${base}/vote`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ username: "alice", choice: "A", remark: "" }),
		});
		expect(noToken.status).toBe(401);

		// vote with token but wrong username → 403
		const wrongUser = await fetch(`${base}/vote`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ token, username: "bob", choice: "A", remark: "" }),
		});
		expect(wrongUser.status).toBe(403);

		// vote with matching token → 200
		const ok = await fetch(`${base}/vote`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ token, username: "alice", choice: "A", remark: "" }),
		});
		expect(ok.status).toBe(200);

		// re-identify with the same username → a second valid token
		// (multiple tabs of one user each hold their own token)
		const reIdentify = await fetch(`${base}/identify`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ username: "alice" }),
		});
		expect(reIdentify.status).toBe(200);
		const { token: token2 } = await reIdentify.json();
		expect(token2).not.toBe(token);
		// both tokens work
		const vote1 = await fetch(`${base}/vote`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ token, username: "alice", choice: "B", remark: "" }),
		});
		expect(vote1.status).toBe(200);
		const vote2 = await fetch(`${base}/vote`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ token: token2, username: "alice", choice: "A", remark: "" }),
		});
		expect(vote2.status).toBe(200);
	});

	it("rejects request bodies over 64 KiB with 413", async () => {
		const { base } = await start();
		const res = await fetch(`${base}/identify`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ username: "x", padding: "a".repeat(70000) }),
		});
		expect(res.status).toBe(413);
	});

	it("caps remark length server-side", async () => {
		const { state, base } = await start();
		state.openPoll(poll);
		const idRes = await fetch(`${base}/identify`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ username: "alice" }),
		});
		const { token } = await idRes.json();
		const res = await fetch(`${base}/vote`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ token, username: "alice", choice: "A", remark: "r".repeat(600) }),
		});
		expect(res.status).toBe(200);
		const events = state.reveal()[0] as { votes: { remark: string }[] };
		expect(events.votes[0]!.remark.length).toBe(500);
	});

	it("accepts a vote whose username has stray whitespace", async () => {
		const { state, base } = await start();
		state.openPoll(poll);
		const idRes = await fetch(`${base}/identify`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ username: "alice" }),
		});
		const { token } = await idRes.json();
		const res = await fetch(`${base}/vote`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ token, username: " alice ", choice: "A", remark: "" }),
		});
		expect(res.status).toBe(200);
	});

	it("stop() closes the server", async () => {
		const { base } = await start();
		const s = server!;
		await s.stop();
		await expect(fetch(`${base}/`)).rejects.toThrow();
	});
});

describe("LocalServer identify cap", () => {
	it("rejects identifies beyond 100 tokens", async () => {
		const { base } = await start();
		let lastStatus = 200;
		for (let i = 0; i < 502; i++) {
			const res = await fetch(`${base}/identify`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ username: `user-${i}` }),
			});
			lastStatus = res.status;
		}
		expect(lastStatus).toBe(503);
	});
});
