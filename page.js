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
			out.push(`<${tag}>${items.join("")}</${tag}>`);
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

// ---------------------------------------------------------------------------
// Browser wiring below — never executed in Node tests.
// ---------------------------------------------------------------------------

let username = null;
let voteToken = null;
let pollActive = false;
let currentSessionId = null;

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

function renderPollCard(poll, initialCount = 0, anchor = document.querySelectorAll("#transcript > .message").length) {
	positionPollCard(anchor);
	const buttons = poll.options
		.map((o) => `<button class="poll-option" data-key="${escapeHtml(o.key)}">${escapeHtml(o.key)} · ${escapeHtml(o.label)}</button>`)
		.join("");
	document.getElementById("poll-card").innerHTML = `
		<div class="poll-label">VOTE — ${escapeHtml(poll.question)}</div>
		<div class="poll-options">${buttons}</div>
		<input id="poll-remark" class="poll-remark-input" type="text" maxlength="500" placeholder="Optional remark…">
		<div class="poll-status" id="poll-status">${initialCount} votes in · hidden until reveal</div>`;
	pollActive = true;
	for (const btn of document.querySelectorAll(".poll-option")) {
		btn.addEventListener("click", () => castVote(btn.dataset.key));
	}
}

async function castVote(choice) {
	const remarkEl = document.getElementById("poll-remark");
	const status = document.getElementById("poll-status");
	try {
		const res = await fetch("/vote", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ token: voteToken, username, choice, remark: remarkEl ? remarkEl.value : "" }),
		});
		if (res.ok) {
			if (pollActive) {
				for (const btn of document.querySelectorAll(".poll-option")) {
					btn.classList.toggle("selected", btn.dataset.key === choice);
				}
			}
			return;
		}
		const body = await res.json().catch(() => ({}));
		if (res.status === 401 || res.status === 403) {
			// Stale identity (e.g. server restarted): re-identify.
			localStorage.removeItem("meeting-mirror-username");
			localStorage.removeItem("meeting-mirror-token");
			username = null;
			voteToken = null;
			updateIdentityChip();
			if (status) status.textContent = "Please identify again to vote.";
			showIdentifyOverlay();
			return;
		}
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
	if (event.type === "snapshot") {
		// A snapshot is the full state (first connect or reconnect after a
		// server restart): rebuild the page, never append on top of it.
		syncIdentityToSession(event.sessionId);
		restoreSnapshot(event.snapshot);
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
	} else if (event.type === "vote_cast") {
		const status = document.getElementById("poll-status");
		if (status) status.textContent = `${event.count} votes in · hidden until reveal`;
	}
}

let currentPoll = null;
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
	const es = new EventSource("/events");
	es.onmessage = (ev) => handleEvent(JSON.parse(ev.data));
}

function keyboardShortcuts() {
	document.addEventListener("keydown", (e) => {
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

function syncIdentityToSession(sessionId) {
	currentSessionId = sessionId;
	const storedSession = localStorage.getItem("meeting-mirror-session");
	const storedName = localStorage.getItem("meeting-mirror-username");
	const storedToken = localStorage.getItem("meeting-mirror-token");
	if (storedSession === sessionId && storedName && storedToken) {
		// Same server instance: the stored identity is still valid.
		username = storedName;
		voteToken = storedToken;
		updateIdentityChip();
		return;
	}
	// New server instance (restarted pi session): the user has not joined
	// this session. Show the login page, name prefilled for convenience.
	username = null;
	voteToken = null;
	updateIdentityChip();
	showIdentifyOverlay(storedName);
}

function initIdentify() {
	const overlay = document.getElementById("identify-overlay");
	const input = document.getElementById("username-input");
	const button = document.getElementById("username-button");
	const join = async () => {
		const name = input.value.trim();
		if (!name || !currentSessionId) return;
		try {
			const res = await fetch("/identify", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ username: name }),
			});
			if (res.ok) {
				const { token } = await res.json();
				localStorage.setItem("meeting-mirror-username", name);
				localStorage.setItem("meeting-mirror-token", token);
				localStorage.setItem("meeting-mirror-session", currentSessionId);
				username = name;
				voteToken = token;
				overlay.classList.add("hidden");
				updateIdentityChip();
			} else {
				const body = await res.json().catch(() => ({}));
				alert(body.error ? `Could not join: ${body.error}` : "Could not join.");
			}
		} catch {
			alert("Could not join: server unreachable.");
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
	document.getElementById("identity-chip").addEventListener("click", () => {
		localStorage.removeItem("meeting-mirror-username");
		localStorage.removeItem("meeting-mirror-token");
		username = null;
		voteToken = null;
		updateIdentityChip();
		showIdentifyOverlay();
	});
	initIdentify();
	initJumpLatest();
	keyboardShortcuts();
	connectEvents();
}
