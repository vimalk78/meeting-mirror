// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const realPageBody = (): string =>
	readFileSync("page/page.html", "utf8").replace(/[\s\S]*<body[^>]*>/, "").replace(/<script[\s\S]*<\/body>[\s\S]*/, "");

let stream: { onmessage?: (event: { data: string }) => void; src: string };
const poll = { question: "Choose", options: [{ key: "A", label: "One" }, { key: "B", label: "Two" }] };
const emptySnapshot = { messages: [], poll: null, revealed: null, voteCount: null, pollAnchor: null };
const snap = (over: Record<string, unknown> = {}) =>
	({ type: "snapshot", sessionId: "s", you: "Ann", snapshot: { ...emptySnapshot }, members: { members: [], voteCount: null }, ...over } as never);

function send(event: unknown) {
	stream.onmessage?.({ data: JSON.stringify(event) });
}
function texts() {
	return [...document.querySelectorAll("#transcript > *")].map((node) =>
		node.id === "poll-card" ? node.textContent?.trim() : node.querySelector(".text")?.textContent?.trim(),
	);
}

async function boot(path: string) {
	window.history.replaceState({}, "", path);
	await import("../page/page.js");
}
async function reset(path: string) {
	vi.resetModules();
	localStorage.clear();
	document.body.innerHTML = `
		<div id="identify-overlay" class="hidden"><div id="identify-error"></div><input id="username-input"><button id="username-button">Join</button></div>
		<div id="top-right" class="top-right">
			<div id="identity-chip" class="hidden"></div>
			<a id="board-link" class="board-link none" target="_blank" rel="noopener">Visual board (nothing shown)</a>
		</div>
		<main id="transcript"><div id="poll-card"></div></main>
		<div id="waiting" class="hidden">Waiting for the moderator…</div>
		<div id="members" class="hidden"></div>
		<button id="jump-latest" class="hidden"></button>
		<div id="board" class="board hidden">
			<p id="board-empty" class="board-empty">Nothing on the board yet</p>
			<iframe id="board-frame" class="board-frame hidden" sandbox="allow-scripts" title="Visual board"></iframe>
		</div>`;
	window.history.replaceState({}, "", path);
}
const fetchCalls: { url: string; init?: RequestInit }[] = [];

beforeEach(() => {
	fetchCalls.length = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			fetchCalls.push({ url, init });
			return new Response(JSON.stringify({ name: "ok" }), { status: 200, headers: { "content-type": "application/json" } });
		}),
	);
	vi.stubGlobal(
		"EventSource",
		class {
			onmessage?: (event: { data: string }) => void;
			src: string;
			constructor(src: string) {
				this.src = src;
				stream = this;
			}
		},
	);
	vi.stubGlobal("scrollTo", vi.fn());
});

