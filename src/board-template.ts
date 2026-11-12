import { execFileSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Overridable environment, for tests. */
export type TemplateDeps = {
	platform: NodeJS.Platform;
	readlink: (p: string) => string;
	lsof: (pid: number) => string;
};

/** The bundled copy of the companion's frame template (superpowers MIT). */
export const BUNDLED_TEMPLATE = readFileSync(join(HERE, "companion", "frame-template.html"), "utf8");

function lsofCwd(pid: number): string {
	return execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
		encoding: "utf8",
		timeout: 2000,
	});
}

/**
 * The scripts directory of the companion process: start-server.sh cds into
 * its own scripts directory before starting server.cjs, and the server never
 * changes directory, so the process's working directory is that directory.
 * Returns null when it cannot be determined.
 */
export function companionScriptsDir(pid: number, deps?: Partial<TemplateDeps>): string | null {
	const platform = deps?.platform ?? process.platform;
	try {
		if (platform === "linux") {
			return (deps?.readlink ?? ((p: string) => readlinkSync(p)))(`/proc/${pid}/cwd`);
		}
		if (platform === "darwin") {
			const out = (deps?.lsof ?? lsofCwd)(pid);
			const line = out.split("\n").find((l) => l.startsWith("n"));
			return line ? line.slice(1) : null;
		}
	} catch {
		return null;
	}
	return null;
}

/**
 * The frame template to wrap fragments in: the running companion's own
 * copy when it is readable and has the CONTENT marker (so participants
 * see what the moderator sees, whatever superpowers version is installed),
 * otherwise the bundled copy.
 */
export function loadFrameTemplate(pid: number, deps?: Partial<TemplateDeps>): string {
	const dir = companionScriptsDir(pid, deps);
	if (dir) {
		try {
			const tpl = readFileSync(join(dir, "frame-template.html"), "utf8");
			if (tpl.includes("<!-- CONTENT -->")) return tpl;
		} catch {
			// fall through to the bundled copy
		}
	}
	return BUNDLED_TEMPLATE;
}
