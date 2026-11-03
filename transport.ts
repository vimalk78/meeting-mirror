import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
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
			res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream" });
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
		readJson(req)
			.then((body) => {
				const { username, choice, remark } = body as { username?: string; choice?: string; remark?: string };
				if (typeof username !== "string" || username.trim() === "" || typeof choice !== "string") {
					res.writeHead(400, { "content-type": "application/json" });
					res.end(JSON.stringify({ error: "username and choice required" }));
					return;
				}
				try {
					this.state.castVote(username.trim(), choice, typeof remark === "string" ? remark : "");
					res.writeHead(200, { "content-type": "application/json" });
					res.end(JSON.stringify({ ok: true }));
				} catch (err) {
					res.writeHead(409, { "content-type": "application/json" });
					res.end(JSON.stringify({ error: err instanceof Error ? err.message : "vote rejected" }));
				}
			})
			.catch(() => {
				res.writeHead(400, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: "invalid JSON body" }));
			});
	}

	private handleIdentify(req: IncomingMessage, res: ServerResponse): void {
		readJson(req)
			.then((body) => {
				const { username } = body as { username?: string };
				if (typeof username !== "string" || username.trim() === "") {
					res.writeHead(400, { "content-type": "application/json" });
					res.end(JSON.stringify({ error: "username required" }));
					return;
				}
				res.writeHead(204);
				res.end();
			})
			.catch(() => {
				res.writeHead(400, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: "invalid JSON body" }));
			});
	}
}

function readJson(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let data = "";
		req.on("data", (chunk) => (data += chunk));
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