describe("page wiring", () => {
	it("uses the relay base path for events and identify", async () => {
		await reset("/s/ols-4596?key=K");
		await boot("/s/ols-4596?key=K");
		expect(stream.src).toBe("/s/ols-4596/events?key=K&client=" + localStorage.getItem("meeting-mirror-client"));
		(document.getElementById("username-input") as HTMLInputElement).value = "Ann";
		await document.getElementById("username-button")!.dispatchEvent(new Event("click"));
		expect(fetchCalls.some((c) => c.url === "/s/ols-4596/identify?key=K")).toBe(true);
	});

	it("uses root paths in local mode", async () => {
		await reset("/?key=K");
		await boot("/?key=K");
		expect(stream.src.startsWith("/events?key=K&client=")).toBe(true);
	});

	it("creates a client id once and reuses it", async () => {
		await reset("/?key=K");
		await boot("/?key=K");
		const id1 = localStorage.getItem("meeting-mirror-client");
		expect(id1).toMatch(/^[0-9a-f-]{10,}$/);
		send({ type: "snapshot", you: null, snapshot: { messages: [], poll: null, revealed: null, voteCount: null, pollAnchor: null }, members: { members: [], voteCount: null } });
	});

	it("snapshot you:null shows overlay; you:Ann hides it and chips Ann", async () => {
		await reset("/?key=K");
		await boot("/?key=K");
		send({ type: "snapshot", you: null, snapshot: { messages: [], poll: null, revealed: null, voteCount: null, pollAnchor: null }, members: { members: [], voteCount: null } });
		expect(document.getElementById("identify-overlay")!.classList.contains("hidden")).toBe(false);
		send({ type: "snapshot", you: "Ann", snapshot: { messages: [], poll: null, revealed: null, voteCount: null, pollAnchor: null }, members: { members: [], voteCount: null } });
		expect(document.getElementById("identify-overlay")!.classList.contains("hidden")).toBe(true);
		expect(document.getElementById("identity-chip")!.textContent).toContain("Ann");
	});

	it("join conflict shows the server message in #identify-error", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				new Response(JSON.stringify({ error: "John is already in the room. Choose another name, for example John K." }), {
					status: 409,
					headers: { "content-type": "application/json" },
				}),
			),
		);
		await reset("/?key=K");
		await boot("/?key=K");
		send({ type: "snapshot", you: null, snapshot: { messages: [], poll: null, revealed: null, voteCount: null, pollAnchor: null }, members: { members: [], voteCount: null } });
		(document.getElementById("username-input") as HTMLInputElement).value = "John";
		await document.getElementById("username-button")!.dispatchEvent(new Event("click"));
		await new Promise((r) => setTimeout(r, 10));
		expect(document.getElementById("identify-error")!.textContent).toContain("John is already in the room");
	});

	it("vote 401 shows the join overlay", async () => {
		await reset("/?key=K");
		await boot("/?key=K");
		send({ type: "snapshot", you: "Ann", snapshot: { messages: [], poll: null, revealed: null, voteCount: null, pollAnchor: null }, members: { members: [], voteCount: null } });
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify({ error: "join first" }), { status: 401, headers: { "content-type": "application/json" } })),
		);
		send({ type: "poll_open", poll, anchor: 0 });
		await document.querySelector<HTMLElement>(".poll-option")!.dispatchEvent(new Event("click"));
		await new Promise((r) => setTimeout(r, 10));
		expect(document.getElementById("identify-overlay")!.classList.contains("hidden")).toBe(false);
	});

	it("members event renders escaped membersText with ticks", async () => {
		await reset("/?key=K");
		await boot("/?key=K");
		send({ type: "members", members: [{ name: "Alice", voted: true }, { name: "Bob", voted: false }], voteCount: 1 });
		expect(document.getElementById("members")!.textContent).toBe("In the room: Alice ✓, Bob (1 vote cast)");
		send({ type: "members", members: [{ name: "Alice", voted: false }, { name: "Bob", voted: false }], voteCount: null });
		expect(document.getElementById("members")!.textContent).toBe("In the room: Alice, Bob (2)");
	});

	it("poll status line shows voteCount", async () => {
		await reset("/?key=K");
		await boot("/?key=K");
		send({ type: "snapshot", you: "Ann", snapshot: { messages: [], poll, revealed: null, voteCount: 2, pollAnchor: 0 }, members: { members: [], voteCount: 2 } });
		expect(document.getElementById("poll-status")!.textContent).toBe("2 votes in · hidden until reveal");
	});

	it("waiting shows and hides; invalid_key stops rendering", async () => {
		await reset("/s/x?key=K");
		await boot("/s/x?key=K");
		send({ type: "waiting" });
		expect(document.getElementById("waiting")!.classList.contains("hidden")).toBe(false);
		send({ type: "snapshot", you: null, snapshot: { messages: [], poll: null, revealed: null, voteCount: null, pollAnchor: null }, members: { members: [], voteCount: null } });
		expect(document.getElementById("waiting")!.classList.contains("hidden")).toBe(true);
		send({ type: "invalid_key" });
		expect(document.body.textContent).toContain("This link is not valid for this room.");
	});
});

describe("membersText", () => {
	it("formats poll, no-poll and empty cases", async () => {
		const { membersText } = await import("../page/page.js");
		expect(membersText({ members: [{ name: "Alice", voted: true }, { name: "Bob", voted: false }], voteCount: 1 })).toBe(
			"In the room: Alice ✓, Bob (1 vote cast)",
		);
		expect(membersText({ members: [{ name: "Alice", voted: false }, { name: "Bob", voted: false }], voteCount: null })).toBe(
			"In the room: Alice, Bob (2)",
		);
		expect(membersText({ members: [], voteCount: null })).toBe("");
	});
	it("does not divide total votes by present members when voters departed", async () => {
		const { membersText } = await import("../page/page.js");
		expect(membersText({ members: [{ name: "Ann", voted: true }], voteCount: 3 })).toBe("In the room: Ann ✓ (3 votes cast)");
	});
});

