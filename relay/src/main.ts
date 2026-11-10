import { createRelay } from "./server.js";

const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);
const PAGE_DIR = process.env.PAGE_DIR ?? new URL("../../page/", import.meta.url).pathname;

const relay = createRelay({ pageDir: PAGE_DIR, onLog: (message) => console.log(message) });
relay.server.listen(PORT, () => {
	console.log(`meeting-mirror relay listening on :${PORT}, page dir ${PAGE_DIR}`);
});

// OpenShift sends SIGTERM on pod shutdown; exit gracefully so rooms are freed
// and connected browsers get a clean end-of-stream instead of a hang.
const shutdown = (signal: string): void => {
	console.log(`relay shutting down (${signal})`);
	relay
		.close()
		.catch(() => {})
		.finally(() => process.exit(0));
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
