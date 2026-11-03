# Meeting Mirror Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pi extension that serves the live brainstorming conversation as a web page with planning-poker voting.

**Architecture:** An in-process pi extension directory. A session-state module holds the transcript log and poll state; a pluggable transport serves the page and streams events over SSE; commands drive voting. An LLM side-channel extracts `{question, options[]}` from an assistant message on `/poll`. The page is plain HTML/CSS/JS read from disk.

**Tech Stack:** TypeScript (loaded by pi via jiti, no build step for the extension itself), Node built-in `node:http`, `@earendil-works/pi-coding-agent` ExtensionAPI, `@earendil-works/pi-ai` types, vitest for tests.

**Spec:** `docs/superpowers/specs/2026-11-03-meeting-mirror-design.md`

## Global Constraints

- Extension lives in `~/.pi/agent/extensions/meeting-mirror/` for install; source lives in `/home/vimalkum/src/meeting-mirror/` with identical layout (extension dir at repo root: `index.ts`, `state.ts`, `transport.ts`, `extract.ts`, `page.html`, `page.css`, `page.js`).
- No build step for extension files; pi loads TypeScript directly via jiti.
- Transcript shows conversation messages only (roles `user` and `assistant`); tool calls, tool results, system messages, and slash-command invocations (user messages starting with `/`) are filtered out.
- Messages appear whole when complete; no streaming.
- All poll and vote state is in-memory only; cleared on session end.
- One poll at a time; last vote wins per username; votes hidden until reveal; reveal shows names and attributed remarks.
- The page never auto-scrolls; a "jump to latest" control appears when the reader is behind.
- Page style: document style — Georgia serif body, generous line-height, sans-serif role/timestamp labels, poll box as accent-colored card.
- Page is display-only: nothing from the page enters the pi session.
- Test framework: vitest, configured in `package.json`, run with `npx vitest run`.
- The extraction LLM call must work with the session's active model on any
  provider pi supports, specifically current Anthropic and OpenAI models with
  thinking: call `ctx.modelRegistry.complete()` with `reasoningEffort: "low"`
  (extraction needs no reasoning budget) and filter the response's `content`
  to `type: "text"` blocks only, discarding thinking blocks.

## Review Focus

- **XSS from model/user text:** transcript text and poll labels must be escaped before insertion into the page. Test: render a message containing `<script>alert(1)</script>` and assert the literal text appears, not executable markup (Task 6).
- **`/poll` argument edge cases:** empty string, `N` out of range (e.g. `99`, `0`), non-numeric garbage. Expect a clear terminal error, no crash (Task 5).
- **Empty or single-option extraction result:** LLM returns zero or one option. Expect rejection with a message pointing to pipe syntax (Task 3).
- **Vote before poll open / after reveal:** POSTs outside an open poll get HTTP 409 and change no state (Task 4).
- **SSE reconnect:** a browser that reconnects must receive the full history (transcript + current poll state), not just future events (Task 4).

---

### Task 1: Session state model

**Files:**
- Create: `package.json`, `tsconfig.json`, `state.ts`
- Test: `state.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type MirrorEvent = { type: "transcript_delta"; message: MirrorMessage } | { type: "poll_open"; poll: Poll } | { type: "poll_reveal"; votes: VoteRecord[] } | { type: "poll_close" }`
  - `type MirrorMessage = { role: "user" | "assistant"; text: string; timestamp: number }`
  - `type Poll = { question: string; options: { key: string; label: string }[] }` (keys "A", "B", ...)
  - `type VoteRecord = { username: string; choice: string; remark: string }`
  - `class MirrorState` with: `appendMessage(m: MirrorMessage): void`, `openPoll(p: Poll): MirrorEvent[]` (returns events to broadcast; throws if a poll is open), `castVote(username: string, choice: string, remark: string): void` (last vote wins; throws if no poll open or unknown choice key), `reveal(): MirrorEvent[]`, `closePoll(): MirrorEvent[]`, `getSnapshot(): { messages: MirrorMessage[]; poll: Poll | null; revealed: VoteRecord[] | null }`, `subscribe(fn: (e: MirrorEvent) => void): () => void`

- [ ] **Step 1: Write failing tests** for: append + subscribe; openPoll → poll_open event; second openPoll while open throws; castVote replaces earlier vote by same username; unknown choice key throws; reveal returns VoteRecords with names and remarks in insertion order; closePoll clears; snapshot after reopen is empty-poll; vote before open throws.
- [ ] **Step 2: Run `npx vitest run` — expect FAIL** (files missing).
- [ ] **Step 3: Implement `state.ts`** — plain in-memory class, no pi imports; votes stored in a `Map<string, VoteRecord>` keyed by username.
- [ ] **Step 4: Run tests — expect PASS.**
- [ ] **Step 5: Commit** `feat: session state model with poll lifecycle`.

### Task 2: `/poll` argument parsing (pipe syntax + N)

