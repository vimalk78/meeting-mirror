import { afterAll, afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createRelay, type RelayHandle } from "./server.js";

const PAGE_DIR = new URL("../../page/", import.meta.url).pathname;

let relay: RelayHandle | null = null;
const handles: RelayHandle[] = [];
afterEach(async () => {
	for (const h of handles.splice(0)) await h.close();
	relay = null;
});
afterAll(async () => {
	for (const h of handles.splice(0)) await h.close();
});

async function startRelay(opts: Partial<Parameters<typeof createRelay>[0]> = {}): Promise<{ handle: RelayHandle; base: string; wsUrl: string }> {
	const handle = createRelay({ pageDir: PAGE_DIR, ...opts });
	handles.push(handle);
	await new Promise<void>((resolve) => handle.server.listen(0, "127.0.0.1", resolve));
	const port = (handle.server.address() as { port: number }).port;
	const base = `http://127.0.0.1:${port}`;
	return { handle, base, wsUrl: `ws://127.0.0.1:${port}/presenter` };
}

type Moderator = {
	ws: WebSocket;
	next: () => Promise<any>; // next message from relay
};

function connectModerator(wsUrl: string, autoPong = true): Promise<Moderator> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(wsUrl, { autoPong });
		const queue: any[] = [];
		const waiters: ((msg: any) => void)[] = [];
		ws.on("message", (data) => {
			const msg = JSON.parse(String(data));
			const waiter = waiters.shift();
			if (waiter) waiter(msg);
			else queue.push(msg);
		});
		ws.on("open", () =>
			resolve({
				ws,
				next: () =>
					new Promise((resolve2) => {
						const queued = queue.shift();
						if (queued) resolve2(queued);
						else waiters.push(resolve2);
					}),
			}),
		);
		ws.on("error", reject);
		ws.on("close", () => {
			for (const w of waiters.splice(0)) w({ t: "__closed__" });
		});
	});
}

const send = (ws: WebSocket, obj: unknown) => ws.send(JSON.stringify(obj));

