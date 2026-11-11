import { WebSocket } from "ws";
import type { Hub, SnapshotEvent, HubEvent } from "./hub.js";
import type { Room } from "./rooms.js";
import { roomLink } from "./rooms.js";

export class RoomBusyError extends Error {}

/** The relay refused the connection (e.g. invalid room name): retrying cannot help. */
export class RelayRejectedError extends Error {}

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
			/** Failed initial connects before start() gives up and rejects. */
			maxConnectAttempts?: number;
			/** How long to wait for the relay's welcome before treating the connect as failed. */
			welcomeTimeoutMs?: number;
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
		this.everWelcomed = false;
		this.connectCount = 0;
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
			// keep the handlers attached: the close/error handlers check
			// this.stopped and no-op, but a listenerless ws turns a late
			// socket error into an uncaught exception that kills pi
			ws.close();
		}
	}

	private connect(attempt: number): Promise<void> {
		return new Promise((resolve, reject) => {
			if (this.stopped) {
				resolve();
				return;
			}
			this.connectCount = (this.connectCount ?? 0) + 1;
			const origin = this.room.relay.replace(/^http/, "ws");
			const ws = new WebSocket(`${origin}/presenter`);
			this.ws = ws;

			// guards the whole attempt: exactly one of fail/replaced settles it,
			// late socket events (e.g. a connect timeout firing after we gave
			// up and moved on) must be ignored, not acted on or thrown
			let settled = false;

			const welcomeTimer = setTimeout(() => {
				fail(new Error(`relay did not send a welcome in time: ${this.room.relay}`));
			}, this.opts.welcomeTimeoutMs ?? 10000);

			const fail = (err: unknown): void => {
				if (settled) return;
				settled = true;
				clearTimeout(welcomeTimer);
				// keep the real cause: a generic "connection error" hides
				// ETIMEDOUT and friends, which is what the moderator needs to see
				this.lastConnectError = err instanceof Error ? err.message : String(err);
				if (this.stopped) {
					resolve();
					return;
				}
				const wasEstablished = this.hubUnsubscribe !== null;
				// clean up hub state the same way a close would
				if (wasEstablished) this.teardownHub();
				if (err instanceof RoomBusyError) {
					if (this.everWelcomed) {
						// someone took the room while we were reconnecting: give it up
						this.stopped = true;
						this.opts.onLost?.("busy");
						resolve();
						return;
					}
					reject(err);
					return;
				}
				if (err instanceof RelayRejectedError) {
					// the relay refused us for a reason retrying cannot fix
					reject(err);
					return;
				}
				if (!this.everWelcomed && (this.connectCount ?? 0) >= (this.opts.maxConnectAttempts ?? 5)) {
					reject(
						new Error(
							`relay unreachable after ${this.connectCount} attempts: ${this.room.relay}` +
								(this.lastConnectError ? ` (${this.lastConnectError})` : ""),
						),
					);
					return;
				}
				this.scheduleReconnect(resolve, reject);
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
						clearTimeout(welcomeTimer);
						this.hubUnsubscribe?.();
						this.hubUnsubscribe = this.hub.subscribe((event) => this.onHubEvent(event));
						this.reconnectAttempt = 0; // backoff starts over after a welcome
						this.connectCount = 0;
						this.everWelcomed = true;
						resolve();
						break;
					}
					case "busy": {
						fail(new RoomBusyError(`Room ${this.room.name} is busy.`));
						break;
					}
					case "replaced": {
						settled = true;
						this.stopped = true; // do not reconnect
						// close the hub's browser connections too, or the members they
						// registered stay "present" as ghosts in a later share
						this.teardownHub();
						clearTimeout(welcomeTimer);
						ws.close();
						this.opts.onLost?.("replaced");
						resolve();
						break;
					}
					case "error": {
						fail(new RelayRejectedError(`Relay rejected the connection: ${msg.reason ?? "unknown reason"}`));
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

			ws.on("error", (err: Error) => {
				// surface as a failed connect; fail() decides retry vs reject.
				// This listener stays attached for the life of the socket: a
				// late error must never become an uncaught exception.
				fail(err);
			});

			ws.on("close", () => {
				if (this.stopped) {
					clearTimeout(welcomeTimer);
					return;
				}
				// dropped after being welcomed: reconnect with backoff
				if (this.hubUnsubscribe) {
					this.teardownHub();
					this.scheduleReconnect();
				} else if (!this.everWelcomed) {
					// closed before any welcome: treat as a failed connect so the
					// retry/give-up logic (not a hang) decides what happens next
					fail(new Error("relay closed the connection before welcoming us"));
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
				.catch((err) => reject?.(err));
		}, delay);
	}

	private reconnectAttempt: number | undefined;
	private connectCount: number | undefined;
	private everWelcomed = false;
	/** Message of the most recent connect failure, for error reporting. */
	private lastConnectError: string | undefined;

	private teardownHub(): void {
		this.hubUnsubscribe?.();
		this.hubUnsubscribe = null;
		for (const connId of this.connMap.values()) this.hub.close(connId);
		this.connMap.clear();
	}

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
