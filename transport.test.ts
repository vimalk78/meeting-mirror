import { describe, it, expect, afterEach } from "vitest";
import { MirrorState } from "./state.js";
import { Hub } from "./hub.js";
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

async function start(): Promise<{ state: MirrorState; hub: Hub; base: string; key: string }> {
	const state = new MirrorState();
	const hub = new Hub(state);
	server = new LocalServer(hub, { port: 0 });
	await server.start();
	return { state, hub, base: server.url, key: server.key };
}

type SseConn = { events: any[]; ready: Promise<void>; close: () => void };

function sseConnect(base: string, key: string, client: string, extra = ""): SseConn {
	const events: any[] = [];
	const controller = new AbortController();
	const ready = (async () => {
		const res = await fetch(`${base}/events?key=${key}&client=${client}${extra}`, {
			signal: controller.signal,
		});
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
						if (frame.startsWith(":")) continue; // heartbeat
						const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
						if (dataLine) events.push(JSON.parse(dataLine.slice(5).trim()));
					}
				}
			} catch {
				/* aborted */
			}
		})();
		while (events.length === 0) await new Promise((r) => setTimeout(r, 10));
	})();
	return { events, ready, close: () => controller.abort() };
}

async function identify(base: string, key: string, clientId: string, username: string) {
	return fetch(`${base}/identify?key=${key}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ clientId, username }),
	});
}

async function vote(base: string, key: string, clientId: string, choice: string, remark = "") {
	return fetch(`${base}/vote?key=${key}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ clientId, choice, remark }),
	});
}

describe("LocalServer over Hub", () => {
	it("GET / serves the page with a key; /page.css and /page.js too", async () => {
		const { base, key } = await start();
		expect((await fetch(`${base}/?key=${key}`)).status).toBe(200);
		expect((await fetch(`${base}/page.css?key=${key}`)).status).toBe(200);
		expect((await fetch(`${base}/page.js?key=${key}`)).status).toBe(200);
	});

	it("rejects requests without the session key", async () => {
		const { base } = await start();
		expect((await fetch(`${base}/`)).status).toBe(403);
		expect((await fetch(`${base}/?key=wrong`)).status).toBe(403);
		expect(
			(
				await fetch(`${base}/vote`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ clientId: "c", choice: "A" }),
				})
			).status,
		).toBe(403);
		expect((await fetch(`${base}/events`)).status).toBe(403);
	});

	it("sets a per-session cookie on first keyed page load", async () => {
		const { base, key } = await start();
		const res = await fetch(`${base}/?key=${key}`);
		const setCookie = res.headers.get("set-cookie") ?? "";
		expect(setCookie).toMatch(/^mm_key_[0-9a-f-]+=.*Path=\/.*HttpOnly.*SameSite=Strict/);
		const cookie = setCookie.split(";")[0]!;
		expect((await fetch(`${base}/page.css`, { headers: { cookie } })).status).toBe(200);
		const events = await fetch(`${base}/events?client=c1`, { headers: { cookie } });
		expect(events.status).toBe(200);
		await events.body?.cancel();
	});

	it("SSE requires client param; snapshot includes you:null before join, you:Alice after identify", async () => {
		const { base, key } = await start();
		expect((await fetch(`${base}/events?key=${key}`)).status).toBe(400);

		const conn = sseConnect(base, key, "c1");
		await conn.ready;
		expect(conn.events[0]).toMatchObject({ type: "snapshot", you: null });
		conn.close();

		await identify(base, key, "c1", "Alice");
		const conn2 = sseConnect(base, key, "c1");
		await conn2.ready;
		expect(conn2.events[0]).toMatchObject({ type: "snapshot", you: "Alice" });
		conn2.close();
	});

	it("vote flow: identify, poll, vote → members event with tick; reveal → poll_reveal", async () => {
		const { state, base, key } = await start();
		const conn = sseConnect(base, key, "c1");
		await conn.ready;

		const idRes = await identify(base, key, "c1", "Alice");
		expect(idRes.status).toBe(200);

		state.openPoll(poll);
		const voteRes = await vote(base, key, "c1", "A");
		expect(voteRes.status).toBe(200);

		await new Promise((r) => setTimeout(r, 100));
		const membersEvent = [...conn.events].reverse().find((e) => e.type === "members");
		expect(membersEvent).toMatchObject({
			type: "members",
			members: [{ name: "Alice", voted: true }],
			voteCount: 1,
		});

		state.reveal();
		await new Promise((r) => setTimeout(r, 100));
		const revealEvent = [...conn.events].reverse().find((e) => e.type === "poll_reveal");
		expect(revealEvent.votes).toEqual([{ username: "Alice", choice: "A", remark: "" }]);
		conn.close();
	});

	it("name conflict over HTTP → 409 with the conflict message", async () => {
		const { base, key } = await start();
		sseConnect(base, key, "c1");
		await identify(base, key, "c1", "John");
		const res = await identify(base, key, "c2", "John");
		expect(res.status).toBe(409);
		const body = await res.json();
		expect(body.error).toBe(
			"John is already in the room. Choose another name, for example John K.",
		);
	});

	it("vote without joining → 401 join first", async () => {
		const { state, base, key } = await start();
		state.openPoll(poll);
		const res = await vote(base, key, "c9", "A");
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: "join first" });
	});

	it("closing the SSE connection removes presence (members event)", async () => {
		const { base, key, hub } = await start();
		await identify(base, key, "c1", "Alice");
		const conn = sseConnect(base, key, "c1");
		await conn.ready;
		expect(hub.memberList().members).toEqual([{ name: "Alice", voted: false }]);
		conn.close();
		await new Promise((r) => setTimeout(r, 100));
		expect(hub.memberList().members).toEqual([]);
	});

	it("SSE heartbeat comment is sent periodically", async () => {
		const state = new MirrorState();
		const hub = new Hub(state);
		server = new LocalServer(hub, { port: 0, heartbeatMs: 50 });
		await server.start();
		const res = await fetch(`${server.url}/events?key=${server.key}&client=c1`);
		const reader = res.body!.getReader();
		const { value } = await reader.read();
		// first frame is the snapshot; wait past one heartbeat interval
		await new Promise((r) => setTimeout(r, 150));
		const { value: second } = await reader.read();
		const text = new TextDecoder().decode(second ?? value);
		await reader.cancel();
		expect(text).toContain(": ping");
	});

	it("binds a non-loopback address by default", async () => {
		const { base, key } = await start();
		const { networkInterfaces } = await import("node:os");
		const lanIp = Object.values(networkInterfaces())
			.flat()
			.find((n) => n && n.family === "IPv4" && !n.internal)?.address;
		if (!lanIp) return;
		const port = new URL(base).port;
		expect((await fetch(`http://${lanIp}:${port}/?key=${key}`)).status).toBe(200);
	});

	it("stop() closes the server", async () => {
		const { base } = await start();
		const s = server!;
		await s.stop();
		await expect(fetch(`${base}/`)).rejects.toThrow();
	});
});
