import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { MirrorState } from "./state.js";
import { Hub } from "./hub.js";
import { RelayClient, RoomBusyError } from "./relay-client.js";
import { createRelay, type RelayHandle } from "../relay/src/server.js";
import type { Room } from "./rooms.js";

const PAGE_DIR = new URL(".", import.meta.url).pathname;

let relayHandle: RelayHandle | null = null;
let client: RelayClient | null = null;
const closers: Array<() => void> = [];

afterEach(async () => {
	for (const close of closers.splice(0)) close();
	await client?.stop();
	client = null;
	if (relayHandle) {
		await relayHandle.close();
		relayHandle = null;
	}
});

async function startRelay(port?: number): Promise<string> {
	relayHandle = createRelay({ pageDir: PAGE_DIR });
	await new Promise<void>((resolve) => relayHandle!.server.listen(port ?? 0, "127.0.0.1", resolve));
	const actualPort = (relayHandle.server.address() as { port: number }).port;
	return `http://127.0.0.1:${actualPort}`;
}

const room = (base: string): Room => ({ relay: base, name: "ols-test", key: "k1" });

function browserSse(base: string, key: string, clientId: string): {
	events: any[];
	ready: Promise<void>;
	close: () => void;
} {
	const events: any[] = [];
	const controller = new AbortController();
	closers.push(() => controller.abort());
	const ready = (async () => {
		const res = await fetch(`${base}/s/ols-test/events?key=${key}&client=${clientId}`, {
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
	return { events, ready, close: () => controller.abort() };
}

function setup(base: string): { state: MirrorState; hub: Hub } {
	const state = new MirrorState();
	const hub = new Hub(state);
	return { state, hub };
}

describe("RelayClient", () => {
	it("start resolves, pageUrl is the room link, browsers get a snapshot", async () => {
		const base = await startRelay();
		const { hub } = setup(base);
		client = new RelayClient(hub, room(base), { backoffMs: [20] });
		await client.start();
		expect(client.pageUrl).toBe(`${base}/s/ols-test?key=k1`);
		const browser = browserSse(base, "k1", "c1");
		await browser.ready;
		expect(browser.events[0]).toMatchObject({ type: "snapshot", you: null });
	});

	it("identify and vote over HTTP reach the hub; transcript reaches the browser", async () => {
		const base = await startRelay();
		const { state, hub } = setup(base);
		client = new RelayClient(hub, room(base), { backoffMs: [20] });
		await client.start();
		const browser = browserSse(base, "k1", "c1");
		await browser.ready;

		const idRes = await fetch(`${base}/s/ols-test/identify?key=k1`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ clientId: "c1", username: "Alice" }),
		});
		expect(idRes.status).toBe(200);

		state.openPoll({
			question: "Q?",
			options: [
				{ key: "A", label: "a" },
				{ key: "B", label: "b" },
			],
		});
		const voteRes = await fetch(`${base}/s/ols-test/vote?key=k1`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ clientId: "c1", choice: "A" }),
		});
		expect(voteRes.status).toBe(200);
		expect(hub.memberList()).toMatchObject({
			members: [{ name: "Alice", voted: true }],
			voteCount: 1,
		});

		state.appendMessage({ role: "assistant", text: "hello team", timestamp: 1 });
		await new Promise((r) => setTimeout(r, 100));
		expect(browser.events.some((e) => e.type === "transcript_delta")).toBe(true);
	});

	it("second client with a different key → RoomBusyError", async () => {
		const base = await startRelay();
		const { hub } = setup(base);
		client = new RelayClient(hub, room(base), { backoffMs: [20] });
		await client.start();

		const other = new RelayClient(new Hub(new MirrorState()), { relay: base, name: "ols-test", key: "k2" }, { backoffMs: [20] });
		closers.push(() => other.stop());
		await expect(other.start()).rejects.toBeInstanceOf(RoomBusyError);
	});

	it("same key: first client is replaced, gets onLost('replaced'), stops reconnecting", async () => {
		const base = await startRelay();
		const { hub } = setup(base);
		let lost: string | null = null;
		client = new RelayClient(hub, room(base), { backoffMs: [20], onLost: (reason) => (lost = reason) });
		await client.start();

		const takeover = new RelayClient(new Hub(new MirrorState()), room(base), { backoffMs: [20] });
		closers.push(() => takeover.stop());
		await takeover.start();

		await new Promise((r) => setTimeout(r, 200));
		expect(lost).toBe("replaced");
	});

	it("relay restart: client reconnects, browsers get the same sessionId", async () => {
		const base = await startRelay();
		const { hub } = setup(base);
		client = new RelayClient(hub, room(base), { backoffMs: [20], reconnectBackoffMs: [20] });
		await client.start();
		const browser = browserSse(base, "k1", "c1");
		await browser.ready;
		const sessionId = browser.events[0].sessionId;
		expect(typeof sessionId).toBe("string");

		// restart the relay on the same port
		const port = Number(new URL(base).port);
		await relayHandle!.close();
		relayHandle = null;
		const base2 = await startRelay(port);
		expect(base2).toBe(base);

		// client reconnects; browser (EventSource auto-retries) gets a fresh
		// snapshot with the same hub sessionId
		await new Promise((r) => setTimeout(r, 300));
		const res = await fetch(`${base}/s/ols-test/events?key=k1&client=c1`, { signal: AbortSignal.timeout(2000) });
		const reader = res.body!.getReader();
		const { value } = await reader.read();
		const frame = new TextDecoder().decode(value ?? new Uint8Array());
		await reader.cancel();
		const snapshot = JSON.parse(frame.replace(/^data: /, "").trim());
		expect(snapshot.type).toBe("snapshot");
		expect(snapshot.sessionId).toBe(sessionId);
	});

	it("stop(): browsers get waiting; no reconnect", async () => {
		const base = await startRelay();
		const { hub } = setup(base);
		client = new RelayClient(hub, room(base), { backoffMs: [20] });
		await client.start();
		const browser = browserSse(base, "k1", "c1");
		await browser.ready;

		await client.stop();
		await new Promise((r) => setTimeout(r, 100));
		expect(browser.events[browser.events.length - 1]).toEqual({ type: "waiting" });

		// no reconnect: room has no presenter, new SSE gets waiting
		const res = await fetch(`${base}/s/ols-test/events?key=k1&client=c2`);
		const reader = res.body!.getReader();
		const { value } = await reader.read();
		await reader.cancel();
		expect(JSON.parse(new TextDecoder().decode(value ?? new Uint8Array()).replace(/^data: /, "").trim())).toEqual({ type: "waiting" });
	});
});

