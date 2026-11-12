import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Hub } from "./hub.js";
import { findActiveSession, newestScreen, pidAlive, type ActiveSession, type ScreenFile } from "./board-discovery.js";
import { loadFrameTemplate } from "./board-template.js";
import { BOARD_HELPER, renderScreen, type BoardScreen } from "./board.js";

/**
 * Watches the project's companion sessions while the mirror is shared and
 * publishes the current screen to the hub as `board` events. Polls every
 * 2 s (a poll is simpler than a filesystem watch and fast enough for a
 * meeting) and emits only when the screen actually changes.
 */
export class BoardWatcher {
	private timer: ReturnType<typeof setTimeout> | null = null;
	/** null: nothing published yet, so the first poll always publishes —
	 * even when it publishes "no screen" (clears a board left by an
	 * earlier share of this session). */
	private lastKey: string | null = null;
	private templateBySession = new Map<string, string>();

	constructor(
		private hub: Hub,
		private projectDir: string,
		private opts: {
			intervalMs?: number;
			isAlive?: (pid: number) => boolean;
			loadTemplate?: (pid: number) => string;
		} = {},
	) {}

	/** Poll once immediately, then every intervalMs. */
	start(): void {
		this.poll();
		this.schedule();
	}

	stop(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}

	/** One poll. Never throws: an error keeps the previous state so the
	 * next poll can retry. */
	poll(): void {
		try {
			this.pollInner();
		} catch {
			// keep lastKey so a transient failure does not re-emit the
			// same screen as a "change" on the next successful poll
		}
	}

	private pollInner(): void {
		const session = findActiveSession(
			join(this.projectDir, ".superpowers", "brainstorm"),
			this.opts.isAlive ?? pidAlive,
		);
		const screen = session ? newestScreen(join(session.dir, "content")) : null;
		const key = session && screen ? `${session.dir}|${screen.name}|${screen.mtimeMs}` : "none";
		if (key === this.lastKey) return;
		// render and publish first: a read error must not commit the key,
		// or the screen would be lost until the file changes again
		const board = session && screen ? this.render(session, screen) : null;
		this.lastKey = key;
		this.hub.setBoard(board);
	}

	private render(session: ActiveSession, screen: ScreenFile): BoardScreen {
		const load = this.opts.loadTemplate ?? ((pid: number) => loadFrameTemplate(pid));
		let template = this.templateBySession.get(session.dir);
		if (template === undefined) {
			template = load(session.pid);
			this.templateBySession.set(session.dir, template);
		}
		return { name: screen.name, html: renderScreen(readFileSync(screen.path, "utf8"), template, BOARD_HELPER) };
	}

	private schedule(): void {
		const interval = this.opts.intervalMs ?? 2000;
		const tick = () => {
			this.poll();
			this.schedule();
		};
		this.timer = setTimeout(tick, interval);
		this.timer.unref?.();
	}
}
