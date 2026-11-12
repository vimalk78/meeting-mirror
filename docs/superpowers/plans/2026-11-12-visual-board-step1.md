# Visual Board (Step 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Participants see the brainstorming companion's current screen on a separate board page, reached from an always-visible link on the main mirror page, in relay mode and local mode.

**Architecture:** While the session is shared, a `BoardWatcher` in the extension polls `<cwd>/.superpowers/brainstorm/` every 2 s. It finds the live companion session and its newest screen, renders the screen the way the companion does (with a local board helper script instead of `helper.js`), and hands it to the `Hub`. The `Hub` emits a `board` event and puts the screen in every snapshot, so it travels through both transports like transcript events. The page has a board view at `<base>/board` that shows the screen in a sandboxed iframe. The main view shows a status link to it.

**Tech Stack:** TypeScript (Node, pi extension), `node:fs`, plain browser JS (`page/page.js`), vitest + jsdom.

**Spec:** `docs/superpowers/specs/2026-11-11-visual-board-design.md`. This plan covers "Step 1: everyone sees the board" only. Step 2 (clicks) is a later plan.

## Global Constraints

- Discovery dir: `<pi cwd>/.superpowers/brainstorm/`. Active session: has `state/server-info`, has no `state/server-stopped`, and the pid in `state/server.pid` is alive. Newest such session wins, by the mtime of `state/server-info`.
- Current screen: the newest regular file (not a symlink) in `content/` whose name ends in `.html` and does not start with `.`, by mtime.
- Full document: the content after leading whitespace starts with `<!doctype` or `<html`, case-insensitive. Otherwise it is a fragment and is wrapped in the template.
- Wrapping: `<!-- BRANDING -->` → `""` (all occurrences), first `<!-- CONTENT -->` → fragment, using a function replacer so `$` sequences in the fragment stay literal.
- Helper injection: before the first `</body>` if present, else appended. Same rule as the companion.
- Poll interval: 2000 ms. The template is read once per companion session.
- Screen size limit: 1 000 000 bytes (UTF-8) of rendered HTML. Over that, the screen is replaced by the notice page (exact copy in Task 1).
- Event: `{ type: "board", screen: { name, html } | null }`. `name` is the screen file name. The snapshot carries `board: BoardScreen | null`.
- Board page URL: relay `/s/<name>/board?key=<key>`, local `/board?key=<key>`. The relay and the LocalServer serve the same `page.html` for it.
- iframe: `sandbox="allow-scripts"` exactly. Never `allow-same-origin`. Content goes in `srcdoc`.
- Main-page link text, exact: `Visual board (nothing shown)` (no screen), `Visual board` (screen), plus a `new` marker when the screen name differs from the last one this browser's board page showed. `target="_blank" rel="noopener"`.
- Empty board text, exact: `Nothing on the board yet`.
- Local storage key for "seen": `meeting-mirror-board-seen:<BASE>` (BASE is `""` locally, `/s/<name>` on the relay).
- The pages never open windows, switch views, or scroll by themselves.
- Bundled template: a copy of superpowers `skills/brainstorming/scripts/frame-template.html` (superpowers commit `22f0b46`) with the superpowers MIT `LICENSE` next to it.
- Run tests with `npx vitest run`. Type-check with `npx tsc --noEmit` and `npx tsc --noEmit -p relay`.

## Review Focus

- **Fragment containing `$&`, `$1` or `$'`.** Expected: rendered literally, not expanded by `String.replace`. Test: Task 1.
- **A symlink in `content/` (e.g. `x.html -> ~/.ssh/id_rsa`).** Expected: ignored, never read or sent to participants. Test: Task 2.
- **Screen deleted or the brainstorm dir removed between two polls, or a read error.** Expected: the poll does not throw (a throw in a timer would crash pi). The board goes to `null` or stays as it was. Test: Task 5.
- **Poll keys on the board page while a poll is open.** The board view keeps the transcript hidden, so pressing `A` must not cast a vote nobody sees. Test: Task 7.
- **A relay room literally named `board`.** Expected: `/s/board` is that room's main page, and `/s/board/board` is its board page. Test: Task 7.

---

### Task 1: Render a screen like the companion

**Files:**
- Create: `src/board.ts`
- Create: `src/companion/board-helper.js`
- Test: `src/board.test.ts`