**Files:**
- Create: `extract.ts` (parse section only)
- Test: `extract.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `parsePollArgs(args: string): { kind: "index"; n: number } | { kind: "manual"; poll: Poll }` — `""` → `{kind:"index", n:1}`; `"3"` → `{kind:"index", n:3}`; anything with `|` → manual Poll from `question | opt | opt` segments (keys A, B, C...); otherwise throws `PollArgError` with a message naming valid forms.

- [ ] **Step 1: Write failing tests:** empty → index 1; `"2"` → index 2; `"Which? | A | B"` → manual poll with keys A/B; four segments → three options C last; single segment with no `|` → throws; `"0"` and `"-1"` and `"abc"` → throws.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement `parsePollArgs`** — regex `/^\d+$/` for the index form; split on `|`, trim segments, reject empty question or <2 options.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** `feat: poll argument parsing`.

### Task 3: LLM extraction

**Files:**
- Modify: `extract.ts`
- Test: `extract.test.ts`

**Interfaces:**
- Consumes: `Poll` from Task 1.
- Produces: `extractPoll(messageText: string, complete: CompleteFn): Promise<Poll>` where `type CompleteFn = (prompt: string) => Promise<string>`; validates JSON, requires ≥2 options and a non-empty question; one retry on invalid JSON, then throws `ExtractionError` whose message tells the moderator to use pipe syntax. `buildExtractionPrompt(messageText: string): string` returns this exact prompt (verbatim, with `{messageText}` substituted inside `<message>...</message>` tags):

  ```
  You are extracting a poll from a message written by an AI assistant
  during a brainstorming session.

  The message presents a question and a small set of distinct options
  for the team to choose between. Extract them.

  Return ONLY valid JSON in this exact shape, with no other text:
  {"question": string, "options": string[]}

  Rules:
  - "question": the question being put to the team, in the message's own
    words where possible. If no explicit question exists, summarize the
    choice being offered in one sentence.
  - "options": 2 to 4 options the message presents, in the original
    order. Keep each option's own wording; shorten only if it is too
    long to read as a button label.
  - If the question is yes/no or agree/disagree in nature, use
    "options": ["Yes", "No"] (or ["Agree", "Disagree"]).
  - If the message does not present a choice between distinct options,
    return {"question": "", "options": []}.

  Message:
  <message>
  {messageText}
  </message>
  ```

- [ ] **Step 1: Write failing tests** with a stubbed `CompleteFn`: valid JSON → Poll with keys A/B; JSON wrapped in markdown fences → still parsed; zero or one option → ExtractionError; invalid JSON twice → ExtractionError mentioning pipe syntax; prompt contains the message text and demands JSON-only output.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — strip optional ```json fences, `JSON.parse`, validate, retry once.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** `feat: LLM poll extraction with validation and retry`.

### Task 4: Transport — SSE server

**Files:**
- Create: `transport.ts`, `page.html`, `page.css`, `page.js` (placeholder page in this task: username prompt + transcript list only)
- Test: `transport.test.ts`

**Interfaces:**
- Consumes: `MirrorState`, `MirrorEvent` from Task 1.
- Produces:
  - `interface Transport { start(): Promise<void>; stop(): Promise<void>; url: string }`
  - `class LocalServer implements Transport` — constructor `(state: MirrorState, opts?: { port?: number; host?: string })`; default port `7433`; picks the next free port if bound (try up to 10). Routes: `GET /` serves `page.html` (and `/page.css`, `/page.js` from disk next to `transport.ts`); `GET /events` opens SSE, immediately sends a `snapshot` event (JSON of `getSnapshot()`), then forwards all `MirrorEvent`s; `POST /vote` body `{username, choice, remark}` → `castVote`, 200, or 409 when no poll open / bad key; `POST /identify` body `{username}` → 204 (sanity: non-empty username).
- [ ] **Step 1: Write failing integration tests** (real server on an ephemeral port, `fetch` client): `/` returns 200 HTML; SSE connection receives `snapshot` with prior messages; after `appendMessage`, SSE receives `transcript_delta`; after `openPoll` + `POST /vote` + `reveal`, SSE receives `poll_reveal` containing the username; vote on closed poll → 409; `stop()` closes the server (subsequent fetch rejects).
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement `LocalServer`** with `node:http`; page files served by reading from `import.meta.url`-adjacent paths; SSE headers `Content-Type: text/event-stream` + heartbeat comment every 25s; keep subscriber cleanup on connection close.
- [ ] **Step 4: Write minimal `page.html`/`page.css`/`page.js`:** username prompt (stored in localStorage), SSE connect + reconnect (with snapshot handling), append transcript entries as escaped text. Poll UI is Task 6 — page must tolerate receiving poll events as no-ops.
- [ ] **Step 5: Run tests — expect PASS** (manual browser check: open the URL, see username prompt).
- [ ] **Step 6: Commit** `feat: SSE transport with local server and minimal page`.

