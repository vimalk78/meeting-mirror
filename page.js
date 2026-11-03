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

/** Escape all HTML first, then apply minimal markdown: **bold**, `code`, paragraphs. */
export function renderMarkdown(md) {
	const paragraphs = String(md)
		.split(/\n\s*\n/)
		.map((p) => p.trim())
		.filter(Boolean);
	return paragraphs
		.map((p) => {
			let html = escapeHtml(p);
			html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
			html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
			return `<p>${html}</p>`;
		})
		.join("");
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

function appendMessage(m) {
	const transcript = document.getElementById("transcript");
	const pollCard = document.getElementById("poll-card");
	const atBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 80;
	const jump = document.getElementById("jump-latest");
	// Insert before the poll card so the card always trails the conversation.
	pollCard.insertAdjacentHTML("beforebegin", formatMessage(m));
	if (atBottom) {
		window.scrollTo(0, document.body.scrollHeight);
	} else if (jump) {
		jump.classList.remove("hidden");
	}
}

function renderPollCard(poll) {
	const buttons = poll.options
		.map((o) => `<button class="poll-option" data-key="${escapeHtml(o.key)}">${escapeHtml(o.key)} · ${escapeHtml(o.label)}</button>`)
		.join("");
	document.getElementById("poll-card").innerHTML = `
		<div class="poll-label">VOTE — ${escapeHtml(poll.question)}</div>
		<div class="poll-options">${buttons}</div>
		<input id="poll-remark" class="poll-remark-input" type="text" maxlength="500" placeholder="Optional remark…">
		<div class="poll-status" id="poll-status">0 votes in · hidden until reveal</div>`;
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

function showIdentifyOverlay() {
	const overlay = document.getElementById("identify-overlay");
	const input = document.getElementById("username-input");
	overlay.classList.remove("hidden");
	input.value = "";
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
		document.getElementById("transcript").innerHTML = '<div id="poll-card" class="poll-card" aria-live="polite"></div>';
		for (const m of event.snapshot.messages) appendMessage(m);
		if (event.snapshot.poll && !event.snapshot.revealed) renderPollCard(event.snapshot.poll);
		if (event.snapshot.revealed && event.snapshot.poll) renderReveal(event.snapshot.revealed, event.snapshot.poll);
	} else if (event.type === "transcript_delta") {
		appendMessage(event.message);
	} else if (event.type === "poll_open") {
		renderPollCard(event.poll);
	} else if (event.type === "poll_reveal") {
		// votes arrive with the current poll from the last snapshot/open
		const lastPoll = currentPoll;
		renderReveal(event.votes, lastPoll);
	} else if (event.type === "poll_close") {
		clearPollCard();
	} else if (event.type === "vote_cast") {
		const status = document.getElementById("poll-status");
		if (status) status.textContent = `${event.count} votes in · hidden until reveal`;
	}
}

let currentPoll = null;
const origHandle = handleEvent;
handleEvent = function (event) {
	if (event.type === "snapshot" && event.snapshot.poll) currentPoll = event.snapshot.poll;
	if (event.type === "poll_open") currentPoll = event.poll;
	origHandle(event);
};

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

async function initIdentify() {
	const overlay = document.getElementById("identify-overlay");
	const input = document.getElementById("username-input");
	const button = document.getElementById("username-button");

	// Bind the join handlers FIRST: the eager re-identify path below
	// returns early, and the overlay must still work afterwards when the
	// user clicks "switch name" on the identity chip.
	const join = async () => {
		const name = input.value.trim();
		if (!name) return;
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

	const storedName = localStorage.getItem("meeting-mirror-username");
	if (storedName) {
		// Re-identify on load: server restarts (new pi session, /reload)
		// invalidate stored tokens, and identify is idempotent.
		try {
			const res = await fetch("/identify", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ username: storedName }),
			});
			if (res.ok) {
				const { token } = await res.json();
				localStorage.setItem("meeting-mirror-token", token);
				username = storedName;
				voteToken = token;
				overlay.classList.add("hidden");
				updateIdentityChip();
				return;
			}
		} catch {
			/* fall through to the overlay */
		}
	}
	username = null;
	voteToken = null;
	overlay.classList.remove("hidden");
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
	initIdentify().then(updateIdentityChip);
	initJumpLatest();
	keyboardShortcuts();
	connectEvents();
}
