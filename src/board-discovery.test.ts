import { describe, expect, it, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findActiveSession, newestScreen, pidAlive } from "./board-discovery.js";

let tmp: string;

function session(id: string, opts: { pid?: number; infoMtime: number; stopped?: boolean }): string {
	const dir = join(tmp, id);
	mkdirSync(join(dir, "state"), { recursive: true });
	mkdirSync(join(dir, "content"), { recursive: true });
	writeFileSync(join(dir, "state", "server-info"), "{}\n");
	utimesSync(join(dir, "state", "server-info"), opts.infoMtime / 1000, opts.infoMtime / 1000);
	if (opts.stopped) writeFileSync(join(dir, "state", "server-stopped"), "{}\n");
	if (opts.pid !== undefined) writeFileSync(join(dir, "state", "server.pid"), `${opts.pid}\n`);
	return dir;
}

function screen(dir: string, name: string, mtime: number): void {
	writeFileSync(join(dir, name), "x");
	utimesSync(join(dir, name), mtime / 1000, mtime / 1000);
}

describe("findActiveSession", () => {
	it("missing brainstorm dir → null", () => {
		tmp = mkdtempSync(join(tmpdir(), "mm-board-"));
		expect(findActiveSession(join(tmp, "nope"))).toBeNull();
	});

	it("picks the newest live session", () => {
		session("a", { pid: 11, infoMtime: 1000 });
		session("b", { pid: 22, infoMtime: 2000 });
		expect(findActiveSession(tmp, () => true)).toEqual({ dir: join(tmp, "b"), pid: 22 });
	});

	it("skips stopped, dead, and pid-less sessions", () => {
		session("a", { pid: 11, infoMtime: 1000 });
		session("b", { pid: 22, infoMtime: 3000, stopped: true });
		session("c", { pid: 33, infoMtime: 2000 }); // dead
		session("d", { infoMtime: 4000 }); // no server.pid
		expect(findActiveSession(tmp, (pid) => pid !== 33)?.pid).toBe(11);
	});
});

describe("newestScreen", () => {
	it("newest .html by mtime; hidden, non-html, symlinks, dirs ignored", () => {
		const content = session("scr", { pid: 1, infoMtime: 1000 }) + "/content";
		screen(content, "old.html", 1000);
		screen(content, "new.html", 2000);
		screen(content, ".hidden.html", 9000);
		screen(content, "notes.txt", 9000);
		symlinkSync("/etc/hostname", join(content, "link.html"));
		mkdirSync(join(content, "sub.html"));
		expect(newestScreen(content)?.name).toBe("new.html");
	});

	it("empty or missing dir → null", () => {
		const content = session("empty", { pid: 1, infoMtime: 1000 }) + "/content";
		expect(newestScreen(content)).toBeNull();
		expect(newestScreen(join(tmp, "gone"))).toBeNull();
	});
});

describe("pidAlive", () => {
	it("own pid true, unused pid false", () => {
		expect(pidAlive(process.pid)).toBe(true);
		expect(pidAlive(2 ** 22 + 12345)).toBe(false);
	});
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));
