(function () {
	// The companion's helper sets the template's status pill from its
	// WebSocket; the board has no socket of its own. The screen arrived
	// through the mirror's live stream, so report Connected the same way.
	var status = document.querySelector(".status");
	if (status) {
		status.textContent = "Connected";
		status.style.setProperty("--status-color", "var(--success)");
	}
	window.selectedChoice = null;
	window.toggleSelect = function (el) {
		const container = el.closest(".options") || el.closest(".cards");
		const multi = container && container.dataset.multiselect !== undefined;
		if (container && !multi) {
			container.querySelectorAll(".option, .card").forEach((o) => o.classList.remove("selected"));
		}
		if (multi) el.classList.toggle("selected");
		else el.classList.add("selected");
		window.selectedChoice = el.dataset.choice;
	};
	// Step 1: participants' clicks stay on their screen.
	window.brainstorm = { send: function () {}, choice: function () {} };
})();