**Interfaces:**
- Produces:
  - `export type BoardScreen = { name: string; html: string }`
  - `export const MAX_SCREEN_BYTES = 1_000_000`
  - `export const BOARD_HELPER: string`, the content of `src/companion/board-helper.js`, read once at module load with `readFileSync` relative to `import.meta.url`
  - `export function isFullDocument(raw: string): boolean`
  - `export function renderScreen(raw: string, template: string, helper: string): string`

- [ ] **Step 1: Write the failing tests** in `src/board.test.ts`:

```ts
const T = "<html><body><!-- BRANDING --><main><!-- CONTENT --></main></body></html>";
const H = "/*helper*/";

it("full document: sent as is, helper before </body>", () => {
	expect(renderScreen("  <!DOCTYPE html><html><body>x</body></html>", T, H))
		.toBe("  <!DOCTYPE html><html><body>x<script>\n/*helper*/\n</script>\n</body></html>");
	expect(isFullDocument("\n<HTML>")).toBe(true);
	expect(isFullDocument("<div>")).toBe(false);
});
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
it("BOARD_HELPER defines toggleSelect and brainstorm", () => {
	expect(BOARD_HELPER).toContain("window.toggleSelect");
	expect(BOARD_HELPER).toContain("window.brainstorm");
});
```

- [ ] **Step 2: Run the tests and check they fail**

Run: `npx vitest run src/board.test.ts`
Expected: FAIL, cannot resolve `./board.js`.

- [ ] **Step 3: Write `src/companion/board-helper.js`**

This is the step 1 helper. Selection behaviour is the same as the companion's `helper.js` (lines 144–167 of superpowers `22f0b46`). Clicks are not sent anywhere yet:

```js
(function () {
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
```

- [ ] **Step 4: Implement `src/board.ts`**

`renderScreen` wraps fragments, then injects `<script>\n${helper}\n</script>` with the `</body>` rule (`+ "\n</body>"` after the script, as the tests show). It then checks `Buffer.byteLength(result, "utf8") > MAX_SCREEN_BYTES`. When the limit is exceeded it returns this exact notice:

```html
<!DOCTYPE html><html><body style="font-family:sans-serif;padding:2em"><p>This screen is too large to show here (over 1 MB). The moderator can see it in the companion.</p></body></html>
```

- [ ] **Step 5: Run the tests and check they pass**

Run: `npx vitest run src/board.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/board.ts src/board.test.ts src/companion/board-helper.js
git commit -m "feat: render companion screens for the visual board"
```

---

### Task 2: Find the active companion session and its current screen

**Files:**
- Create: `src/board-discovery.ts`
- Test: `src/board-discovery.test.ts`

**Interfaces:**
- Produces:
  - `export type ActiveSession = { dir: string; pid: number }`
  - `export type ScreenFile = { name: string; path: string; mtimeMs: number }`
  - `export function pidAlive(pid: number): boolean`: `process.kill(pid, 0)`. True on success or on `EPERM`, false otherwise.
  - `export function findActiveSession(brainstormDir: string, isAlive?: (pid: number) => boolean): ActiveSession | null`
  - `export function newestScreen(contentDir: string): ScreenFile | null`

- [ ] **Step 1: Write the failing tests**

Use a temp dir (`mkdtempSync`) and a helper `session(id, { info, stopped, pid, infoMtime })`. The helper creates `<id>/state/server-info`, an optional `server-stopped`, `server.pid` and `content/`, and sets the mtime of `server-info` with `utimesSync`. Tests:

```ts
it("missing brainstorm dir → null", () => expect(findActiveSession(join(tmp, "nope"))).toBeNull());
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
it("newestScreen: newest .html by mtime; hidden, non-html, symlinks, dirs ignored", () => {
	// write old.html (mtime 1000), new.html (2000), .hidden.html (9000), notes.txt (9000),
	// link.html -> /etc/hostname (symlink), sub.html/ (a directory)
	expect(newestScreen(content)?.name).toBe("new.html");
});
it("newestScreen: empty or missing dir → null", () => { /* both */ });
it("pidAlive: own pid true, unused pid false", () => {
	expect(pidAlive(process.pid)).toBe(true);
	expect(pidAlive(2 ** 22 + 12345)).toBe(false);
});
```