describe("real page markup (review fix 2)", () => {
	it("page.html contains every element page.js looks up", async () => {
		const html = readFileSync("page/page.html", "utf8");
		for (const id of ["identify-overlay", "identity-chip", "transcript", "poll-card", "jump-latest", "members", "waiting", "identify-error", "username-input", "username-button"]) {
			expect(html, `page.html must contain #${id}`).toMatch(new RegExp(`id="${id}"`));
		}
	});
	it("renders the member list and waiting banner from the real page.html", async () => {
		vi.resetModules();
		localStorage.clear();
		document.body.innerHTML = realPageBody();
		window.history.replaceState({}, "", "/s/ols-4596?key=K");
		await import("../page/page.js");
		send({ type: "waiting" });
		expect(document.getElementById("waiting")!.classList.contains("hidden")).toBe(false);
		send({ type: "members", members: [{ name: "Ann", voted: true }], voteCount: 1 });
		expect(document.getElementById("members")!.textContent).toContain("Ann ✓");
	});
});

describe("poll status updates live (user report: 0 votes in)", () => {
	it("increments the poll status line as members vote, with singular plural", async () => {
		await reset("/?key=K");
		await boot("/?key=K");
		send({ type: "poll_open", poll, anchor: 0 });
		expect(document.getElementById("poll-status")!.textContent).toBe("0 votes in · hidden until reveal");
		send({ type: "members", members: [{ name: "Alice", voted: true }], voteCount: 1 });
		expect(document.getElementById("poll-status")!.textContent).toBe("1 vote in · hidden until reveal");
		send({ type: "members", members: [{ name: "Alice", voted: true }, { name: "Bob", voted: true }], voteCount: 2 });
		expect(document.getElementById("poll-status")!.textContent).toBe("2 votes in · hidden until reveal");
	});
});

describe("member line stays visible (user reports: scrolls away, hovers over text)", () => {
	it("page.css pins .members to the side and .banner to the top, and the transcript keeps clear of fixed elements", () => {
		const css = readFileSync("page/page.css", "utf8");
		const rule = (sel: string): string => css.slice(css.indexOf(sel), css.indexOf("}", css.indexOf(sel)));
		// member line: fixed, docked to the side so it never covers the reading column
		expect(rule(".members")).toMatch(/position:\s*fixed/);
		expect(rule(".members")).toMatch(/left:/);
		expect(rule(".members")).not.toMatch(/transform:\s*translateX\(-50%\)/);
		// waiting banner: fixed at the top, away from the newest text
		expect(rule(".banner")).toMatch(/position:\s*fixed/);
		expect(rule(".banner")).toMatch(/top:/);
		// the last message must not flow behind the fixed overlays
		expect(rule(".transcript")).toMatch(/padding:[^;]*\d+px[^;]*\d+px[^;]*\d+px/);
	});
});

describe("all-voted notice (moderator guidance)", () => {
	it("fires only when every present member has voted on an open poll", async () => {
		const { allVotedNotice } = await import("../page/page.js");
		const snap = (over: Record<string, unknown> = {}) => ({ messages: [], poll, revealed: null, voteCount: 0, pollAnchor: 0, ...over });
		const two = { members: [{ name: "A", voted: true }, { name: "B", voted: true }], voteCount: 2 };
		expect(allVotedNotice(snap({ voteCount: 2 }), two)).toBe(
			"All 2 attendees have voted. Run /reveal to show the results, then /poll-close to close the poll.",
		);
		expect(allVotedNotice(snap({ voteCount: 1 }), two)).toBe(null);
		expect(allVotedNotice(snap({ voteCount: 2, revealed: [{ username: "A", choice: "A", remark: "" }] }), two)).toBe(null);
		expect(allVotedNotice(snap({ voteCount: 2, poll: null }), two)).toBe(null);
		expect(allVotedNotice(snap({ voteCount: 2 }), { members: [], voteCount: 2 })).toBe(null);
	});
});

