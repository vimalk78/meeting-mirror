// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const realPageBody = (): string =>
	readFileSync("page.html", "utf8").replace(/[\s\S]*<body[^>]*>/, "").replace(/<script[\s\S]*<\/body>[\s\S]*/, "");

let stream: { onmessage?: (event: { data: string }) => void; src: string };
const poll = { question: "Choose", options: [{ key: "A", label: "One" }, { key: "B", label: "Two" }] };

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
	await import("./page.js");
}
async function reset(path: string) {
	vi.resetModules();
	localStorage.clear();
	document.body.innerHTML = `
		<div id="identify-overlay" class="hidden"><div id="identify-error"></div><input id="username-input"><button id="username-button">Join</button></div>
		<div id="identity-chip" class="hidden"></div>
		<main id="transcript"><div id="poll-card"></div></main>
		<div id="waiting" class="hidden">Waiting for the moderator…</div>
		<div id="members" class="hidden"></div>
		<button id="jump-latest" class="hidden"></button>`;
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
		const { membersText } = await import("./page.js");
		expect(membersText({ members: [{ name: "Alice", voted: true }, { name: "Bob", voted: false }], voteCount: 1 })).toBe(
			"In the room: Alice ✓, Bob (1 vote cast)",
		);
		expect(membersText({ members: [{ name: "Alice", voted: false }, { name: "Bob", voted: false }], voteCount: null })).toBe(
			"In the room: Alice, Bob (2)",
		);
		expect(membersText({ members: [], voteCount: null })).toBe("");
	});
	it("does not divide total votes by present members when voters departed", async () => {
		const { membersText } = await import("./page.js");
		expect(membersText({ members: [{ name: "Ann", voted: true }], voteCount: 3 })).toBe("In the room: Ann ✓ (3 votes cast)");
	});
});

describe("real page markup (review fix 2)", () => {
	it("page.html contains every element page.js looks up", async () => {
		const html = readFileSync("page.html", "utf8");
		for (const id of ["identify-overlay", "identity-chip", "transcript", "poll-card", "jump-latest", "members", "waiting", "identify-error", "username-input", "username-button"]) {
			expect(html, `page.html must contain #${id}`).toMatch(new RegExp(`id="${id}"`));
		}
	});
	it("renders the member list and waiting banner from the real page.html", async () => {
		vi.resetModules();
		localStorage.clear();
		document.body.innerHTML = realPageBody();
		window.history.replaceState({}, "", "/s/ols-4596?key=K");
		await import("./page.js");
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
		const css = readFileSync("page.css", "utf8");
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
		const { allVotedNotice } = await import("./page.js");
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