- [ ] **Step 2: Run the tests and check they fail**

Run: `npx vitest run src/board-discovery.test.ts`
Expected: FAIL, cannot resolve the module.

- [ ] **Step 3: Implement `src/board-discovery.ts`**

Use `readdirSync` and `lstatSync`, and accept only `isFile()`. Never follow symlinks. Parse `server.pid` with `Number.parseInt` and require a positive integer. Any `ENOENT` returns `null` rather than throwing.

- [ ] **Step 4: Run the tests and check they pass**

Run: `npx vitest run src/board-discovery.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/board-discovery.ts src/board-discovery.test.ts
git commit -m "feat: find the live companion session and its current screen"
```

---

### Task 3: Load the frame template from the running companion

**Files:**
- Create: `src/board-template.ts`
- Create: `src/companion/frame-template.html` (copy)
- Create: `src/companion/LICENSE-superpowers` (copy)
- Test: `src/board-template.test.ts`

**Interfaces:**
- Produces:
  - `export type TemplateDeps = { platform: NodeJS.Platform; readlink: (p: string) => string; lsof: (pid: number) => string }`
  - `export function companionScriptsDir(pid: number, deps?: Partial<TemplateDeps>): string | null`
  - `export function loadFrameTemplate(pid: number, deps?: Partial<TemplateDeps>): string`: returns the companion's `frame-template.html` if it is readable and contains `<!-- CONTENT -->`, otherwise the bundled copy.
  - `export const BUNDLED_TEMPLATE: string`

- [ ] **Step 1: Copy the bundled files**

```bash
mkdir -p src/companion
SP=~/.pi/agent/git/github.com/obra/superpowers
cp $SP/skills/brainstorming/scripts/frame-template.html src/companion/frame-template.html
cp $SP/LICENSE src/companion/LICENSE-superpowers
```

Add one line at the top of `LICENSE-superpowers`: `frame-template.html is copied from obra/superpowers (commit 22f0b46) under this license.`

- [ ] **Step 2: Write the failing tests**

```ts
it("linux: cwd of a real process", async () => {
	if (process.platform !== "linux") return;
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "mm-cwd-")));
	const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},5000)"], { cwd: dir });
	try { expect(companionScriptsDir(child.pid!)).toBe(dir); } finally { child.kill(); }
});
it("darwin: parses lsof -Fn output", () => {
	expect(companionScriptsDir(1, { platform: "darwin", lsof: () => "p1\nfcwd\nn/opt/sp/scripts\n" })).toBe("/opt/sp/scripts");
});
it("unknown platform or failing lookup → null", () => {
	expect(companionScriptsDir(1, { platform: "win32" })).toBeNull();
	expect(companionScriptsDir(1, { platform: "linux", readlink: () => { throw new Error("EACCES"); } })).toBeNull();
});
it("uses the companion's template when it has the CONTENT marker", () => {
	// dir with frame-template.html = "<b><!-- CONTENT --></b>"
	expect(loadFrameTemplate(1, { platform: "linux", readlink: () => dir })).toBe("<b><!-- CONTENT --></b>");
});
it("falls back to the bundled copy (no dir, no file, or no marker)", () => {
	expect(loadFrameTemplate(1, { platform: "win32" })).toBe(BUNDLED_TEMPLATE);
	expect(BUNDLED_TEMPLATE).toContain("<!-- CONTENT -->");
});
```

- [ ] **Step 3: Run the tests and check they fail**

Run: `npx vitest run src/board-template.test.ts`
Expected: FAIL, cannot resolve the module.

- [ ] **Step 4: Implement `src/board-template.ts`**

- Linux: `readlink(`/proc/${pid}/cwd`)`.
- macOS: `lsof`, defaulting to `execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8", timeout: 2000 })`. Take the first line that starts with `n` and drop the `n`.
- Any other platform, or any throw: return `null`.
- Read `BUNDLED_TEMPLATE` once at module load.

- [ ] **Step 5: Run the tests and check they pass**

Run: `npx vitest run src/board-template.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/board-template.ts src/board-template.test.ts src/companion/frame-template.html src/companion/LICENSE-superpowers
git commit -m "feat: frame template from the running companion, bundled copy as fallback"
```

---

### Task 4: Hub carries the board

