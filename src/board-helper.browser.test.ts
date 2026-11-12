// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { BOARD_HELPER } from "./board.js";

describe("board helper in a framed screen", () => {
	it("reports Connected in the template's status pill", () => {
		document.body.innerHTML = `<div class="header"><div class="status">Connecting…</div></div>`;
		// The helper is an IIFE meant for a plain <script> tag; run it as one.
		new Function(BOARD_HELPER)();
		const status = document.querySelector(".status") as HTMLElement;
		expect(status.textContent).toBe("Connected");
		expect(status.style.getPropertyValue("--status-color")).toBe("var(--success)");
	});

	it("leaves screens without a status pill alone", () => {
		document.body.innerHTML = `<div class="options"><div class="option" data-choice="a">A</div></div>`;
		expect(() => new Function(BOARD_HELPER)()).not.toThrow();
		// selection still works
		const option = document.querySelector(".option") as HTMLElement;
		(window as any).toggleSelect(option);
		expect(option.classList.contains("selected")).toBe(true);
		expect((window as any).selectedChoice).toBe("a");
	});
});