// keep ws referenced for type-compat in the test file
void WebSocket;

describe("unreachable relay (review fix 3)", () => {
	it("start() rejects after exhausting connect attempts instead of hanging", async () => {
		const client = new RelayClient(new Hub(new MirrorState()), { relay: "http://127.0.0.1:1", name: "ols-x", key: "k" }, { backoffMs: [10, 10], maxConnectAttempts: 3 });
		await expect(client.start()).rejects.toThrow(/relay/i);
	});
});

describe("busy during reconnect (review fix 4)", () => {
	it("reports the room lost instead of retrying forever", async () => {
		const relay = createRelay({ pageDir: "relay/src", pingMs: 1000 });
		await new Promise<void>((r) => relay.server.listen(0, "127.0.0.1", r));
		const port = (relay.server.address() as any).port;
		const base = `http://127.0.0.1:${port}`;
		const hub1 = new Hub(new MirrorState());
		const lost: string[] = [];
		const client = new RelayClient(hub1, { relay: base, name: "ols-x", key: "k1" }, { backoffMs: [30], reconnectBackoffMs: [30], onLost: (reason) => lost.push(reason) });
		await client.start();
		// relay drops the presenter; another moderator takes the room before we reconnect
		await relay.close();
		const relay2 = createRelay({ pageDir: "relay/src", pingMs: 1000 });
		await new Promise<void>((r) => relay2.server.listen(port, "127.0.0.1", r));
		const client2 = new RelayClient(new Hub(new MirrorState()), { relay: base, name: "ols-x", key: "k2" }, { backoffMs: [30] });
		await client2.start();
		await new Promise((r) => setTimeout(r, 300));
		expect(lost).toContain("busy");
		await client.stop();
		await client2.stop();
		await relay2.close();
	});
});

describe("code review fixes", () => {
	it("replaced: hub connections are torn down so no ghost members remain", async () => {
		const base = await startRelay();
		const { hub } = setup(base);
		client = new RelayClient(hub, room(base), {});
		await client.start();
		const browser = browserSse(base, "k1", "client-1");
		await browser.ready;
		await new Promise((r) => setTimeout(r, 50));
		hub.identify({ clientId: "client-1", username: "Alice" });
		await new Promise((r) => setTimeout(r, 50));
		expect(hub.memberList().members).toEqual([{ name: "Alice", voted: false }]);

		// a second client with the same key replaces this one
		const { hub: hub2 } = setup(base);
		const client2 = new RelayClient(hub2, room(base), {});
		await client2.start();
		await new Promise((r) => setTimeout(r, 100));

		expect(hub.memberList().members).toEqual([]);
		await client2.stop();
	});

	it("relay rejects the hello (error reply): start() rejects instead of hanging", async () => {
		const base = await startRelay();
		const { hub } = setup(base);
		const bad = { relay: base, name: "BAD NAME", key: "k1" };
		client = new RelayClient(hub, bad, {});
		await expect(client.start()).rejects.toThrow(/invalid room name/i);
	});

	it("relay never sends welcome: start() rejects after retries instead of hanging", async () => {
		const { WebSocketServer } = await import("ws");
		const wss = new WebSocketServer({ port: 0 });
		const port = (wss.address() as { port: number }).port;
		const { hub } = setup(`http://127.0.0.1:${port}`);
		client = new RelayClient(hub, { relay: `http://127.0.0.1:${port}`, name: "ols-test", key: "k1" }, {
			backoffMs: [10],
			maxConnectAttempts: 2,
			welcomeTimeoutMs: 50,
		});
		await expect(client.start()).rejects.toThrow(/relay unreachable|welcome|timed out/i);
		wss.close();
	});
});

