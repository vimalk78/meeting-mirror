# Meeting Mirror — Design

Date: 2026-11-03
Status: Approved design pending — see Approaches for the chosen path

## Intent and why

A team runs brainstorming sessions in pi (with the superpowers brainstorming
skill) while sharing the presenter's screen over Google Meet. Two problems:
the session produces content faster than everyone reads, the shared window
shows only a fragment, and readers go at different speeds. Meeting Mirror is
a pi extension that serves the live conversation as a web page each teammate
opens in their own browser, plus planning-poker-style voting.

The page is display-only for humans: nothing flows from the page into the
pi session. The moderator remains the sole person talking to the model.
On `/reveal`, the extension itself records the tally as a user message in
the session (see Non-goals), so the model learns the outcome without any
page-driven input.

## Goals

- Teammates read the live conversation at their own pace, in their own browser.
- Readers identify with a username on page load.
- The moderator can open a poll with labeled options; readers pick an option
  and may add a remark.
- Votes stay hidden until the moderator reveals; the reveal shows a tally with
  voter names and attributed remarks (planning-poker semantics, names public).
- Works with pi's fork of the superpowers brainstorming workflow; requires no
  changes to pi core or to skills.

## Non-goals

- No feedback path from the page into the pi session. Exception (changed
  2026-11-04, at the moderator's request): `/reveal` records the tally as a
  user message in the session so the model knows the outcome and the page
  shows it in the conversation flow.
- No persistence: poll state and served session state live in memory only.
- No authentication beyond the username and (for the relay transport) a
  session token.
- No support for multiple concurrent sessions per server.

## Anti-goals

- Anything that requires installing software on teammates' machines.
- Anything that stores team conversation content after the session ends.

## Constraints

- Runs as a pi extension in-process (Node runtime, TypeScript loaded via
  jiti — no build step).
- Peer-to-peer access to the presenter's laptop may be blocked by corporate
  IT; the transport must be pluggable so serving can move to an internal
  relay host without touching page or voting logic.
- Commercial tunnels (ngrok, cloudflared) are assumed forbidden and are not
  designed around.

## Approaches

1. **Single-file extension** with the page embedded as a TypeScript template
   string. Simplest install, but page markup inside TS strings is painful to
   iterate on. Rejected.
2. **Extension directory** (`meeting-mirror/index.ts` plus `page.html`,
   `page.css`, `page.js` read from disk). Page is editable as real web files;
   transport seam is an internal interface with only LocalServer implemented
   now. **Chosen.**
3. **Extension plus standalone relay service from day one.** Deferred: the
   internal host's capabilities are unknown, so building the relay now risks
   building the wrong thing. The transport seam keeps it a clean later
   addition.

## What was decided (in conversation)

- **Transcript content:** conversation only — user prompts and assistant
  messages, rendered as Markdown. Tool calls, tool results, and system
  messages are filtered out entirely.
- **Delivery:** messages appear whole when complete; no streaming updates.
  One `transcript_delta` event per finished message.
- **Scroll behavior:** the page never auto-scrolls; a "jump to latest"
  affordance appears when the reader is behind.
- **Voting flow:** moderator runs `/poll [N]` (N=1 by default: the Nth-last
  assistant message; `/poll 2` uses the one before). The extension sends
  only that message's text — no chat history, no session context — as a
  standalone LLM request using the session's current model, extracting
  `{question, options[]}` as JSON. The extracted question and options (with
  an identifier of the source message) are shown in the terminal for a
  one-keypress confirm: Enter to open, `e` to edit. On confirm, every
  connected page shows a poll box with one button per option plus an
  optional remarks field. Votes POST to the server and are held hidden.
  `/reveal` shows everyone the tally — proportional bars, voter names on
  each bar, remarks listed below with attribution. `/poll close` (or
  session end) clears the poll. One poll at a time.
- **Manual poll fallback:** `/poll question | option | option | ...` —
  pipe syntax, letters assigned automatically. No model-facing tool is
  registered; the brainstorming model never knows the page exists.
- **Page style:** document style — serif body (Georgia stack), generous
  line-height, messages as sections with small sans-serif role/timestamp
  labels, poll box as a highlighted card in a single accent color.
- **Transport:** pluggable. `LocalServer` binds a port on the presenter's
  machine and serves the page. `RelayClient` (future) opens an outbound
  websocket to an internal host that runs a thin dumb relay: accept the
  presenter socket, fan out events to browsers, forward vote POSTs back.
  Transport choice is per-session via command (e.g. `/mirror relay <url>`)
  with LocalServer as default. If the internal host turns out to be
  static-file-only, a degraded snapshot-push mode is a fallback to design
  only if forced.

## Extension behavior

- `session_start`: initialize state, start default transport (LocalServer
  on a configurable port), print the page URL to the terminal.
- `session_shutdown`: close the server; poll and transcript state die with
  it.
- Message lifecycle events feed `transcript_delta` events (conversation
  messages only).
- Commands: `/poll [N]` (LLM extraction + confirm, above), `/reveal`,
  `/poll close`, `/mirror` (status/URL), `/mirror relay <url>` (future).
- Vote state: in-memory map username → {choice, remark}; last vote wins
  for a given username.
- The extraction LLM call goes through the pi-ai package with the
  session's model; it carries no conversation history.

## Page behavior

- On load: username prompt (stored in localStorage for reloads); then the
  full conversation history so far, then live updates.
- Server-sent events for `transcript_delta`, `poll_open`, `poll_reveal`,
  `poll_close`.
- Poll box: option buttons (keyboard 1/2/3 and A/B/C both accepted), remark
  field, "votes in" counter while hidden.

## Left to the builder

- Exact SSE payload schema and reconnect handling on the page.
- Port number default and collision handling.
- Whether remarks are editable after voting (default: no, last vote wins).
- Markdown renderer choice and sanitization.
- Extraction prompt wording, JSON schema validation, and failure handling
  (retry once, then fall back to manual pipe syntax).
- Relay protocol details and auth token scheme (when RelayClient is built).
- i18n/text of UI labels.

## Size

A compact project: a few hundred lines of TypeScript plus a page of similar
size. One review pass over the voting state machine and the transport seam
is the main quality risk area.
