// Meeting Mirror page — document-style reader with planning-poker voting.
// Pure helpers are exported for tests; browser wiring runs only when a
// document exists (so the module can be imported in Node for testing).

export function escapeHtml(s) {
	return String(s)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

/**
 * Render a safe Markdown subset: paragraphs, bold, italic, inline code,
 * fenced code blocks, ATX headings, unordered/ordered lists, blockquotes,
 * and links (http/https hrefs only). All HTML is escaped before any
 * markdown is applied, so raw markup can never pass through.
 */
export function renderMarkdown(md) {
	const lines = String(md).split("\n");
	const out = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const fence = line.match(/^\s*```/);
		if (fence) {
			// Fenced code block: raw lines until the closing fence, escaped.
			const code = [];
			i++;
			while (i < lines.length && !/^\s*```/.test(lines[i])) {
				code.push(lines[i]);
				i++;
			}
			i++; // closing fence
			out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
			continue;
		}
		if (line.includes("|") && i + 1 < lines.length && isDelimiterRow(lines[i + 1])) {
			const [tableHtml, nextIndex] = renderTable(line, lines[i + 1], lines, i + 2);
			out.push(tableHtml);
			i = nextIndex;
			continue;
		}
		const heading = line.match(/^(#{1,4})\s+(.*)$/);
		if (heading) {
			const level = heading[1].length;
			out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
			i++;
			continue;
		}
		if (/^\s*>/.test(line)) {
			const quote = [];
			while (i < lines.length && /^\s*>/.test(lines[i])) {
				quote.push(lines[i].replace(/^\s*>\s?/, ""));
				i++;
			}
			out.push(`<blockquote><p>${renderInline(quote.join(" "))}</p></blockquote>`);
			continue;
		}
		const ul = line.match(/^\s*[-*]\s+/);
		const ol = line.match(/^\s*\d+[.)]\s+/);
		if (ul || ol) {
			const tag = ul ? "ul" : "ol";
			const items = [];
			const itemRe = ul ? /^\s*[-*]\s+/ : /^\s*\d+[.)]\s+/;
			while (i < lines.length && lines[i].match(itemRe)) {
				items.push(`<li>${renderInline(lines[i].replace(itemRe, ""))}</li>`);
				i++;
			}
			// An ordered list keeps the number of its first item (CommonMark):
			// a list split by a heading or a blank line continues at 3, 17...
			// instead of the browser restarting it at 1.
			const start = ol ? Number.parseInt(line.trim(), 10) : 1;
			const startAttr = start !== 1 ? ` start="${start}"` : "";
			out.push(`<${tag}${startAttr}>${items.join("")}</${tag}>`);
			continue;
		}
		if (line.trim() === "") {
			i++;
			continue;
		}
		// Paragraph: consecutive non-blank, non-structural lines.
		const para = [];
		while (
				i < lines.length &&
				lines[i].trim() !== "" &&
				!/^\s*```/.test(lines[i]) &&
				!(lines[i].includes("|") && i + 1 < lines.length && isDelimiterRow(lines[i + 1])) &&
				!/^#{1,4}\s/.test(lines[i]) &&
				!/^\s*>/.test(lines[i]) &&
				!/^\s*[-*]\s+/.test(lines[i]) &&
				!/^\s*\d+[.)]\s+/.test(lines[i])
		) {
			para.push(lines[i]);
			i++;
		}
		out.push(`<p>${renderInline(para.join(" "))}</p>`);
	}
	return out.join("");
}

/** True for a GFM table delimiter row: only |, :, -, spaces, with at
 * least one dash and one pipe. */
function isDelimiterRow(line) {
	return /^[\s|:-]+$/.test(line) && line.includes("-") && line.includes("|");
}

/** Split a table row into trimmed cells, dropping the edge pipes. */
function splitRow(line) {
	return line
		.trim()
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split("|")
		.map((cell) => cell.trim());
}

function tableAlign(delimiter) {
	const left = delimiter.startsWith(":");
	const right = delimiter.endsWith(":");
	if (left && right) return "center";
	if (right) return "right";
	if (left) return "left";
	return "";
}

/** Render a GFM table: headerLine and delimiterLine are already split off,
 * body rows start at lines[i]. Returns [html, nextIndex]. */
function renderTable(headerLine, delimiterLine, lines, i) {
	const header = splitRow(headerLine);
	const aligns = splitRow(delimiterLine).map(tableAlign);
	const cell = (text, tag, j) => {
		const align = aligns[j] ? ` style="text-align:${aligns[j]}"` : "";
		return `<${tag}${align}>${renderInline(text)}</${tag}>`;
	};
	const head = header.map((c, j) => cell(c, "th", j)).join("");
	let index = i;
	const rows = [];
	while (index < lines.length && lines[index].includes("|") && lines[index].trim() !== "") {
		rows.push(splitRow(lines[index]));
		index++;
	}
	const body = rows.map((row) => `<tr>${header.map((_, j) => cell(row[j] ?? "", "td", j)).join("")}</tr>`).join("");
	return [`<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`, index];
}

/** Inline markdown on already-escaped-to-be text: escape first, then bold,
 * code, links, italics. */
function renderInline(text) {
	let html = escapeHtml(text);
	// inline code first; its content must not receive further markup
	html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
	html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
	// links: only http(s) targets survive
	html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (whole, label, href) => {
		return /^https?:\/\//.test(href) ? `<a href="${href}" target="_blank" rel="noopener">${label}</a>` : label;
	});
	html = html.replace(/(^|[^*])\*([^*\s][^*]*)\*(?![*])/g, "$1<em>$2</em>");
	return html;
}

/** HTML for the revealed tally: proportional bars with voter names, remarks below. */
export function renderTally(votes, options) {
	const counts = {};
	for (const o of options) counts[o.key] = 0;
	for (const v of votes) counts[v.choice] = (counts[v.choice] ?? 0) + 1;
	const max = Math.max(1, ...Object.values(counts));
	const namesBy = {};
	for (const o of options) {
		namesBy[o.key] = votes
			.filter((v) => v.choice === o.key)
			.map((v) => escapeHtml(v.username))
			.join(", ");
	}
	const bars = options
		.map((o) => {
			const pct = Math.round((counts[o.key] / max) * 100);
			return `<div class="tally-row">
				<span class="tally-key">${escapeHtml(o.key)}</span>
				<div class="tally-bar-track">
					<div class="tally-bar" style="width: ${pct}%"></div>
					<span class="tally-names">${escapeHtml(o.label)} · ${namesBy[o.key]}</span>
				</div>
				<span class="tally-count">${counts[o.key]}</span>
			</div>`;
		})
		.join("");
	const remarks = votes
		.filter((v) => v.remark && v.remark.trim() !== "")
		.map((v) => `<div class="tally-remark"><strong>${escapeHtml(v.username)}</strong> (${escapeHtml(v.choice)}): ${escapeHtml(v.remark)}</div>`)
		.join("");
	return `<div class="tally">${bars}${remarks ? `<div class="tally-remarks">${remarks}</div>` : ""}</div>`;
}

/** HTML for one transcript message: role label, timestamp, markdown text. */
export function formatMessage(m) {
	const label = m.role === "user" ? "MODERATOR" : "PI";
	const time = new Date(m.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	return `<div class="message ${m.role}">
		<div class="label">${label} · ${time}</div>
		<div class="text">${renderMarkdown(m.text)}</div>
	</div>`;
}

/** Member list text: "In the room: Alice ✓, Bob (1 of 2 voted)". */
/** Moderator-side guidance: tells the moderator when everyone present has
 * voted on the open poll, so they know it can be revealed and closed. */
export function allVotedNotice(snapshot, list) {
	if (!snapshot.poll || snapshot.revealed) return null;
	if (!list || list.members.length === 0) return null;
	if ((snapshot.voteCount ?? 0) < list.members.length) return null;
	return `All ${list.members.length} attendees have voted. Run /reveal to show the results, then /poll-close to close the poll.`;
}

export function membersText(list) {
	if (!list || list.members.length === 0) return "";
	const names = list.members.map((m) => `${m.name}${m.voted ? " ✓" : ""}`).join(", ");
	if (list.voteCount !== null && list.voteCount !== undefined && list.voteCount > 0) {
		// voteCount includes voters who already left, so never divide it by
		// the number of members still present
		return `In the room: ${names} (${list.voteCount} vote${list.voteCount === 1 ? "" : "s"} cast)`;
	}
	return `In the room: ${names} (${list.members.length})`;
}

// ---------------------------------------------------------------------------
// Browser wiring below — never executed in Node tests.
// ---------------------------------------------------------------------------

let username = null;
let pollActive = false;
let deadLink = false;

// View and base path from the URL: "/s/ols-4596/board" is the board view,
// "/s/ols-4596" the main view; "" locally.
export function pageView(pathname) {
	const path = pathname.replace(/\/$/, "");
	const m = path.match(/^(\/s\/[a-z0-9-]{3,30})?\/board$/);
	if (m) return { view: "board", base: m[1] || "" };
	return { view: "main", base: path };
}

/** State of the main page's board link: nothing shown, a screen this
 * browser has seen, or a new screen. */
export function boardLinkState(screen, seenName) {
	if (!screen) return "none";
	return screen.name === seenName ? "active" : "new";
}

/** localStorage key for the screen this browser's board page last showed. */
export const boardSeenKey = (base) => `meeting-mirror-board-seen:${base}`;

// Guarded so the module stays importable in Node for tests of pure helpers.
const hasWindow = typeof location !== "undefined";
const { view: VIEW, base: BASE } = hasWindow ? pageView(location.pathname) : { view: "main", base: "" };
const KEY = hasWindow ? new URLSearchParams(location.search).get("key") ?? "" : "";
const CLIENT_ID = (() => {
	if (!hasWindow) return "";
	let id = localStorage.getItem("meeting-mirror-client");
	if (!id) {
		id = crypto.randomUUID();
		localStorage.setItem("meeting-mirror-client", id);
	}
	return id;
})();
const api = (path) => `${BASE}${path}?key=${encodeURIComponent(KEY)}`;

function appendMessage(m) {
	const transcript = document.getElementById("transcript");
	const jump = document.getElementById("jump-latest");
	// Messages always append at the end of the transcript, in order. The poll
	// card keeps its position (moved to the end when the poll opened), so new
	// messages land after it — never between the card and earlier messages.
	transcript.insertAdjacentHTML("beforeend", formatMessage(m));
	// The page never auto-scrolls (design rule); if the reader is now behind,
	// show the jump control. The scroll listener re-hides it at the bottom.
	const atBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 80;
	if (!atBottom && jump) jump.classList.remove("hidden");
}

function positionPollCard(anchor) {
	const transcript = document.getElementById("transcript");
	const card = document.getElementById("poll-card");
	// Position relative to messages, not to the current DOM index of the card.
	const messages = transcript.querySelectorAll(":scope > .message");
	transcript.insertBefore(card, messages[Math.min(anchor, messages.length)] ?? null);
}

function pollStatusText(count) {
	return `${count} vote${count === 1 ? "" : "s"} in · hidden until reveal`;
}

function renderPollCard(poll, initialCount = 0, anchor = document.querySelectorAll("#transcript > .message").length) {
	positionPollCard(anchor);
	const buttons = poll.options
		.map((o) => `<button class="poll-option" data-key="${escapeHtml(o.key)}">${escapeHtml(o.key)} · ${escapeHtml(o.label)}</button>`)
		.join("");
	document.getElementById("poll-card").innerHTML = `
		<div class="poll-label">VOTE — ${escapeHtml(poll.question)}</div>
		<div class="poll-options">${buttons}</div>
		<input id="poll-remark" class="poll-remark-input" type="text" maxlength="500" placeholder="Optional remark…">
		<div class="poll-status" id="poll-status">${pollStatusText(initialCount)}</div>`;
	pollActive = true;
	for (const btn of document.querySelectorAll(".poll-option")) {
		btn.addEventListener("click", () => castVote(btn.dataset.key));
	}
}

async function castVote(choice) {
	const remarkEl = document.getElementById("poll-remark");
	const status = document.getElementById("poll-status");
	try {
		const res = await fetch(api("/vote"), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ clientId: CLIENT_ID, choice, remark: remarkEl ? remarkEl.value : "" }),
		});
		if (res.ok) {
			if (pollActive) {
				for (const btn of document.querySelectorAll(".poll-option")) {
					btn.classList.toggle("selected", btn.dataset.key === choice);
				}
			}
			return;
		}
		if (res.status === 401) {
			// Not joined in this session: ask for a name.
			if (status) status.textContent = "Please identify to vote.";
			showIdentifyOverlay();
			return;
		}
		const body = await res.json().catch(() => ({}));
		if (status) status.textContent = `Vote rejected: ${body.error || res.status}`;
	} catch (err) {
		if (status) status.textContent = "Vote failed: network error";
	}
}

function updateIdentityChip() {
	const chip = document.getElementById("identity-chip");
	if (username) {
		chip.textContent = `${username} · switch name`;
		chip.classList.remove("hidden");
	} else {
		chip.classList.add("hidden");
	}
}

function showIdentifyOverlay(prefill) {
	const overlay = document.getElementById("identify-overlay");
	const input = document.getElementById("username-input");
	overlay.classList.remove("hidden");
	input.value = prefill ?? "";
	input.focus();
}

function renderReveal(votes, poll) {
	pollActive = false;
	const card = document.getElementById("poll-card");
	if (!poll) return;
	card.innerHTML = `
		<div class="poll-label">VOTE RESULTS — ${escapeHtml(poll.question)}</div>
		${renderTally(votes, poll.options)}
		<div class="poll-closed-note">Poll closed · Moderator relays the result to Pi</div>`;
}

function clearPollCard() {
	pollActive = false;
	document.getElementById("poll-card").innerHTML = "";
}

function handleEvent(event) {
	if (deadLink) return;
	if (event.type === "invalid_key") {
		deadLink = true;
		document.body.innerHTML = "<main style=\"max-width:680px;margin:80px auto;font-family:Georgia,serif\"><p>This link is not valid for this room.</p></main>";
		return;
	}
	if (event.type === "waiting") {
		document.getElementById("waiting")?.classList.remove("hidden");
		return;
	}
	if (event.type === "snapshot") {
		document.getElementById("waiting")?.classList.add("hidden");
		// A snapshot is the full state (first connect or reconnect after a
		// server restart): rebuild the page, never append on top of it.
		syncIdentity(event.you);
		restoreSnapshot(event.snapshot);
		renderBoard(event.board ?? null);
		const membersEl = document.getElementById("members");
		if (membersEl) {
			const text = membersText(event.members);
			membersEl.textContent = text;
			membersEl.classList.toggle("hidden", text === "");
		}
	} else if (event.type === "transcript_reset") {
		// The session was rewound or forked: rebuild messages and restore the poll.
		restoreSnapshot(event.snapshot);
	} else if (event.type === "transcript_delta") {
		appendMessage(event.message);
	} else if (event.type === "poll_open") {
		renderPollCard(event.poll, 0, event.anchor);
	} else if (event.type === "poll_reveal") {
		// votes arrive with the current poll from the last snapshot/open
		const lastPoll = currentPoll;
		renderReveal(event.votes, lastPoll);
	} else if (event.type === "poll_close") {
		clearPollCard();
		currentPoll = null;
	} else if (event.type === "board") {
		renderBoard(event.screen);
	} else if (event.type === "members") {
		const el = document.getElementById("members");
		if (el) {
			const text = membersText(event);
			el.textContent = text;
			el.classList.toggle("hidden", text === "");
		}
		// a vote changes the member list before reveal: keep the poll card's
		// count in sync without exposing who voted
		if (pollActive && typeof event.voteCount === "number") {
			const status = document.getElementById("poll-status");
			if (status) status.textContent = pollStatusText(event.voteCount);
		}
	}
}

let currentPoll = null;
let currentBoard = null;
let lastRenderedBoard = null;

/** Board screen rendering, per view: the board page shows the screen in
 * its sandboxed iframe; the main page only updates the link state. Never
 * opens windows, switches views, or scrolls by itself. */
function renderBoard(screen) {
	currentBoard = screen;
	if (VIEW === "board") {
		// the container starts hidden in page.html; showing it is this
		// function's job, for the empty state and the frame alike
		document.getElementById("board")?.classList.remove("hidden");
		const empty = document.getElementById("board-empty");
		const frame = document.getElementById("board-frame");
		if (!screen) {
			empty?.classList.remove("hidden");
			frame?.classList.add("hidden");
			frame?.setAttribute("srcdoc", "");
			lastRenderedBoard = null;
			return;
		}
		empty?.classList.add("hidden");
		frame?.classList.remove("hidden");
		const sig = screen.name + "\u0000" + screen.html;
		// reload only when the screen changed, so scripts and selection state
		// survive snapshots and reconnects
		if (sig !== lastRenderedBoard) {
			lastRenderedBoard = sig;
			frame.setAttribute("srcdoc", screen.html);
		}
		localStorage.setItem(boardSeenKey(BASE), screen.name);
	} else {
		updateBoardLink();
	}
}

/** The main page's board link: persistent, with state and a "new" marker. */
function updateBoardLink() {
	const link = document.getElementById("board-link");
	if (!link) return;
	const seen = localStorage.getItem(boardSeenKey(BASE));
	const state = boardLinkState(currentBoard, seen);
	link.classList.toggle("none", state === "none");
	while (link.firstChild) link.removeChild(link.firstChild);
	link.appendChild(document.createTextNode(state === "none" ? "Visual board (nothing shown)" : "Visual board"));
	if (state === "new") {
		const badge = document.createElement("span");
		badge.className = "board-new";
		badge.textContent = "new";
		link.appendChild(badge);
	}
}

const origHandle = handleEvent;
handleEvent = function (event) {
	if (event.type === "snapshot" || event.type === "transcript_reset") currentPoll = event.snapshot.poll;
	if (event.type === "poll_open") currentPoll = event.poll;
	origHandle(event);
};

function restoreSnapshot(snapshot) {
	rebuildTranscript(snapshot.messages);
	if (!snapshot.poll) return;
	positionPollCard(snapshot.pollAnchor ?? snapshot.messages.length);
	if (snapshot.revealed) renderReveal(snapshot.revealed, snapshot.poll);
	else renderPollCard(snapshot.poll, snapshot.voteCount ?? 0, snapshot.pollAnchor ?? snapshot.messages.length);
}

function rebuildTranscript(messages) {
	document.getElementById("transcript").innerHTML = '<div id="poll-card" class="poll-card" aria-live="polite"></div>';
	for (const m of messages) appendMessage(m);
}

function connectEvents() {
	const es = new EventSource(`${api("/events")}&client=${encodeURIComponent(CLIENT_ID)}`);
	es.onmessage = (ev) => {
		reconnectAttempt = 0;
		handleEvent(JSON.parse(ev.data));
	};
	es.onerror = () => {
		// The stream dropped or the relay is restarting. Tell the reader at
		// once; a snapshot after reconnecting hides the banner again.
		document.getElementById("waiting")?.classList.remove("hidden");
		if (es.readyState === EventSource.CLOSED) {
			// EventSource gave up (e.g. the relay answered non-200 while its
			// pod restarts) and will not retry on its own: reconnect ourselves
			// with capped exponential backoff.
			const delay = Math.min(30000, 1000 * 2 ** reconnectAttempt++);
			setTimeout(connectEvents, delay);
		}
	};
}
let reconnectAttempt = 0;

function keyboardShortcuts() {
	if (VIEW === "board") return; // poll keys belong to the main view
	document.addEventListener("keydown", (e) => {
		// live check: the board view hides the transcript, so poll keys must
		// not vote even if this listener outlives a view change
		if (document.body.classList.contains("board-view")) return;
		if (!pollActive) return;
		if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
		const keys = "ABCDEFGHIJ";
		const letters = keys.indexOf(e.key.toUpperCase());
		const digits = "123456789".indexOf(e.key);
		const idx = letters >= 0 ? letters : digits;
		if (idx >= 0) {
			const btn = document.querySelectorAll(".poll-option")[idx];
			if (btn) castVote(btn.dataset.key);
		}
	});
}

function syncIdentity(you) {
	username = you;
	updateIdentityChip();
	if (you || VIEW === "board") {
		// joined already, or the board view: the board never asks for a name
		// in step 1 (nothing to send); voting and joining stay on the main page
		document.getElementById("identify-overlay")?.classList.add("hidden");
	} else {
		showIdentifyOverlay(localStorage.getItem("meeting-mirror-username"));
	}
}

function initIdentify() {
	const overlay = document.getElementById("identify-overlay");
	const input = document.getElementById("username-input");
	const button = document.getElementById("username-button");
	const error = document.getElementById("identify-error");
	const join = async () => {
		const name = input.value.trim();
		if (!name) return;
		if (error) error.textContent = "";
		try {
			const res = await fetch(api("/identify"), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ clientId: CLIENT_ID, username: name }),
			});
			if (res.ok) {
				const { name: accepted } = await res.json();
				localStorage.setItem("meeting-mirror-username", accepted);
				username = accepted;
				overlay.classList.add("hidden");
				updateIdentityChip();
			} else {
				const body = await res.json().catch(() => ({}));
				if (error) error.textContent = body.error ?? `Could not join (${res.status}).`;
			}
		} catch {
			if (error) error.textContent = "Could not join: server unreachable.";
		}
	};
	button.addEventListener("click", join);
	input.addEventListener("keydown", (e) => {
		if (e.key === "Enter") join();
	});
}

function initJumpLatest() {
	const jump = document.getElementById("jump-latest");
	jump.addEventListener("click", () => {
		window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
		jump.classList.add("hidden");
	});
	window.addEventListener("scroll", () => {
		const atBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 80;
		jump.classList.toggle("hidden", atBottom);
	});
}

if (typeof document !== "undefined") {
	if (VIEW === "board") {
		document.body.classList.add("board-view");
	} else {
		const link = document.getElementById("board-link");
		if (link) {
			link.setAttribute("href", `${BASE}/board?key=${encodeURIComponent(KEY)}`);
			updateBoardLink();
			// the board page in another tab of this browser marks the screen
			// seen; a storage event is how we learn about it
			window.addEventListener("storage", (e) => {
				if (e.key === boardSeenKey(BASE)) updateBoardLink();
			});
		}
	}
	document.getElementById("identity-chip").addEventListener("click", () => {
		localStorage.removeItem("meeting-mirror-username");
		username = null;
		updateIdentityChip();
		showIdentifyOverlay();
	});
	initIdentify();
	initJumpLatest();
	keyboardShortcuts();
	connectEvents();
}
