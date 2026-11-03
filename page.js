// Meeting Mirror page — minimal version: username prompt, SSE, transcript.
// Poll UI arrives in a later task; poll events are tolerated as no-ops.

export function escapeHtml(s) {
	return s
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function formatTimestamp(ts) {
	return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatMessage(m) {
	const el = document.createElement("div");
	el.className = `message ${m.role}`;
	el.innerHTML = `<div class="label">${m.role === "user" ? "Moderator" : "Pi"} · ${formatTimestamp(m.timestamp)}</div><p class="text"></p>`;
	el.querySelector(".text").textContent = m.text;
	return el;
}

function appendMessage(m) {
	const transcript = document.getElementById("transcript");
	transcript.appendChild(formatMessage(m));
}

function connectEvents() {
	const es = new EventSource("/events");
	es.onmessage = (ev) => {
		const event = JSON.parse(ev.data);
		if (event.type === "snapshot") {
			for (const m of event.snapshot.messages) appendMessage(m);
			// poll state in snapshot: tolerated as no-op in this version
		} else if (event.type === "transcript_delta") {
			appendMessage(event.message);
		}
		// poll_open / poll_reveal / poll_close: no-ops in this version
	};
	es.onerror = () => {
		// EventSource auto-reconnects; snapshot on reconnect re-syncs.
	};
}

function initIdentify() {
	const overlay = document.getElementById("identify-overlay");
	const input = document.getElementById("username-input");
	const button = document.getElementById("username-button");
	const saved = localStorage.getItem("meeting-mirror-username");
	if (saved) {
		overlay.classList.add("hidden");
		return;
	}
	overlay.classList.remove("hidden");
	const join = async () => {
		const name = input.value.trim();
		if (!name) return;
		const res = await fetch("/identify", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ username: name }),
		});
		if (res.ok) {
			localStorage.setItem("meeting-mirror-username", name);
			overlay.classList.add("hidden");
		}
	};
	button.addEventListener("click", join);
	input.addEventListener("keydown", (e) => {
		if (e.key === "Enter") join();
	});
}

initIdentify();
connectEvents();