**Files:**
- Modify: `src/hub.ts` (`SnapshotEvent`, `HubEvent`, `open`, new `setBoard`)
- Test: `src/hub.test.ts`

**Interfaces:**
- Consumes: `BoardScreen` from `src/board.ts` (Task 1).
- Produces:
  - `SnapshotEvent` gains `board: BoardScreen | null`
  - `HubEvent` gains `| { type: "board"; screen: BoardScreen | null }`
  - `Hub.setBoard(screen: BoardScreen | null): void`: stores the screen and emits the event
  - `Hub.board: BoardScreen | null` (readonly getter)

- [ ] **Step 1: Write the failing tests** in `src/hub.test.ts`:

```ts
it("board: null in the first snapshot, then set and emitted, and in later snapshots", () => {
	const hub = new Hub(new MirrorState());
	expect(hub.open("c1").snapshot.board).toBeNull();
	const seen: unknown[] = [];
	hub.subscribe((e) => seen.push(e));
	const screen = { name: "a.html", html: "<p>a</p>" };
	hub.setBoard(screen);
	expect(seen).toContainEqual({ type: "board", screen });
	expect(hub.open("c2").snapshot.board).toEqual(screen);
	hub.setBoard(null);
	expect(seen).toContainEqual({ type: "board", screen: null });
});
```

- [ ] **Step 2: Run the test and check it fails**

Run: `npx vitest run src/hub.test.ts`
Expected: FAIL, `setBoard` is not a function.

- [ ] **Step 3: Implement in `src/hub.ts`**

Add a private field, the getter, `setBoard`, and `board: this.boardScreen` in `open()`.

- [ ] **Step 4: Run the hub, transport and relay-client tests, and type-check**

Run: `npx vitest run src/hub.test.ts src/transport.test.ts src/relay-client.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors. `RelayClient.onHubEvent` already forwards every non-snapshot event, so `board` reaches the relay without changes.

- [ ] **Step 5: Commit**

```bash
git add src/hub.ts src/hub.test.ts
git commit -m "feat: hub keeps the current board screen and sends it in snapshots"
```

---

### Task 5: BoardWatcher polls and feeds the hub, wired to sharing

**Files:**
- Create: `src/board-watcher.ts`
- Modify: `src/index.ts` (start on share, stop on unshare, on lost room, and on shutdown)
- Test: `src/board-watcher.test.ts`

**Interfaces:**
- Consumes: `Hub.setBoard` (Task 4), `findActiveSession`, `newestScreen`, `pidAlive` (Task 2), `loadFrameTemplate` (Task 3), `renderScreen`, `BOARD_HELPER` (Task 1).
- Produces:
  - `export class BoardWatcher { constructor(hub: Hub, projectDir: string, opts?: { intervalMs?: number; isAlive?: (pid: number) => boolean; loadTemplate?: (pid: number) => string }); start(): void; stop(): void; poll(): void }`
  - `start()` polls once immediately, then every `intervalMs` (default 2000), with the timer `unref()`ed. `stop()` clears the timer and leaves the hub's board as it is.

- [ ] **Step 1: Write the failing tests**

Use a temp project dir with `.superpowers/brainstorm/<id>/{state,content}`, `isAlive: () => true`, and `loadTemplate: () => "<body><!-- BRANDING --><!-- CONTENT --></body>"`. Call `poll()` directly:

```ts
it("no session → board stays null, no event", () => { /* poll; expect events [] and hub.board null */ });
it("new screen → one board event with rendered html", () => {
	// write content/a.html = "<p>A</p>"; poll()
	expect(events).toEqual([{ type: "board", screen: { name: "a.html", html: expect.stringContaining("<p>A</p>") } }]);
});
it("unchanged screen → no second event; rewritten (new mtime) → event", () => { /* poll twice; utimes; poll */ });
it("session stops → board null event", () => { /* write state/server-stopped; poll */ });
it("template loaded once per session", () => { /* spy loadTemplate; three polls, two screens → called once */ });
it("errors never escape poll()", () => {
	// loadTemplate throws; and separately: rm the whole brainstorm dir between polls
	expect(() => watcher.poll()).not.toThrow();
});
```

- [ ] **Step 2: Run the tests and check they fail**

Run: `npx vitest run src/board-watcher.test.ts`
Expected: FAIL, cannot resolve the module.

- [ ] **Step 3: Implement `src/board-watcher.ts`**

- Change key: `${session.dir}|${screen.name}|${screen.mtimeMs}`, or `"none"` when there is no session or no screen.
- Emit only when the key changes.
- Cache the template by `session.dir`.
- Wrap the whole poll in `try/catch` and keep the previous key on error, so the next poll retries.

- [ ] **Step 4: Wire it into `src/index.ts`**

- Add `let board: BoardWatcher | null = null;`.
- Add `cwd: string` to the `startSharing` ctx parameter type.
- After a successful local `server.start()`, and after `server = client` in relay mode: `board = new BoardWatcher(hub!, ctx.cwd); board.start();`.
- In `stopSharing`, in the relay `onLost` callback, and in `session_shutdown`: `board?.stop(); board = null;`.

- [ ] **Step 5: Run the tests and type-check**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/board-watcher.ts src/board-watcher.test.ts src/index.ts
git commit -m "feat: watch the companion while shared and publish its screen"
```

