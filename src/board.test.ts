import { describe, expect, it } from "vitest";
import { BOARD_HELPER, MAX_SCREEN_BYTES, isFullDocument, renderScreen } from "./board.js";

const T = "<html><body><!-- BRANDING --><main><!-- CONTENT --></main></body></html>";
const H = "/*helper*/";

describe("isFullDocument", () => {
	it("full document: sent as is, helper before </body>", () => {
		expect(renderScreen("  <!DOCTYPE html><html><body>x</body></html>", T, H))
			.toBe("  <!DOCTYPE html><html><body>x<script>\n/*helper*/\n</script>\n</body></html>");
		expect(isFullDocument("\n<HTML>")).toBe(true);
		expect(isFullDocument("<div>")).toBe(false);
	});
});

describe("renderScreen", () => {
	it("fragment: wrapped, branding emptied", () => {
		const out = renderScreen("<h2>Pick</h2>", T, H);
		expect(out).toContain("<main><h2>Pick</h2></main>");
		expect(out).not.toContain("BRANDING");
	});

	it("fragment with $ patterns stays literal", () => {
		expect(renderScreen("a $& b $1 c $'", T, H)).toContain("<main>a $& b $1 c $'</main>");
	});

	it("no </body>: helper appended", () => {
		expect(renderScreen("<!doctype html><p>x", T, H)).toBe("<!doctype html><p>x<script>\n/*helper*/\n</script>");
	});

	it("over 1 MB: replaced by the notice", () => {
		const out = renderScreen("x".repeat(MAX_SCREEN_BYTES + 1), T, H);
		expect(out).toContain("This screen is too large to show here (over 1 MB).");
		expect(Buffer.byteLength(out)).toBeLessThan(2000);
	});
});

describe("BOARD_HELPER", () => {
	it("defines toggleSelect and brainstorm", () => {
		expect(BOARD_HELPER).toContain("window.toggleSelect");
		expect(BOARD_HELPER).toContain("window.brainstorm");
	});
});
