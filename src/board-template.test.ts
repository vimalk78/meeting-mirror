import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { BUNDLED_TEMPLATE, companionScriptsDir, loadFrameTemplate } from "./board-template.js";

let tmp: string;

describe("companionScriptsDir", () => {
	it("linux: cwd of a real process", async () => {
		if (process.platform !== "linux") return;
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "mm-cwd-")));
		const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},5000)"], { cwd: dir });
		try {
			expect(companionScriptsDir(child.pid!)).toBe(dir);
		} finally {
			child.kill();
		}
	});

	it("darwin: parses lsof -Fn output", () => {
		expect(companionScriptsDir(1, { platform: "darwin", lsof: () => "p1\nfcwd\nn/opt/sp/scripts\n" })).toBe("/opt/sp/scripts");
	});

	it("unknown platform or failing lookup → null", () => {
		expect(companionScriptsDir(1, { platform: "win32" })).toBeNull();
		expect(
			companionScriptsDir(1, {
				platform: "linux",
				readlink: () => {
					throw new Error("EACCES");
				},
			}),
		).toBeNull();
	});
});

describe("loadFrameTemplate", () => {
	it("uses the companion's template when it has the CONTENT marker", () => {
		tmp = mkdtempSync(join(tmpdir(), "mm-tpl-"));
		writeFileSync(join(tmp, "frame-template.html"), "<b><!-- CONTENT --></b>");
		expect(loadFrameTemplate(1, { platform: "linux", readlink: () => tmp })).toBe("<b><!-- CONTENT --></b>");
		rmSync(tmp, { recursive: true, force: true });
	});

	it("falls back to the bundled copy (no dir, no file, or no marker)", () => {
		expect(loadFrameTemplate(1, { platform: "win32" })).toBe(BUNDLED_TEMPLATE);
		const empty = mkdtempSync(join(tmpdir(), "mm-tpl-"));
		mkdirSync(empty, { recursive: true });
		expect(loadFrameTemplate(1, { platform: "linux", readlink: () => empty })).toBe(BUNDLED_TEMPLATE);
		writeFileSync(join(empty, "frame-template.html"), "<i>no marker</i>");
		expect(loadFrameTemplate(1, { platform: "linux", readlink: () => empty })).toBe(BUNDLED_TEMPLATE);
		rmSync(empty, { recursive: true, force: true });
		expect(BUNDLED_TEMPLATE).toContain("<!-- CONTENT -->");
	});
});