---

### Task 6: Serve the board page locally and on the relay

**Files:**
- Modify: `src/transport.ts:101` (`handle`: GET `/board`)
- Modify: `relay/src/server.ts:323-335` (route regex and GET of action `board`)
- Test: `src/transport.test.ts`, `relay/src/server.test.ts`

**Interfaces:**
- Produces: `GET /board` (LocalServer, key or cookie required, same as `/`) and `GET /s/<name>/board` (relay, no key needed, same as `/s/<name>`). Both serve `page.html`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/transport.test.ts
it("serves the board page with the key, rejects without", async () => {
	const { base, key } = await start();
	const ok = await fetch(`${base}/board?key=${key}`);
	expect(ok.status).toBe(200);
	expect(await ok.text()).toContain("/page.js");
	expect((await fetch(`${base}/board`)).status).toBe(403);
});
// relay/src/server.test.ts, in "relay HTTP"
it("serves the board page; unknown sub-paths 404", async () => {
	const { base } = await startRelay();
	const res = await fetch(`${base}/s/ols-4596/board`);
	expect(res.status).toBe(200);
	expect(await res.text()).toContain("/page.js");
	expect((await fetch(`${base}/s/board/board`)).status).toBe(200);
	expect((await fetch(`${base}/s/ols-4596/boardx`)).status).toBe(404);
});
```

- [ ] **Step 2: Run the tests and check they fail**

Run: `npx vitest run src/transport.test.ts relay/src/server.test.ts`
Expected: FAIL (404 for `/board` and `/s/ols-4596/board`).

- [ ] **Step 3: Implement**

- LocalServer: treat `/board` like `/`.
- Relay: regex `(\/(events|identify|vote|board))?`, and serve `page.html` when `req.method === "GET" && (!action || action === "board")`.

- [ ] **Step 4: Run the tests and type-check**

Run: `npx vitest run src/transport.test.ts relay/src/server.test.ts && npx tsc --noEmit -p relay`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/transport.ts src/transport.test.ts relay/src/server.ts relay/src/server.test.ts
git commit -m "feat: serve the board page locally and on the relay"
```

---

### Task 7: Page: board view and status link

**Files:**
- Modify: `page/page.html` (link, board container)
- Modify: `page/page.js` (view detection, board rendering, link state, keyboard guard, identify guard)
- Modify: `page/page.css` (link, board view)
- Test: `src/page.browser.test.ts`, `src/index.test.ts` (pure helpers)

**Interfaces:**
- Consumes: `board` events and `snapshot.board` (Task 4), and the `/board` routes (Task 6).
- Produces, exported from `page/page.js` for tests:
  - `export function pageView(pathname: string): { view: "main" | "board"; base: string }`
  - `export function boardLinkState(screen: {name:string}|null, seenName: string|null): "none" | "active" | "new"`

**Markup** (add to `page/page.html`, and to the `reset()` body in `page.browser.test.ts`):

```html
<a id="board-link" class="board-link none" target="_blank" rel="noopener">Visual board (nothing shown)</a>
<div id="board" class="board hidden">
	<p id="board-empty" class="board-empty">Nothing on the board yet</p>
	<iframe id="board-frame" class="board-frame hidden" sandbox="allow-scripts" title="Visual board"></iframe>
</div>
```

