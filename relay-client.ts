import { WebSocket } from "ws";
import type { Hub, SnapshotEvent, HubEvent } from "./hub.js";
import type { Room } from "./rooms.js";
import { roomLink } from "./rooms.js";

export class RoomBusyError extends Error {}

/**
 * Transport that connects the local Hub to a relay over an outbound
 * WebSocket. The moderator holds all state; the relay only routes.
 */
export class RelayClient {
	private ws: WebSocket | null = null;
	private stopped = false;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private hubUnsubscribe: (() => void) | null = null;
	/** relay conn id → hub conn id */
	private connMap = new Map<string, string>();
	private helloPromise: Promise<void> | null = null;

	constructor(
		private hub: Hub,
		private room: Room,
		private opts: {
			onLost?: (reason: "replaced" | "busy") => void;
			backoffMs?: number[];
		} = {},
	) {}

	get url(): string {
		return this.room.relay;
	}

	get pageUrl(): string {
		return roomLink(this.room);
	}

	start(): Promise<void> {
		this.stopped = false;
		this.helloPromise = this.connect(0);
		return this.helloPromise;
	}

	async stop(): Promise<void> {
		this.stopped = true;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this.hubUnsubscribe?.();
		this.hubUnsubscribe = null;
		for (const connId of this.connMap.values()) this.hub.close(connId);
		this.connMap.clear();
		const ws = this.ws;
		this.ws = null;
		if (ws) {
			// do not let the close handler treat a deliberate stop as a drop
			ws.removeAllListeners("close");
			ws.close();
		}
	}

	private connect(attempt: number): Promise<void> {
		return new Promise((resolve, reject) => {
			if (this.stopped) {
				resolve();
				return;
			}
			const origin = this.room.relay.replace(/^http/, "ws");
			const ws = new WebSocket(`${origin}/presenter`);
			this.ws = ws;

			const fail = (err: unknown): void => {
				ws.removeAllListeners();
				if (this.stopped) {
					resolve();
					return;
				}
				// first attempt (hello never welcomed) surfaces busy immediately
				if (attempt === 0 && err instanceof RoomBusyError) {
					reject(err);
					return;
				}
				if (attempt === 0) {
					// initial connect failed: retry with backoff, resolve when up
					this.scheduleReconnect(resolve, reject);
					return;
				}
				this.scheduleReconnect();
			};

			ws.on("open", () => {
				ws.send(JSON.stringify({ t: "hello", room: this.room.name, key: this.room.key }));
			});

			ws.on("message", (data) => {
				let msg: any;
				try {
					msg = JSON.parse(String(data));
				} catch {
					return;
				}
				switch (msg.t) {
					case "welcome": {
						this.hubUnsubscribe?.();
						this.hubUnsubscribe = this.hub.subscribe((event) => this.onHubEvent(event));
						resolve();
						break;
					}
					case "busy": {
						fail(new RoomBusyError(`Room ${this.room.name} is busy.`));
						break;
					}
					case "replaced": {
						this.stopped = true; // do not reconnect
						this.hubUnsubscribe?.();
						this.hubUnsubscribe = null;
						ws.close();
						this.opts.onLost?.("replaced");
						resolve();
						break;
					}
					case "open": {
						const opened = this.hub.open(msg.client);
						this.connMap.set(msg.conn, opened.connId);
						this.send({ t: "send", conn: msg.conn, event: opened.snapshot });
						break;
					}
					case "close": {
						const connId = this.connMap.get(msg.conn);
						if (connId) {
							this.hub.close(connId);
							this.connMap.delete(msg.conn);
						}
						break;
					}
					case "request": {
						const reply = msg.kind === "identify" ? this.hub.identify(msg.body) : this.hub.vote(msg.body);
						this.send({ t: "reply", req: msg.req, status: reply.status, body: reply.body });
						break;
					}
				}
			});

			ws.on("error", () => {
				// surface as a failed connect; fail() decides retry vs reject
				fail(new Error("connection error"));
			});

			ws.on("close", () => {
				if (this.stopped) return;
				// dropped after being welcomed: reconnect with backoff
				if (this.hubUnsubscribe) {
					this.hubUnsubscribe?.();
					this.hubUnsubscribe = null;
					for (const connId of this.connMap.values()) this.hub.close(connId);
					this.connMap.clear();
					this.scheduleReconnect();
				}
			});
		});
	}

	private scheduleReconnect(resolve?: () => void, reject?: (err: unknown) => void): void {
		const backoff = this.opts.backoffMs ?? [1000, 2000, 5000, 10000, 30000];
		const delay = backoff[Math.min(this.reconnectAttempt ?? 0, backoff.length - 1)] ?? backoff[backoff.length - 1];
		this.reconnectAttempt = (this.reconnectAttempt ?? 0) + 1;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.connect(this.reconnectAttempt ?? 1)
				.then(() => resolve?.())
				.catch((err) => {
					if (reject && err instanceof RoomBusyError) reject(err);
				});
		}, delay);
	}

	private reconnectAttempt: number | undefined;

	private send(msg: unknown): void {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(msg));
		}
	}

	private onHubEvent(event: HubEvent | SnapshotEvent): void {
		if (event.type === "snapshot") return; // snapshots are per-connection sends
		this.send({ t: "broadcast", event });
	}
}