/** Browser SSE connection to a room. */
function browserSse(base: string, name: string, key: string, client: string): {
	events: any[];
	ready: Promise<void>;
	close: () => void;
} {
	const events: any[] = [];
	const controller = new AbortController();
	const ready = (async () => {
		const res = await fetch(`${base}/s/${name}/events?key=${key}&client=${client}`, {
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
						if (frame.startsWith(":")) continue;
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
	ready.catch(() => {
		/* aborted before the first frame: not a test failure */
	});
	return { events, ready, close: () => controller.abort() };
}

describe("relay HTTP", () => {
	it("/healthz → ok; page served without key; bad name → 404", async () => {
		const { base } = await startRelay();
		expect(await (await fetch(`${base}/healthz`)).text()).toBe("ok");
		expect((await fetch(`${base}/s/ols-4596`)).status).toBe(200);
		expect((await fetch(`${base}/s/BAD_NAME`)).status).toBe(404);
		expect((await fetch(`${base}/page.css`)).status).toBe(200);
	});
});

describe("relay presenter protocol", () => {
	it("hello on a free room → welcome; different key → busy; same key → replaced", async () => {
		const { wsUrl } = await startRelay();
		const a = await connectModerator(wsUrl);
		send(a.ws, { t: "hello", room: "ols-4596", key: "k1" });
		expect(await a.next()).toEqual({ t: "welcome" });

		const b = await connectModerator(wsUrl);
		send(b.ws, { t: "hello", room: "ols-4596", key: "k2" });
		expect(await b.next()).toEqual({ t: "busy" });

		const c = await connectModerator(wsUrl);
		send(c.ws, { t: "hello", room: "ols-4596", key: "k1" });
		expect(await c.next()).toEqual({ t: "welcome" });
		expect(await a.next()).toEqual({ t: "replaced" });
		a.ws.close();
		b.ws.close();
		c.ws.close();
	});

	it("browser events: open forwarded, send reaches one browser, broadcast reaches all, close forwarded", async () => {
		const { base, wsUrl } = await startRelay();
		const mod = await connectModerator(wsUrl);
		send(mod.ws, { t: "hello", room: "ols-4596", key: "k1" });
		await mod.next(); // welcome

		const browser1 = browserSse(base, "ols-4596", "k1", "client-1");
		const openMsg = await mod.next();
		expect(openMsg).toMatchObject({ t: "open", client: "client-1" });
		const conn1 = openMsg.conn;

		const browser2 = browserSse(base, "ols-4596", "k1", "client-2");
		const openMsg2 = await mod.next();
		expect(openMsg2).toMatchObject({ t: "open", client: "client-2" });
		const conn2 = openMsg2.conn;

		send(mod.ws, { t: "send", conn: conn1, event: { type: "snapshot", you: null } });
		await new Promise((r) => setTimeout(r, 100));
		expect(browser1.events.length).toBe(1);
		expect(browser2.events.length).toBe(0);

		send(mod.ws, { t: "broadcast", event: { type: "members", members: [] } });
		await new Promise((r) => setTimeout(r, 100));
		expect(browser1.events.length).toBe(2);
		expect(browser2.events.length).toBe(1);

		browser1.close();
		const closeMsg = await mod.next();
		expect(closeMsg).toMatchObject({ t: "close", conn: conn1 });
		browser2.close();
		mod.ws.close();
	});

	it("wrong key → 403; identify request/reply round-trip; timeout → 504", async () => {
		const { base, wsUrl } = await startRelay({ requestTimeoutMs: 50 });
		const mod = await connectModerator(wsUrl);
		send(mod.ws, { t: "hello", room: "ols-4596", key: "k1" });
		await mod.next();

		expect(
			(await fetch(`${base}/s/ols-4596/identify?key=wrong`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status,
		).toBe(403);

		const browser = browserSse(base, "ols-4596", "k1", "client-1");
		await mod.next(); // open

		const replyPromise = fetch(`${base}/s/ols-4596/identify?key=k1`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ clientId: "client-1", username: "Ann" }),
		});
		const reqMsg = await mod.next();
		expect(reqMsg).toMatchObject({ t: "request", kind: "identify", body: { username: "Ann" } });
		send(mod.ws, { t: "reply", req: reqMsg.req, status: 200, body: { name: "Ann" } });
		const reply = await replyPromise;
		expect(reply.status).toBe(200);
		expect(await reply.json()).toEqual({ name: "Ann" });

		// no reply → 504
		const timeoutPromise = fetch(`${base}/s/ols-4596/identify?key=k1`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ clientId: "client-1", username: "Bob" }),
		});
		const reqMsg2 = await mod.next();
		void reqMsg2;
		const timeoutReply = await timeoutPromise;
		expect(timeoutReply.status).toBe(504);

		browser.close();
		mod.ws.close();
	});

	it("POST with no moderator → 503; wrong content type → 415; big body → 413", async () => {
		const { base, wsUrl } = await startRelay();
		const noMod = await fetch(`${base}/s/ols-4596/vote?key=k1`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
		expect(noMod.status).toBe(503);

		const mod = await connectModerator(wsUrl);
		send(mod.ws, { t: "hello", room: "ols-4596", key: "k1" });
		await mod.next();
		const badType = await fetch(`${base}/s/ols-4596/vote?key=k1`, {
			method: "POST",
			headers: { "content-type": "text/plain" },
			body: "x",
		});
		expect(badType.status).toBe(415);
		const big = await fetch(`${base}/s/ols-4596/vote?key=k1`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ padding: "a".repeat(70000) }),
		});
		expect(big.status).toBe(413);
		mod.ws.close();
	});

	it("no moderator: SSE gets waiting and stays open; attach forwards open; wrong key gets invalid_key and closes", async () => {
		const { base, wsUrl } = await startRelay();
		const browser = browserSse(base, "ols-4596", "k1", "client-1");
		await browser.ready;
		expect(browser.events[0]).toEqual({ type: "waiting" });

		const badBrowser = browserSse(base, "ols-4596", "k2", "client-2");
		// Wrong key while parked can't be validated without a moderator;
		// invalid_key arrives when one attaches (checked below via adoption).
		await badBrowser.ready; // ensure it is parked before the moderator arrives

		const mod = await connectModerator(wsUrl);
		send(mod.ws, { t: "hello", room: "ols-4596", key: "k1" });
		await mod.next(); // welcome
		// parked right-key browser's open is forwarded to the new moderator
		const openMsg = await mod.next();
		expect(openMsg).toMatchObject({ t: "open", client: "client-1" });
		// the parked wrong-key browser got invalid_key and its stream ended
		await new Promise((r) => setTimeout(r, 100));
		expect(badBrowser.events[badBrowser.events.length - 1]).toEqual({ type: "invalid_key" });
		browser.close();
		mod.ws.close();
	});

	it("moderator disconnects → browsers get waiting; room freed at once", async () => {
		const { base, wsUrl } = await startRelay();
		const mod = await connectModerator(wsUrl);
		send(mod.ws, { t: "hello", room: "ols-4596", key: "k1" });
		await mod.next();
		const browser = browserSse(base, "ols-4596", "k1", "client-1");
		await mod.next(); // open

		mod.ws.terminate();
		await new Promise((r) => setTimeout(r, 100));
		const last = browser.events[browser.events.length - 1];
		expect(last).toEqual({ type: "waiting" });

		// room is free: another key gets welcome
		const mod2 = await connectModerator(wsUrl);
		send(mod2.ws, { t: "hello", room: "ols-4596", key: "k2" });
		expect(await mod2.next()).toEqual({ t: "welcome" });
		browser.close();
		mod2.ws.close();
	});

	it("connection caps: maxConnsPerRoom → 503", async () => {
		const { base, wsUrl } = await startRelay({ maxConnsPerRoom: 2 });
		const mod = await connectModerator(wsUrl);
		send(mod.ws, { t: "hello", room: "ols-4596", key: "k1" });
		await mod.next();
		const b1 = browserSse(base, "ols-4596", "k1", "c1");
		await mod.next();
		const b2 = browserSse(base, "ols-4596", "k1", "c2");
		await mod.next();
		const res = await fetch(`${base}/s/ols-4596/events?key=k1&client=c3`);
		expect(res.status).toBe(503);
		await res.body?.cancel();
		b1.close();
		b2.close();
		mod.ws.close();
	});

	it("heartbeats: SSE ping comments; silent moderator dropped after timeout, browsers get waiting", async () => {
		const { base, wsUrl, handle } = await startRelay({ heartbeatMs: 50, pingMs: 30 });
		const mod = await connectModerator(wsUrl, /* autoPong */ false);
		send(mod.ws, { t: "hello", room: "ols-4596", key: "k1" });
		await mod.next();
		const browser = browserSse(base, "ols-4596", "k1", "c1");
		await mod.next(); // open

		// SSE heartbeat raw check
		const raw = await fetch(`${base}/s/ols-4596/events?key=k1&client=c9`);
		const reader = raw.body!.getReader();
		const decoder = new TextDecoder();
		let sawPing = false;
		const deadline = Date.now() + 500;
		while (Date.now() < deadline && !sawPing) {
			const { done, value } = await reader.read();
			if (done) break;
			if (decoder.decode(value).includes(": ping")) sawPing = true;
		}
		await reader.cancel();
		expect(sawPing).toBe(true);

		// moderator never pongs: dropped after ~150ms
		await new Promise((r) => setTimeout(r, 300));
		const last = browser.events[browser.events.length - 1];
		expect(last).toEqual({ type: "waiting" });
		expect(handle.roomCount()).toBeLessThanOrEqual(1);
		browser.close();
	});

	it("empty rooms are removed (roomCount)", async () => {
		const { wsUrl, handle } = await startRelay();
		const mod = await connectModerator(wsUrl);
		send(mod.ws, { t: "hello", room: "ols-4596", key: "k1" });
		await mod.next();
		expect(handle.roomCount()).toBe(1);
		mod.ws.close();
		await new Promise((r) => setTimeout(r, 100));
		expect(handle.roomCount()).toBe(0);
	});
});