- [ ] **Step 1: Write the failing tests**

Pure helpers (`src/index.test.ts`, which already imports from `page.js`):

```ts
it("pageView", () => {
	expect(pageView("/")).toEqual({ view: "main", base: "" });
	expect(pageView("/board")).toEqual({ view: "board", base: "" });
	expect(pageView("/s/ols-4596")).toEqual({ view: "main", base: "/s/ols-4596" });
	expect(pageView("/s/ols-4596/board")).toEqual({ view: "board", base: "/s/ols-4596" });
	expect(pageView("/s/board")).toEqual({ view: "main", base: "/s/board" });
	expect(pageView("/s/board/board/")).toEqual({ view: "board", base: "/s/board" });
});
it("boardLinkState", () => {
	expect(boardLinkState(null, "a.html")).toBe("none");
	expect(boardLinkState({ name: "a.html" }, "a.html")).toBe("active");
	expect(boardLinkState({ name: "b.html" }, "a.html")).toBe("new");
	expect(boardLinkState({ name: "a.html" }, null)).toBe("new");
});
```

Browser wiring (`src/page.browser.test.ts`):

```ts
const screen = { name: "a.html", html: "<p>A</p>" };
it("main view: link always present, href to board, text follows state", async () => {
	await reset("/s/ols-4596?key=K"); await boot("/s/ols-4596?key=K");
	const link = document.getElementById("board-link") as HTMLAnchorElement;
	expect(link.getAttribute("href")).toBe("/s/ols-4596/board?key=K");
	send({ type: "snapshot", sessionId: "s", you: "Ann", snapshot: emptySnapshot, members: { members: [], voteCount: null }, board: null });
	expect(link.textContent).toBe("Visual board (nothing shown)");
	send({ type: "board", screen });
	expect(link.textContent).toContain("Visual board");
	expect(link.querySelector(".board-new")?.textContent).toBe("new");
	localStorage.setItem("meeting-mirror-board-seen:/s/ols-4596", "a.html");
	window.dispatchEvent(new StorageEvent("storage", { key: "meeting-mirror-board-seen:/s/ols-4596" }));
	expect(link.querySelector(".board-new")).toBeNull();
});
it("board view: empty text, then sandboxed srcdoc, marks seen; same screen does not reload", async () => {
	await reset("/s/ols-4596/board?key=K"); await boot("/s/ols-4596/board?key=K");
	expect(stream.src.startsWith("/s/ols-4596/events?key=K&client=")).toBe(true);
	expect(document.body.classList.contains("board-view")).toBe(true);
	send({ type: "snapshot", sessionId: "s", you: null, snapshot: emptySnapshot, members: { members: [], voteCount: null }, board: null });
	expect(document.getElementById("board-empty")!.classList.contains("hidden")).toBe(false);
	expect(document.getElementById("identify-overlay")!.classList.contains("hidden")).toBe(true);
	send({ type: "board", screen });
	const frame = document.getElementById("board-frame") as HTMLIFrameElement;
	expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
	expect(frame.getAttribute("srcdoc")).toBe("<p>A</p>");
	expect(localStorage.getItem("meeting-mirror-board-seen:/s/ols-4596")).toBe("a.html");
	const setter = vi.spyOn(frame, "setAttribute");
	send({ type: "snapshot", sessionId: "s", you: null, snapshot: emptySnapshot, members: { members: [], voteCount: null }, board: screen });
	expect(setter).not.toHaveBeenCalledWith("srcdoc", expect.anything());
});
it("board view: poll keys do not vote", async () => {
	await reset("/board?key=K"); await boot("/board?key=K");
	send({ type: "snapshot", sessionId: "s", you: "Ann", snapshot: { ...emptySnapshot, poll, voteCount: 0, pollAnchor: 0 }, members: { members: [], voteCount: 0 }, board: null });
	document.dispatchEvent(new KeyboardEvent("keydown", { key: "A" }));
	expect(fetchCalls.some((c) => c.url.includes("/vote"))).toBe(false);
});
```

(`emptySnapshot = { messages: [], poll: null, revealed: null, voteCount: null, pollAnchor: null }`. Define it next to `poll` at the top of the file if it is not there yet.)

- [ ] **Step 2: Run the tests and check they fail**

