import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
export function createRelay(opts) {
    const heartbeatMs = opts.heartbeatMs ?? 25000;
    const pingMs = opts.pingMs ?? 15000;
    const presenterTimeoutMs = opts.presenterTimeoutMs ?? 30000;
    const requestTimeoutMs = opts.requestTimeoutMs ?? 10000;
    const maxConnsPerRoom = opts.maxConnsPerRoom ?? 200;
    const maxConnsTotal = opts.maxConnsTotal ?? 2000;
    const rooms = new Map();
    let totalConns = 0;
    const MIME = {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
    };
    const servePageFile = (res, name) => {
        const path = join(opts.pageDir, name);
        if (!existsSync(path)) {
            res.writeHead(500, { "content-type": "text/plain" });
            res.end("missing page asset");
            return;
        }
        const ext = name.slice(name.lastIndexOf("."));
        res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream", "cache-control": "no-cache" });
        res.end(readFileSync(path));
    };
    const getRoom = (name) => rooms.get(name);
    const ensureRoom = (name) => {
        let room = rooms.get(name);
        if (!room) {
            room = { presenter: null, conns: new Map(), pending: new Map(), nextReq: 1 };
            rooms.set(name, room);
        }
        return room;
    };
    const roomIsEmpty = (room) => !room.presenter && room.conns.size === 0 && room.pending.size === 0;
    const sweep = () => {
        for (const [name, room] of rooms) {
            if (roomIsEmpty(room))
                rooms.delete(name);
        }
    };
    const sendToModerator = (room, msg) => {
        if (room.presenter && room.presenter.ws.readyState === WebSocket.OPEN) {
            room.presenter.ws.send(JSON.stringify(msg));
        }
    };
    const broadcastToRoom = (room, event) => {
        const frame = `data: ${JSON.stringify(event)}\n\n`;
        for (const conn of room.conns.values())
            conn.res.write(frame);
    };
    const openBrowserSse = (room, res, client, key) => {
        res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
        });
        const conn = Math.random().toString(36).slice(2) + Date.now().toString(36);
        if (!room.presenter || room.presenter.key !== key) {
            if (!room.presenter) {
                // parked: wait for a moderator, validate the key when one arrives
                res.write(`data: ${JSON.stringify({ type: "waiting" })}\n\n`);
                room.conns.set(conn, { res, client, key });
                res.on("close", () => {
                    room.conns.delete(conn);
                    sweep();
                });
                return;
            }
            res.write(`data: ${JSON.stringify({ type: "invalid_key" })}\n\n`);
            res.end();
            return;
        }
        room.conns.set(conn, { res, client, key });
        sendToModerator(room, { t: "open", conn, client });
        res.on("close", () => {
            room.conns.delete(conn);
            if (room.presenter)
                sendToModerator(room, { t: "close", conn });
            sweep();
        });
    };
    // When a moderator attaches, parked browsers with the matching key get opened.
    const adoptParked = (room) => {
        for (const [conn, entry] of [...room.conns]) {
            if (entry.key === room.presenter?.key) {
                entry.res.write(`data: ${JSON.stringify({ type: "__adopted__" })}\n\n`);
                sendToModerator(room, { t: "open", conn, client: entry.client });
            }
            else {
                entry.res.write(`data: ${JSON.stringify({ type: "invalid_key" })}\n\n`);
                entry.res.end();
                room.conns.delete(conn);
            }
        }
    };
    const handlePresenter = (ws) => {
        let room = null;
        let ourKey = "";
        let alive = true;
        const pong = () => {
            alive = true;
        };
        ws.on("pong", pong);
        const pingTimer = setInterval(() => {
            if (!alive) {
                ws.terminate();
                return;
            }
            alive = false;
            if (ws.readyState === WebSocket.OPEN)
                ws.ping();
        }, pingMs);
        const drop = () => {
            clearInterval(pingTimer);
            if (room && room.presenter?.ws === ws) {
                room.presenter = null;
                broadcastToRoom(room, { type: "waiting" });
                for (const res of room.pending.values()) {
                    res.writeHead(503, { "content-type": "application/json" });
                    res.end(JSON.stringify({ error: "moderator disconnected" }));
                }
                room.pending.clear();
                sweep();
            }
            room = null;
        };
        ws.on("close", drop);
        ws.on("error", drop);
        ws.on("message", (data) => {
            let msg;
            try {
                msg = JSON.parse(String(data));
            }
            catch {
                return;
            }
            if (!room) {
                if (msg.t === "hello" && typeof msg.room === "string" && typeof msg.key === "string") {
                    if (!/^[a-z0-9-]{3,30}$/.test(msg.room)) {
                        ws.send(JSON.stringify({ t: "error", reason: "invalid room name" }));
                        return;
                    }
                    const target = ensureRoom(msg.room);
                    if (target.presenter && target.presenter.key !== msg.key) {
                        ws.send(JSON.stringify({ t: "busy" }));
                        return;
                    }
                    if (target.presenter && target.presenter.key === msg.key && target.presenter.ws !== ws) {
                        // same key: the new socket replaces the stale one
                        const stale = target.presenter.ws;
                        target.presenter = { ws, key: msg.key };
                        stale.send(JSON.stringify({ t: "replaced" }));
                        stale.close();
                    }
                    else {
                        target.presenter = { ws, key: msg.key };
                    }
                    room = target;
                    ourKey = msg.key;
                    ws.send(JSON.stringify({ t: "welcome" }));
                    adoptParked(room);
                }
                return;
            }
            if (msg.t === "broadcast") {
                broadcastToRoom(room, msg.event);
            }
            else if (msg.t === "send" && typeof msg.conn === "string") {
                const entry = room.conns.get(msg.conn);
                if (entry)
                    entry.res.write(`data: ${JSON.stringify(msg.event)}\n\n`);
            }
            else if (msg.t === "reply" && typeof msg.req === "number") {
                const res = room.pending.get(msg.req);
                if (res) {
                    room.pending.delete(msg.req);
                    res.writeHead(msg.status, { "content-type": "application/json" });
                    res.end(JSON.stringify(msg.body ?? null));
                }
            }
        });
        void ourKey;
    };
    const handlePost = (room, kind, req, res) => {
        if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
            res.writeHead(415, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "content-type must be application/json" }));
            return;
        }
        let data = "";
        let size = 0;
        let aborted = false;
        req.on("data", (chunk) => {
            size += chunk.length;
            if (size > 64 * 1024) {
                aborted = true;
                res.writeHead(413, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: "body too large" }), () => req.destroy());
            }
            data += chunk;
        });
        req.on("end", () => {
            if (aborted)
                return;
            if (!room.presenter) {
                res.writeHead(503, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: "no moderator connected" }));
                return;
            }
            let body;
            try {
                body = JSON.parse(data);
            }
            catch {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: "invalid JSON body" }));
                return;
            }
            const reqId = room.nextReq++;
            room.pending.set(reqId, res);
            sendToModerator(room, { t: "request", req: reqId, kind, body });
            setTimeout(() => {
                if (room.pending.delete(reqId)) {
                    res.writeHead(504, { "content-type": "application/json" });
                    res.end(JSON.stringify({ error: "moderator did not reply in time" }));
                }
            }, requestTimeoutMs);
        });
    };
    const server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://local");
        if (req.method === "GET" && url.pathname === "/healthz") {
            res.writeHead(200, { "content-type": "text/plain" });
            res.end("ok");
            return;
        }
        if (req.method === "GET" && (url.pathname === "/page.css" || url.pathname === "/page.js")) {
            servePageFile(res, url.pathname.slice(1));
            return;
        }
        const roomMatch = url.pathname.match(/^\/s\/([a-z0-9-]{3,30})(\/(events|identify|vote))?\/?$/);
        if (!roomMatch) {
            res.writeHead(404, { "content-type": "text/plain" });
            res.end("not found");
            return;
        }
        const name = roomMatch[1];
        const action = roomMatch[3];
        const key = url.searchParams.get("key") ?? "";
        const client = url.searchParams.get("client") ?? "";
        if (req.method === "GET" && !action) {
            servePageFile(res, "page.html");
            return;
        }
        if (req.method === "GET" && action === "events") {
            if (client === "") {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: "client parameter required" }));
                return;
            }
            if (totalConns >= maxConnsTotal) {
                res.writeHead(503, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: "relay is full" }));
                return;
            }
            const room = getRoom(name) ?? ensureRoom(name);
            if (room.conns.size >= maxConnsPerRoom) {
                res.writeHead(503, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: "room is full" }));
                return;
            }
            totalConns++;
            res.on("close", () => {
                totalConns--;
                sweep();
            });
            openBrowserSse(room, res, client, key);
            return;
        }
        if (req.method === "POST" && (action === "identify" || action === "vote")) {
            const room = getRoom(name);
            if (!room || !room.presenter) {
                res.writeHead(503, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: "no moderator connected" }));
                return;
            }
            if (key !== room.presenter.key) {
                res.writeHead(403, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: "invalid or missing session key" }));
                return;
            }
            handlePost(room, action, req, res);
            return;
        }
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
    });
    const wss = new WebSocketServer({ server });
    wss.on("connection", (ws, req) => {
        if (req.url === "/presenter")
            handlePresenter(ws);
        else
            ws.close();
    });
    const heartbeatTimer = setInterval(() => {
        for (const room of rooms.values()) {
            const frame = ": ping\n\n";
            for (const conn of room.conns.values())
                conn.res.write(frame);
        }
    }, heartbeatMs);
    heartbeatTimer.unref?.();
    pingTimerRef = heartbeatTimer;
    return {
        server,
        roomCount: () => rooms.size,
        close: async () => {
            clearInterval(heartbeatTimer);
            for (const room of rooms.values()) {
                room.presenter?.ws.close();
                for (const conn of room.conns.values())
                    conn.res.end();
                for (const res of room.pending.values()) {
                    res.writeHead(503, { "content-type": "application/json" });
                    res.end(JSON.stringify({ error: "relay shutting down" }));
                }
            }
            rooms.clear();
            wss.close();
            await new Promise((resolve) => server.close(() => resolve()));
        },
    };
}
// keep a module-level ref so tests can clear timers if needed
let pingTimerRef = null;
