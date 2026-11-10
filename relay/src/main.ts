import { createRelay } from "./server.js";

const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);
const PAGE_DIR = process.env.PAGE_DIR ?? new URL("../../", import.meta.url).pathname;

const relay = createRelay({ pageDir: PAGE_DIR });
relay.server.listen(PORT, () => {
	console.log(`meeting-mirror relay listening on :${PORT}, page dir ${PAGE_DIR}`);
});
