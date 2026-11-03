import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { MirrorState, MirrorEvent } from "./state.js";

export interface Transport {
	start(): Promise<void>;
	stop(): Promise<void>;
	readonly url: string;
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
	private chosenPort = 0;
	private tokens = new Map<string, string>(); // token → username

	constructor(
		private state: MirrorState,
		private opts: { port?: number; host?: string } = {},
	) {}

	get url(): string {
		const host = this.opts.host ?? "localhost";
		return `http://${host}:${this.chosenPort}`;
	}

	async start(): Promise<void> {
		const startAt = this.opts.port ?? 7433;
		const candidates = this.opts.port ? [this.opts.port] : [startAt, startAt + 1, startAt + 2, startAt + 3, startAt + 4, startAt + 5, startAt + 6, startAt + 7, startAt + 8, startAt + 9, 0];
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
				this.unsubscribe = this.state.subscribe((event) => this.broadcast(event));
				resolve();
			});
		});
	}

	async stop(): Promise<void> {
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
			this.serveFile(res, "page.html");
		} else if (req.method === "GET" && url.pathname === "/page.css") {
			this.serveFile(res, "page.css");
		} else if (req.method === "GET" && url.pathname === "/page.js") {
			this.serveFile(res, "page.js");
		} else if (req.method === "GET" && url.pathname === "/events") {
			this.openSse(res);
		} else if (req.method === "POST" && url.pathname === "/vote") {
			this.handleVote(req, res);
		} else if (req.method === "POST" && url.pathname === "/identify") {
			this.handleIdentify(req, res);
		} else {
			res.writeHead(404, { "content-type": "text/plain" });
			res.end("not found");
		}
	}

	private serveFile(res: ServerResponse, name: string): void {
		try {
			const content = readFileSync(join(HERE, name));
			const ext = name.slice(name.lastIndexOf("."));
			res.writeHead(200, {
				"content-type": MIME[ext] ?? "application/octet-stream",
				"cache-control": "no-cache",
			});
			res.end(content);
		} catch {
			res.writeHead(500, { "content-type": "text/plain" });
			res.end("missing page asset");
		}
	}

	private openSse(res: ServerResponse): void {
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		res.write(`data: ${JSON.stringify({ type: "snapshot", snapshot: this.state.getSnapshot() })}\n\n`);
		this.sseClients.add(res);
		reqCloseCleanup(res, () => this.sseClients.delete(res));
	}

	private broadcast(event: MirrorEvent): void {
		const frame = `data: ${JSON.stringify(event)}\n\n`;
		for (const res of this.sseClients) {
			res.write(frame);
		}
	}

	private handleVote(req: IncomingMessage, res: ServerResponse): void {
		if (!isJsonContentType(req)) {
			res.writeHead(415, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "content-type must be application/json" }));
			return;
		}
		readJson(req)
			.then((body) => {
				const { token, username, choice, remark } = body as {
					token?: string;
					username?: string;
					choice?: string;
					remark?: string;
				};
				if (typeof token !== "string" || token === "") {
					res.writeHead(401, { "content-type": "application/json" });
					res.end(JSON.stringify({ error: "token required (identify first)" }));
					return;
				}
				if (typeof username !== "string" || username.trim() === "" || typeof choice !== "string") {
					res.writeHead(400, { "content-type": "application/json" });
					res.end(JSON.stringify({ error: "username and choice required" }));
					return;
				}
				const name = username.trim();
				if (this.tokens.get(token) !== name) {
					res.writeHead(403, { "content-type": "application/json" });
					res.end(JSON.stringify({ error: "token does not match username" }));
					return;
				}
				try {
					const trimmedRemark = typeof remark === "string" ? remark.slice(0, 500) : "";
					this.state.castVote(name, choice, trimmedRemark);
					res.writeHead(200, { "content-type": "application/json" });
					res.end(JSON.stringify({ ok: true }));
				} catch (err) {
					res.writeHead(409, { "content-type": "application/json" });
					res.end(JSON.stringify({ error: err instanceof Error ? err.message : "vote rejected" }));
				}
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

	private handleIdentify(req: IncomingMessage, res: ServerResponse): void {
		if (!isJsonContentType(req)) {
			res.writeHead(415, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "content-type must be application/json" }));
			return;
		}
		readJson(req)
			.then((body) => {
				const { username } = body as { username?: string };
				if (typeof username !== "string" || username.trim() === "") {
					res.writeHead(400, { "content-type": "application/json" });
					res.end(JSON.stringify({ error: "username required" }));
					return;
				}
				const name = username.trim().slice(0, 40);
				if (this.tokens.size >= 500) {
					res.writeHead(503, { "content-type": "application/json" });
					res.end(JSON.stringify({ error: "too many identities this session" }));
					return;
				}
				// Identify is idempotent and per-client: re-identifying a name
			// issues an additional token (a returning teammate after a server
				// restart, or a second tab of the same user). Votes are keyed by
				// username in the poll state, so multiple tokens per name are
				// safe; unknown tokens still cannot vote.
				const token = randomUUID();
				this.tokens.set(token, name);
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ token }));
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

function isJsonContentType(req: IncomingMessage): boolean {
	return (req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json");
}

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

function reqCloseCleanup(_res: ServerResponse, fn: () => void): void {
	// ServerResponse emits 'close' when the underlying connection goes away.
	_res.on("close", fn);
}