describe("adopted browser lifecycle (review fix 6)", () => {
	it("reports close to the moderator for a browser that was parked then adopted", async () => {
		const relay = createRelay({ pageDir: "page", pingMs: 1000 });
		await new Promise<void>((r) => relay.server.listen(0, "127.0.0.1", r));
		const port = (relay.server.address() as any).port;
		// browser parks before any moderator exists
		const ctl = new AbortController();
		const res = await fetch(`http://127.0.0.1:${port}/s/ols-x/events?key=k&client=c1`, { signal: ctl.signal });
		const reader = res.body!.getReader();
		await reader.read(); // waiting frame
		// moderator arrives with the matching key → browser is adopted
		const ws = new WebSocket(`ws://127.0.0.1:${port}/presenter`);
		const got: any[] = [];
		ws.on("message", (d) => got.push(JSON.parse(String(d))));
		await new Promise((r) => (ws.on("open", r)));
		ws.send(JSON.stringify({ t: "hello", room: "ols-x", key: "k" }));
		await new Promise((r) => setTimeout(r, 100));
		expect(got.filter((m) => m.t === "open").length).toBe(1);
		// browser closes → moderator must be told
		ctl.abort();
		res.body!.cancel().catch(() => {});
		await new Promise((r) => setTimeout(r, 200));
		expect(got.filter((m) => m.t === "close").length).toBe(1);
		ws.close();
		await relay.close();
	});
});

describe("relay logging (user report: no logs)", () => {
	it("logs moderator and browser lifecycle events", async () => {
		const logs: string[] = [];
		const relay = createRelay({ pageDir: "page", pingMs: 1000, onLog: (m) => logs.push(m) });
		await new Promise<void>((r) => relay.server.listen(0, "127.0.0.1", r));
		const port = (relay.server.address() as any).port;
		const ws = new WebSocket(`ws://127.0.0.1:${port}/presenter`);
		await new Promise((r) => (ws.on("open", r)));
		ws.send(JSON.stringify({ t: "hello", room: "ols-log", key: "k" }));
		await new Promise((r) => setTimeout(r, 50));
		const ctl = new AbortController();
		const res = await fetch(`http://127.0.0.1:${port}/s/ols-log/events?key=k&client=c1`, { signal: ctl.signal });
		await new Promise((r) => setTimeout(r, 100)); // headers arrived = browser connected
		ctl.abort();
		res.body!.cancel().catch(() => {});
		ws.close();
		await new Promise((r) => setTimeout(r, 150));
		expect(logs).toContain("moderator attached to ols-log");
		expect(logs).toContain("browser connected to ols-log");
		expect(logs).toContain("browser disconnected from ols-log");
		expect(logs).toContain("moderator detached from ols-log");
		await relay.close();
	});
});
