import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The screen the page shows: the file name and the rendered HTML. */
export type BoardScreen = { name: string; html: string };

/** Spec: a screen over 1 MB is replaced by a notice. */
export const MAX_SCREEN_BYTES = 1_000_000;

/** The board helper script injected into every screen (step 1: selection
 * works, clicks are not sent anywhere). Read once at module load. */
export const BOARD_HELPER = readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), "companion", "board-helper.js"),
	"utf8",
);

const TOO_LARGE_NOTICE =
	'<!DOCTYPE html><html><body style="font-family:sans-serif;padding:2em"><p>This screen is too large to show here (over 1 MB). The moderator can see it in the companion.</p></body></html>';

/** The companion's rule: a full document starts with <!DOCTYPE or <html
 * (case-insensitive, after leading whitespace); anything else is a fragment. */
export function isFullDocument(raw: string): boolean {
	const trimmed = raw.trimStart().toLowerCase();
	return trimmed.startsWith("<!doctype") || trimmed.startsWith("<html");
}

/** Render a screen the way the companion does: wrap fragments in the frame
 * template (branding emptied, content first marker), then inject the helper
 * before </body> — or append it when the page has no </body>. */
export function renderScreen(raw: string, template: string, helper: string): string {
	let html: string;
	if (isFullDocument(raw)) {
		html = raw;
	} else {
		html = template
			.split("<!-- BRANDING -->")
			.join("")
			.replace("<!-- CONTENT -->", () => raw);
	}
	const injection = `<script>\n${helper}\n</script>`;
	if (html.includes("</body>")) {
		html = html.replace("</body>", injection + "\n</body>");
	} else {
		html += injection;
	}
	if (Buffer.byteLength(html, "utf8") > MAX_SCREEN_BYTES) {
		return TOO_LARGE_NOTICE;
	}
	return html;
}