describe("late socket errors must not crash pi (user report: ETIMEDOUT uncaughtException)", () => {
	it("an error arriving after start() gave up is ignored, not thrown", async () => {
		// port 1 on localhost: refuses connections at once
		const { hub } = setup("http://127.0.0.1:1");
		client = new RelayClient(hub, { relay: "http://127.0.0.1:1", name: "ols-test", key: "k1" }, {
			backoffMs: [1],
			maxConnectAttempts: 2,
			welcomeTimeoutMs: 100,
		});
		await expect(client.start()).rejects.toThrow(/relay unreachable/);

		// the socket of the last attempt can still emit errors late (e.g. a
		// connect timeout): with no listener attached this throws synchronously
		const ws = (client as unknown as { ws: WebSocket }).ws;
		expect(ws).toBeTruthy();
		ws!.emit("error", new Error("connect ETIMEDOUT 10.0.0.1:8080"));
		await new Promise((r) => setTimeout(r, 50));
	});

	it("stop() during a connect attempt keeps the error listener: no uncaught exception", async () => {
		const { WebSocketServer } = await import("ws");
		const wss = new WebSocketServer({ port: 0 }); // accepts, never welcomes
		const port = (wss.address() as { port: number }).port;
		const { hub } = setup(`http://127.0.0.1:${port}`);
		client = new RelayClient(hub, { relay: `http://127.0.0.1:${port}`, name: "ols-test", key: "k1" }, {
			welcomeTimeoutMs: 10_000,
		});
		const started = client.start();
		await new Promise((r) => setTimeout(r, 100)); // connect established
		const ws = (client as unknown as { ws: WebSocket }).ws!;
		await client.stop();
		ws.emit("error", new Error("connect ETIMEDOUT 10.0.0.1:8080"));
		await started; // stop() resolves the pending start()
		await new Promise((r) => setTimeout(r, 50));
		wss.close();
	});
});

describe("slow upgrade during relay rollout (user report: 'another moderator took over' with no other moderator)", () => {
	it("an attempt that timed out waiting for welcome does not later attach and get replaced by our own retry", async () => {
		const base = await startRelay();
		// Delay the FIRST WebSocket upgrade past the welcome timeout, like the
		// OpenShift router holding the upgrade while no relay pod is ready.
		const server = relayHandle!.server;
		const upgradeListeners = server.listeners("upgrade") as Array<(...args: unknown[]) => void>;
		server.removeAllListeners("upgrade");
		let upgrades = 0;
		server.on("upgrade", (...args: unknown[]) => {
			upgrades++;
			const delay = upgrades === 1 ? 300 : 0;
			setTimeout(() => {
				for (const listener of upgradeListeners) listener(...args);
			}, delay);
		});

		const { hub } = setup(base);
		const lost: string[] = [];
		client = new RelayClient(hub, room(base), {
			welcomeTimeoutMs: 100,
			backoffMs: [500],
			onLost: (reason) => lost.push(reason),
		});
		await client.start();
		// let the delayed first socket open and the scheduled retry run
		await new Promise((r) => setTimeout(r, 1200));
		expect(lost).toEqual([]);
	});
});

describe("faster reconnect after a lost connection (user report: page waited ~98 s after a rollout)", () => {
	it("once welcomed, reconnects use reconnectBackoffMs, not the slower initial backoff", async () => {
		const base = await startRelay();
		const { hub } = setup(base);
		client = new RelayClient(hub, room(base), {
			backoffMs: [5000], // initial-connect schedule: far too slow for this test
			reconnectBackoffMs: [50],
		});
		await client.start();

		// relay goes away and comes back on the same port
		const port = Number(new URL(base).port);
		await relayHandle!.close();
		relayHandle = null;
		await new Promise((r) => setTimeout(r, 200)); // a few failed reconnect attempts
		await startRelay(port);

		// with reconnectBackoffMs the moderator is back within a few hundred ms
		const deadline = Date.now() + 1500;
		let attached = false;
		while (Date.now() < deadline && !attached) {
			const res = await fetch(`${base}/s/ols-test/events?key=k1&client=c1`, { signal: AbortSignal.timeout(500) }).catch(() => null);
			if (res) {
				const reader = res.body!.getReader();
				const { value } = await reader.read();
				await reader.cancel();
				attached = new TextDecoder().decode(value ?? new Uint8Array()).includes('"snapshot"');
			}
			if (!attached) await new Promise((r) => setTimeout(r, 50));
		}
		expect(attached).toBe(true);
	});
});