Run: `npx vitest run src/index.test.ts src/page.browser.test.ts`
Expected: FAIL, `pageView` is not exported, and `#board-link` behaviour is missing.

- [ ] **Step 3: Implement in `page/page.js`**

- `pageView`: strip one trailing `/`, then match `/^(\/s\/[a-z0-9-]{3,30})?\/board$/`. A match gives `view: "board"` with `base` set to the group, or `""`. Otherwise `view: "main"` and `base` is the path. Replace the current `PATH`/`BASE` lines with `const { view: VIEW, base: BASE } = hasWindow ? pageView(location.pathname) : { view: "main", base: "" };`.
- **Board view setup:** `document.body.classList.add("board-view")` at boot.
  - `syncIdentity` must not show the overlay in the board view.
  - `keyboardShortcuts` returns early when `VIEW === "board"`.
- **`renderBoard(screen)`:**
  - **Board view, no screen:** show `#board-empty`, hide the frame, and set `srcdoc` to `""`.
  - **Board view, a screen:** set `srcdoc` with `frame.setAttribute("srcdoc", …)` (the test spies on it), only when `screen.name + screen.html` differs from the last value rendered. Store the name in the seen key.
  - **Main view:** update the link instead. Set its class to the `boardLinkState` result. The text is `Visual board (nothing shown)` for `none`, otherwise `Visual board`. For `new`, add `<span class="board-new">new</span>`. Build the link content with DOM methods, not with screen names inside `innerHTML`.
- **Events:** call `renderBoard` from the `snapshot` branch (`event.board ?? null`) and from a new `board` branch.
- **Storage:** the main view keeps the last screen and re-runs the link update on a `storage` event for the seen key.
- **Link `href`:** set at boot to `${BASE}/board?key=${encodeURIComponent(KEY)}`.

- [ ] **Step 4: Implement in `page/page.css`**

- `.board-link`: a small fixed link in the top-right corner, in the identity-chip style. `.none` uses `color: var(--muted)`. `.board-new` is a small `var(--accent)` pill.
- `body.board-view`: hide `.transcript`, `#members`, `#jump-latest`, `#board-link`, and the identity chip. Show `.board`.
- `.board-frame`: `position: fixed; inset: 0; width: 100%; height: 100%; border: 0`.
- `.board-empty`: centred and muted.

- [ ] **Step 5: Run all tests**

Run: `npx vitest run`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add page/page.html page/page.js page/page.css src/page.browser.test.ts src/index.test.ts
git commit -m "feat: board page and always-visible board link on the mirror page"
```

---

### Task 8: End-to-end check and README

**Files:**
- Modify: `README.md` (a "Visual board" section)

- [ ] **Step 1: Add the README section**

Cover four points:
- what the board shows: the companion's current screen, read-only in step 1
- that it needs the brainstorming companion started with `--project-dir` set to pi's working directory
- the link on the mirror page, and the board URL
- that screens may load external resources (the participants' IP addresses become visible to those sites)

- [ ] **Step 2: Full check**

Run: `npx vitest run && npx tsc --noEmit && npx tsc --noEmit -p relay`
Expected: all PASS, no type errors.

- [ ] **Step 3: Manual end-to-end check, local mode**

In a scratch project dir:
1. Start pi and run `/mirror share`. Open the printed page URL.
   Expect: link `Visual board (nothing shown)`.
2. Click the link.
   Expect: the board page in a new tab shows `Nothing on the board yet`.
3. Start the companion:
   ```bash
   ~/.pi/agent/git/github.com/obra/superpowers/skills/brainstorming/scripts/start-server.sh --project-dir "$PWD"
   ```
   Write `.superpowers/brainstorm/<id>/content/one.html` with `<h2>Pick</h2><div class="options"><div class="option" data-choice="a" onclick="toggleSelect(this)">A</div></div>`.
   Expect: within about 2 s the board page shows it in the companion's frame style, and clicking A highlights it. The main page link shows `Visual board` with no `new` marker, because the board tab already showed the screen.
4. Close the board tab and write `two.html`.
   Expect: the main page link shows `new`.
5. Stop the companion with `stop-server.sh`.
   Expect: the board page shows `Nothing on the board yet` again.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: visual board in the README"
```

The relay must be redeployed for relay mode, because it serves its own copy of `page/`. Do that after merge, as part of the usual relay deploy.