### Task 5: Extension entry — commands and event wiring

**Files:**
- Create: `index.ts`
- Test: `index.test.ts` (command-level logic tested through `MirrorState`/fakes; no pi harness needed)

**Interfaces:**
- Consumes: Tasks 1–4 (`MirrorState`, `parsePollArgs`, `extractPoll`, `LocalServer`).
- Produces: the extension default export `function (pi: ExtensionAPI): void`, plus pure helpers exported for tests: `nthLastAssistant(messages: MirrorMessage[], n: number): MirrorMessage` (throws `PollArgError` naming how many assistant messages exist when n out of range) and `isConversationMessage(entry): boolean` (filters to user/assistant text, excluding user messages starting with `/`).

- [ ] **Step 1: Write failing tests** for `nthLastAssistant` (n=1, n=2, out of range) and `isConversationMessage` (user text yes, user `/poll ...` no, assistant yes, tool/system no).
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement `index.ts`:**
  - `session_start`: create `MirrorState`, seed from `ctx.session.messages` via `isConversationMessage`, start `LocalServer`, `ctx.ui.notify` the URL.
  - `session_shutdown`: idempotent `stop()`.
  - Message-end events: for finished user/assistant messages, `appendMessage` + broadcast (excluding command invocations).
  - `/poll [args]`: parse args (Task 2). Index form: take Nth-last assistant message from state, build `CompleteFn` from `ctx.modelRegistry` using the session's current model (resolve via `ctx.model ??` first configured model), call `ctx.modelRegistry.complete(model, { messages: [extraction prompt] }, { reasoningEffort: "low", cacheRetention: "none", sessionId: uuidv7() })` — works identically for Anthropic and OpenAI thinking models; filter `response.content` to `type: "text"` blocks and join, following the `summarize.ts` example for auth checks (`modelRegistry.find`/`hasConfiguredAuth` when falling back to a configured model). `extractPoll`, then show extracted question/options in terminal via `ctx.ui.select` (`[Enter] Open poll / e Edit / Esc Cancel`; `e` → `ctx.ui.input` per line), then `openPoll`. Extraction failure → notify the error text.
  - `/reveal` → `state.reveal()` (notify if no poll). `/poll close` → `closePoll()`. `/mirror` → notify transport URL and vote count.
- [ ] **Step 4: Run tests — expect PASS.**
- [ ] **Step 5: Manual smoke test in a real pi session** (`pi --extension ./index.ts`): `/mirror` prints URL; a prompt + reply appears on the page; `/poll` extracts options from the last reply; `/reveal` after voting from a second browser works. Note results in the commit message.
- [ ] **Step 6: Commit** `feat: extension entry with poll commands and transcript wiring`.

### Task 6: Full page — voting UI, reveal, document style

**Files:**
- Modify: `page.html`, `page.css`, `page.js`
- Test: `page.test.ts`

**Interfaces:**
- Consumes: Task 4's routes and event vocabulary.
- Produces: the finished team-facing page.

- [ ] **Step 1: Write failing tests** for the page's pure helpers (exported from `page.js` as an ES module for tests): `escapeHtml(s)` (script-tag input → escaped entities), `renderMarkdown(md)` (`**bold**` and `` `code` `` render; raw `<script>` stays escaped — escape all HTML first, then apply markdown formatting), `renderTally(votes, options)` (returns HTML with one bar per option, proportional widths, voter names, remarks with usernames), `formatMessage(m)` (role label + timestamp + `renderMarkdown`).
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement the page:** document-style CSS per Global Constraints; `poll_open` renders the accent card with one button per option (keys 1/2/3 and A/B/C accepted as keyboard shortcuts), optional remark input, "N votes in · hidden until reveal" counter; `poll_reveal` replaces it with `renderTally` output; `poll_close` clears; "jump to latest" button appears when scrolled up, never auto-scrolls; username prompt overlay on first load, remembered in localStorage.
- [ ] **Step 4: Run tests — expect PASS.**
- [ ] **Step 5: Manual end-to-end check** with two browsers + a real pi session: read at own pace, vote from both, hidden counts, reveal with names and remarks, close. Note results in commit message.
- [ ] **Step 6: Commit** `feat: document-style page with poker voting UI`.

### Task 7: README and install path

**Files:**
- Create: `README.md`; Create `install.sh`

- [ ] **Step 1: Write `README.md`:** what it is, install (`install.sh` copies/symlinks this dir into `~/.pi/agent/extensions/meeting-mirror/`), commands, transport story (relay = future, see spec), security note (anyone with the URL can read/vote on the LAN).
- [ ] **Step 2: Write `install.sh`** — symlink repo dir into `~/.pi/agent/extensions/meeting-mirror`, `chmod +x`.
- [ ] **Step 3: Run `bash install.sh` and start pi; `/mirror` works.** Clean the symlink afterward if testing elsewhere.
- [ ] **Step 4: Commit** `docs: README and install script`.