describe("EventSource failure (code review: no recovery after relay restart)", () => {
	it("error with CLOSED readyState shows waiting and reconnects", async () => {
		await reset("/s/ols-4596?key=k1");
		const sources: any[] = [];
		const OrigES = (globalThis as any).EventSource;
		vi.stubGlobal(
			"EventSource",
			class extends OrigES {
				constructor(src: string) {
					super(src);
					sources.push(this);
				}
			},
		);
		await boot("/s/ols-4596?key=k1");
		expect(sources).toHaveLength(1);

		(stream as any).readyState = 2;
		(OrigES as any).CLOSED = 2;
		(stream as any).onerror?.(new Event("error"));
		expect(document.getElementById("waiting")!.classList.contains("hidden")).toBe(false);

		// reconnect happens after the backoff
		await new Promise((r) => setTimeout(r, 1200));
		expect(sources.length).toBeGreaterThan(1);

		// a snapshot on the new stream hides the banner again
		send(snap());
		expect(document.getElementById("waiting")!.classList.contains("hidden")).toBe(true);
	});
});

describe("visual board visibility (computed styles)", () => {
	const screen = { name: "a.html", html: "<p>A</p>" };

	it("the empty message is really hidden when a screen is up, and the frame really hidden when it is not", async () => {
		// page.css decides what 'hidden' means; load the real sheet so a
		// toggled class without a CSS rule fails here, not in a meeting
		const style = document.createElement("style");
		style.textContent = readFileSync("page/page.css", "utf8");
		document.head.appendChild(style);
		try {
			await reset("/s/ols-4596/board?key=K");
			document.head.appendChild(style);
			await boot("/s/ols-4596/board?key=K");
			send(snap({ you: null, board: null }));
			expect(getComputedStyle(document.getElementById("board-empty")!).display).not.toBe("none");
			expect(getComputedStyle(document.getElementById("board-frame")!).display).toBe("none");
			send({ type: "board", screen });
			expect(getComputedStyle(document.getElementById("board-empty")!).display).toBe("none");
			expect(getComputedStyle(document.getElementById("board-frame")!).display).not.toBe("none");
			expect(getComputedStyle(document.getElementById("board")!).display).not.toBe("none");
		} finally {
			style.remove();
		}
	});
});

describe("visual board", () => {
	const screen = { name: "a.html", html: "<p>A</p>" };

	it("main view: link always present, href to board, text follows state", async () => {
		await reset("/s/ols-4596?key=K");
		await boot("/s/ols-4596?key=K");
		const link = document.getElementById("board-link") as HTMLAnchorElement;
		expect(link.getAttribute("href")).toBe("/s/ols-4596/board?key=K");
		send(snap({ board: null }));
		expect(link.textContent).toBe("Visual board (nothing shown)");
		send({ type: "board", screen });
		expect(link.textContent).toContain("Visual board");
		expect(link.querySelector(".board-new")?.textContent).toBe("new");
		localStorage.setItem("meeting-mirror-board-seen:/s/ols-4596", "a.html");
		window.dispatchEvent(new StorageEvent("storage", { key: "meeting-mirror-board-seen:/s/ols-4596" }));
		expect(link.querySelector(".board-new")).toBeNull();
	});

	it("board view: empty text, then sandboxed srcdoc, marks seen; same screen does not reload", async () => {
		await reset("/s/ols-4596/board?key=K");
		await boot("/s/ols-4596/board?key=K");
		expect(stream.src.startsWith("/s/ols-4596/events?key=K&client=")).toBe(true);
		expect(document.body.classList.contains("board-view")).toBe(true);
		send(snap({ you: null, board: null }));
		// the container itself must be visible, not just its children
		expect(document.getElementById("board")!.classList.contains("hidden")).toBe(false);
		expect(document.getElementById("board-empty")!.classList.contains("hidden")).toBe(false);
		expect(document.getElementById("identify-overlay")!.classList.contains("hidden")).toBe(true);
		send({ type: "board", screen });
		const frame = document.getElementById("board-frame") as HTMLIFrameElement;
		expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
		expect(frame.getAttribute("srcdoc")).toBe("<p>A</p>");
		expect(localStorage.getItem("meeting-mirror-board-seen:/s/ols-4596")).toBe("a.html");
		const setter = vi.spyOn(frame, "setAttribute");
		send(snap({ you: null, board: screen }));
		expect(setter).not.toHaveBeenCalledWith("srcdoc", expect.anything());
		setter.mockRestore();
	});

	it("board view: poll keys do not vote", async () => {
		await reset("/board?key=K");
		await boot("/board?key=K");
		send(snap({ snapshot: { ...emptySnapshot, poll, voteCount: 0, pollAnchor: 0 }, board: null }));
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "A" }));
		expect(fetchCalls.some((c) => c.url.includes("/vote"))).toBe(false);
	});
});
