import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Hub, HubEvent, SnapshotEvent } from "./hub.js";

export interface Transport {
	start(): Promise<void>;
	stop(): Promise<void>;
	readonly url: string;
	readonly pageUrl: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
};

export class LocalServer implements Transport {
	private server: Server | null = null;
	private unsubscribe: (() => void) | null = null;
	private sseClients = new Set<ServerResponse>();
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private chosenPort = 0;

	/** Random per-instance key: the share URL is the credential. */
	readonly key = randomUUID();

	constructor(
		private hub: Hub,
		private opts: { port?: number; host?: string; heartbeatMs?: number } = {},
	) {}

	get url(): string {
		const host = this.opts.host ?? "localhost";
		return `http://${host}:${this.chosenPort}`;
	}

	get pageUrl(): string {
		return `${this.url}/?key=${this.key}`;
	}

	async start(): Promise<void> {
		const startAt = this.opts.port ?? 7433;
		const candidates = this.opts.port
			? [this.opts.port]
			: [startAt, startAt + 1, startAt + 2, startAt + 3, startAt + 4, startAt + 5, startAt + 6, startAt + 7, startAt + 8, startAt + 9, 0];
		let lastError: unknown = null;
		for (const port of candidates) {
			try {
				await this.listen(port);
				return;
			} catch (err) {
				lastError = err;
			}
		}
		throw lastError ?? new Error("Could not bind a port");
	}

	private listen(port: number): Promise<void> {
		return new Promise((resolve, reject) => {
			const server = createServer((req, res) => this.handle(req, res));
			server.once("error", reject);
			server.listen(port, this.opts.host ?? "0.0.0.0", () => {
				server.removeListener("error", reject);
				this.server = server;
				const addr = server.address();
				this.chosenPort = typeof addr === "object" && addr ? addr.port : port;
				this.unsubscribe = this.hub.subscribe((event) => this.broadcast(event));
				const hb = this.opts.heartbeatMs ?? 25000;
				this.heartbeatTimer = setInterval(() => {
					for (const res of this.sseClients) res.write(": ping\n\n");
				}, hb);
				resolve();
			});
		});
	}

	async stop(): Promise<void> {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
		this.unsubscribe?.();
		this.unsubscribe = null;
		const server = this.server;
		this.server = null;
		for (const res of this.sseClients) {
			res.end();
			this.sseClients.delete(res);
		}
		if (!server) return;
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	private handle(req: IncomingMessage, res: ServerResponse): void {
		const url = new URL(req.url ?? "/", "http://local");
		if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
			if (this.isAuthorized(req, url)) {
				this.serveFile(res, "page.html");
			} else {
				this.reject(res);
			}
		} else if (req.method === "GET" && url.pathname === "/page.css") {
			this.serveFile(res, "page.css");
		} else if (req.method === "GET" && url.pathname === "/page.js") {
			this.serveFile(res, "page.js");
		} else if (req.method === "GET" && url.pathname === "/events") {
			if (this.isAuthorized(req, url)) {
				this.openSse(req, url, res);
			} else {
				this.reject(res);
			}
		} else if (req.method === "POST" && url.pathname === "/vote") {
			if (!this.isAuthorized(req, url)) {
				this.reject(res);
			} else {
				this.handleJson(req, res, (body) => this.hub.vote(body));
			}
		} else if (req.method === "POST" && url.pathname === "/identify") {
			if (!this.isAuthorized(req, url)) {
				this.reject(res);
			} else {
				this.handleJson(req, res, (body) => this.hub.identify(body));
			}
		} else {
			res.writeHead(404, { "content-type": "text/plain" });
			res.end("not found");
		}
	}

	private reject(res: ServerResponse): void {
		res.writeHead(403, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: "invalid or missing session key" }));
	}

	/**
	 * A request is authorized when it carries the session key as a query
	 * parameter (first page load, API calls) or as the mm_key cookie set on
	 * that first load (assets, reloads, same-origin fetches). Assets are
	 * exempt: they carry nothing.
	 */
	private isAuthorized(req: IncomingMessage, url: URL): boolean {
		if (url.searchParams.get("key") === this.key) return true;
		const cookie = req.headers.cookie ?? "";
		return cookie
			.split(";")
			.map((part) => part.trim())
			.some((part) => part === `mm_key_${this.hub.sessionId.slice(0, 8)}=${this.key}`);
	}

	private serveFile(res: ServerResponse, name: string): void {
		try {
			const content = readFileSync(join(HERE, name));
			const ext = name.slice(name.lastIndexOf("."));
			const headers: Record<string, string> = {
				"content-type": MIME[ext] ?? "application/octet-stream",
				"cache-control": "no-cache",
			};
			if (name === "page.html") {
				headers["set-cookie"] = `mm_key_${this.hub.sessionId.slice(0, 8)}=${this.key}; Path=/; HttpOnly; SameSite=Strict`;
			}
			res.writeHead(200, headers);
			res.end(content);
		} catch {
			res.writeHead(500, { "content-type": "text/plain" });
			res.end("missing page asset");
		}
	}

	private openSse(req: IncomingMessage, url: URL, res: ServerResponse): void {
		const client = url.searchParams.get("client") ?? "";
		if (client === "") {
			res.writeHead(400, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "client parameter required" }));
			return;
		}
		let connId: string;
		let snapshot: unknown;
		try {
			const opened = this.hub.open(client);
			connId = opened.connId;
			snapshot = opened.snapshot;
		} catch {
			res.writeHead(503, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "too many connections" }));
			return;
		}
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
		this.sseClients.add(res);
		res.on("close", () => {
			this.sseClients.delete(res);
			this.hub.close(connId);
		});
	}

	private broadcast(event: HubEvent | SnapshotEvent): void {
		const frame = `data: ${JSON.stringify(event)}\n\n`;
		for (const res of this.sseClients) {
			res.write(frame);
		}
	}

	private handleJson(
		req: IncomingMessage,
		res: ServerResponse,
		apply: (body: unknown) => { status: number; body: unknown },
	): void {
		if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
			res.writeHead(415, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "content-type must be application/json" }));
			return;
		}
		readJson(req)
			.then((body) => {
				const reply = apply(body);
				res.writeHead(reply.status, { "content-type": "application/json" });
				res.end(JSON.stringify(reply.body));
			})
			.catch((err) => {
				if (err instanceof PayloadTooLargeError) {
					res.writeHead(413, { "content-type": "application/json" });
					res.end(JSON.stringify({ error: "body too large" }), () => req.destroy());
				} else {
					res.writeHead(400, { "content-type": "application/json" });
					res.end(JSON.stringify({ error: "invalid JSON body" }));
				}
			});
	}
}

class PayloadTooLargeError extends Error {}

function readJson(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let data = "";
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > 64 * 1024) {
				req.pause();
				reject(new PayloadTooLargeError());
				return;
			}
			data += chunk;
		});
		req.on("end", () => {
			try {
				resolve(JSON.parse(data));
			} catch (err) {
				reject(err);
			}
		});
		req.on("error", reject);
	});
}
