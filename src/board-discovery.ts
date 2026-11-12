import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** A live companion session directory: its path and the server's pid. */
export type ActiveSession = { dir: string; pid: number };

/** A screen file in the session's content/ directory. */
export type ScreenFile = { name: string; path: string; mtimeMs: number };

/** Is the process with this pid running? EPERM (another user's process)
 * still proves it exists. */
export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function readPid(dir: string): number | null {
	try {
		const raw = readFileSync(join(dir, "state", "server.pid"), "utf8").trim();
		const pid = Number.parseInt(raw, 10);
		return Number.isInteger(pid) && pid > 0 ? pid : null;
	} catch {
		return null;
	}
}

/**
 * The active companion session: the newest session directory that has
 * state/server-info, lacks state/server-stopped, and whose server.pid is a
 * running process. Newest by the mtime of server-info. Returns null when
 * no session is active or the brainstorm dir does not exist.
 */
export function findActiveSession(
	brainstormDir: string,
	isAlive: (pid: number) => boolean = pidAlive,
): ActiveSession | null {
	let entries: string[];
	try {
		entries = readdirSync(brainstormDir);
	} catch {
		return null;
	}
	let best: ActiveSession | null = null;
	let bestMtime = -Infinity;
	for (const entry of entries) {
		if (entry.startsWith(".")) continue;
		const dir = join(brainstormDir, entry);
		const infoPath = join(dir, "state", "server-info");
		const stoppedPath = join(dir, "state", "server-stopped");
		try {
			// lstat: a symlinked session dir is not our session
			if (!lstatSync(dir).isDirectory()) continue;
			if (!statSync(infoPath).isFile()) continue;
		} catch {
			continue; // no server-info, or unreadable
		}
		let stopped = false;
		try {
			stopped = statSync(stoppedPath).isFile();
		} catch {
			// no server-stopped: the session is live
		}
		if (stopped) continue;
		const pid = readPid(dir);
		if (pid === null || !isAlive(pid)) continue;
		const mtime = statSync(infoPath).mtimeMs;
		if (mtime > bestMtime) {
			bestMtime = mtime;
			best = { dir, pid };
		}
	}
	return best;
}

/**
 * The current screen: the newest regular .html file (not hidden, not a
 * symlink, not a directory) in the session's content/ directory, by mtime.
 * The companion's rule. Returns null when there is none.
 */
export function newestScreen(contentDir: string): ScreenFile | null {
	let entries: string[];
	try {
		entries = readdirSync(contentDir);
	} catch {
		return null;
	}
	let best: ScreenFile | null = null;
	for (const name of entries) {
		if (name.startsWith(".") || !name.endsWith(".html")) continue;
		const path = join(contentDir, name);
		try {
			// lstat, never stat: a symlinked file must never be read or sent
			if (!lstatSync(path).isFile()) continue;
		} catch {
			continue;
		}
		const mtimeMs = statSync(path).mtimeMs;
		if (!best || mtimeMs > best.mtimeMs) {
			best = { name, path, mtimeMs };
		}
	}
	return best;
}
