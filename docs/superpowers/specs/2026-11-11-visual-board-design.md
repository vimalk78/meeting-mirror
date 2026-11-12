# Meeting Mirror — Visual Board Design

Date: 2026-11-11
Status: draft for review
Extends: `2026-11-04-relay-v1-design.md`

## Why

During brainstorming, the superpowers brainstorming skill can show
mockups, diagrams and option cards in a browser: the "visual companion".
The companion runs a small server on the moderator's laptop at
`localhost`. Remote participants cannot reach it, so they miss every
visual step of the discussion. They see only the moderator's typed
replies in the transcript.

The mirror page already reaches participants through the relay. The
visual board brings the companion's screens to the mirror page, so that
participants see what the moderator sees and can pick options too.

## Goals

- Participants see the companion's current screen on a separate board
  page, in relay mode and in local mode. They can keep it open next to
  the transcript, for example on a second monitor.
- The screen looks like it does in the companion.
- Step 2: a participant's click on an option card reaches the agent,
  with the participant's name.
- No change to the companion or to the brainstorming skill.

## Non-goals

- No history of earlier screens. The transcript records what was
  decided.
- No new relay logic. Board events travel like transcript events. The
  relay changes only in routing: it serves the board page and forwards
  `/board-click` (step 2), the same way it serves the main page and
  forwards `/vote`.
- No support for companion sessions started without `--project-dir`
  (their files are in `/tmp` and are not found; see Discovery).
- No support for images and other files under the companion's
  `/files/` path in step 1.

## Anti-goals

- The board must never let mockup HTML read the room key, the page,
  or the participant's local storage. Mockups are HTML that an agent
  wrote.
- The pages must never open windows, switch pages, or scroll by
  themselves. Same rule as the transcript: participants read at their
  own pace.
- The board must not break or slow the companion for the moderator.

## Approaches considered

1. **Tunnel the real companion through the relay** (rejected). The
   companion sends `X-Frame-Options: DENY` and
   `frame-ancestors 'none'`, so it cannot appear in a frame on the mirror page. Its script
   connects to `ws://<host>/?key=…` at the site root, and screens load
   files from `/files/…`. Under the relay it would live at
   `/s/<room>/companion/`, and `ws://` is blocked on an `https://` page.
   The tunnel would have to rewrite the companion's headers and code in
   transit, and would break when the companion changes.
2. **Re-serve the screens through the mirror's own channels**
   (chosen). The extension reads the screen files from disk and sends
   them to the page as events. Clicks come back the way votes do. It
   depends only on stable things: screen files in a known directory, and
   the companion's own frame template on disk.
3. **Upstream change to the companion** (later, optional). A base-path
   setting and same-origin framing in superpowers would make approach 1
   clean. It depends on the superpowers maintainers.

## Design

### Step 1: everyone sees the board

**Discovery (extension).** While the session is shared, the extension
watches `<cwd>/.superpowers/brainstorm/`. This assumes that pi runs in
the directory that the brainstorming skill passes as `--project-dir`,
which is the normal case. The active companion session
is the newest session directory that has `state/server-info`, does
not have `state/server-stopped`, and whose process in
`state/server.pid` is still running. (The companion removes
`server-info` only on a clean shutdown, so after a crash a dead session
still has it.) The extension polls every 2 s; a poll is simpler than a
filesystem watch and fast enough for a meeting. The current screen is the newest
`.html` file in its `content/` directory by modification time, which is
the rule the companion uses. Hidden files are ignored.

**Rendering (extension).** The rendering follows the companion's rule:

- If the file starts with `<!DOCTYPE` or `<html` (case-insensitive,
  after leading whitespace), it is a full page and is sent as is.
- Otherwise it is a fragment. The extension wraps it in the companion's
  `frame-template.html`: `<!-- CONTENT -->` becomes the fragment, and
  `<!-- BRANDING -->` becomes an empty string. (The companion fills
  `BRANDING` with a logo from an external site; the board must not make
  participants' browsers fetch from a third party.) The extension uses
  the running companion's own template, or a bundled copy (see
  Template location).

In both cases the extension adds the board helper script (below) to
the page, instead of the companion's `helper.js`, with the companion's
rule: before `</body>` if the page has it, otherwise at the end.

**External resources.** Mockups can load images, fonts, and scripts
from other sites (for example a CDN). The board allows this, so screens
look as they do in the companion. The cost is that those sites see the
participants' IP addresses. If this becomes a problem, the extension
can add a Content-Security-Policy `<meta>` to each screen later.

**Events.** A new hub event, `board`, carries the current screen:
`{ type: "board", screen: { name, html } }`, or `{ type: "board",
screen: null }` when no companion session is active. The snapshot
includes the current screen, so a participant who joins late sees it.
The event is sent when the current screen changes, not on every file
write: the extension compares the file name and modification time.

Every connection gets `board` events with the full HTML, including the
main page, which needs only the name for its link. So each participant
downloads each screen twice. With light use and screens of a few KB
this is acceptable, and it needs no new relay route. If it becomes a
problem, events can carry only the name and the board page can fetch
the HTML.

**Board page.** The board is a separate page:

- Relay mode: `https://<relay-host>/s/<name>/board?key=<key>`
- Local mode: `http://<laptop>:<port>/board?key=<key>`

It is the same `page.html` and `page.js` in a board view, chosen by the
path. It uses the same base path, key, `/events` stream, snapshot, and
reconnect logic as the main page, and shows only the board. With no
screen it shows "Nothing on the board yet" and updates live when a
screen arrives. Participants can open it once and leave it open.

The screen fills the page in an
`<iframe sandbox="allow-scripts" srcdoc="…">`. Without
`allow-same-origin` the frame has an opaque origin: its scripts run
(mockups use `onclick="toggleSelect(this)"`) but cannot read the page,
its cookies, or its local storage.

**Link on the main page.** The main page always shows a "Visual board"
link that opens the board page in a new browser tab
(`target="_blank" rel="noopener"`). The link is persistent, so the
layout does not move and participants can open the board before
anything is presented. The link shows the board state:

| State | Link |
|---|---|
| No companion session | Muted: "Visual board (nothing shown)" |
| Screen active | Normal: "Visual board" |
| New screen since this browser last had the board page open | "Visual board" with a "new" marker |

The main page receives `board` events like the board page, but uses
only the screen name to update the link. It does not render the
screen. The "new" marker clears when the board page in the same browser
shows the screen (shared through local storage). The pages never open
or switch windows by themselves.

The main page and the board page are two connections from the same
browser. Both count toward the relay's connection limits.

**Board helper script.** About 30 lines, injected into every screen.
It provides `window.toggleSelect` and `window.brainstorm` with the
same behavior as the companion's `helper.js`, so the visual selection
works. In step 1 clicks only change the selection on screen.

**Moderator terminal.** No change. The moderator keeps using the
companion in their own browser as today.

### Step 2: participant clicks count

**Clicks.** The board helper script reports a click on any
`[data-choice]` element to the parent page with
`postMessage({ type: "click", text, choice, id })`, which is the event
shape of the companion. The board page accepts messages only from its
own board frame (`event.source === frame.contentWindow`) and posts them
to a new endpoint, `POST /board-click`, next to `/vote`, with the name
of the screen it shows. The relay forwards it like a vote request (same
64 KB body limit). The moderator's extension handles it, as it handles
`/vote`. The board page uses the same client id and joined name as the
main page, from local storage. A participant who has not joined yet is
asked for a name on the board page first, as for voting.

**Clicks on an old screen.** When a new screen appears, the companion
deletes `state/events`. A click that arrives after that would count
against the wrong screen. The extension drops a click whose screen name
is not the current screen, and the board page shows "The screen
changed; your click was not sent."

**Limits.** The extension accepts at most 5 clicks per client in 10
seconds and cuts `text` to 200 characters. Extra clicks get an error
reply and are not written.

**Events file.** The moderator's extension appends the click to the
active session's `state/events`, in the companion's format, with two
added fields:
`"user": "<name>"` and `"source": "mirror"`. It adds a `timestamp` as
the companion does. The brainstorming agent reads the same file as
today. Clicks without `choice` are ignored, which is the companion's
rule. This also drops `brainstorm.choice()` calls, which send `value`
and not `choice`; the companion drops them too.

**Who clicked.** The companion's own events do not say who clicked. The
added `user` field gives the agent "Alice: A, Bob: B". The
brainstorming skill does not ask for this field, so the agent sees it
as extra data. A participant who clicks the wrong option clicks the
right one; both lines are in the file, in order, and the latest click
per user is their pick. The moderator can say so to the agent if it
reads the file differently.

**What others see.** A participant's selection shows only in their own
browser. There is no tally on the board page, and the moderator's
companion does not show participant clicks. The agent sees all clicks
and reports them in the transcript. A tally can be added later if
meetings need it.

## Constraints

- The pages and the extension stay in sync through events only. The
  relay changes only in routing (board page, `/board-click`).
- The relay serves its own copy of the page files, so page changes need
  a relay redeploy.
- A screen can be large. One screen is sent once per change, and once
  per new connection in the snapshot. A limit of 1 MB per screen keeps
  the relay safe; a larger screen is replaced by a short notice on the
  board.
- The extension reads files under the project's `.superpowers/`
  directory and the running companion's `scripts` directory only.

## Template location

The moderator configures nothing. The superpowers skill can be
installed in many places (pi, omp, Claude Code plugin cache, a
project's `.claude/skills/`), often in more than one version. The
extension does not search these places. It uses, first match wins:

1. **The running companion's template.** `start-server.sh` changes to
   its own `scripts` directory before it starts `server.cjs`, and the
   server does not change directory. So the working directory of the
   process in the session's `state/server.pid` is the `scripts`
   directory of the companion that the moderator uses. The extension
   reads `frame-template.html` from there. On Linux the working
   directory is `/proc/<pid>/cwd`; on macOS it comes from
   `lsof -a -p <pid> -d cwd -Fn`. This gives the same template as
   the moderator's screen, for every install type and version.
2. **A bundled copy.** The extension ships a copy of
   `frame-template.html` from superpowers (MIT license; keep the
   license notice). It is used when step 1 fails, for example when the
   process cannot be read. Screens then look as they did in that
   superpowers version.

The template is read once per companion session, not once per screen.

## Open for the builder

- The link design, the "new" marker, and the board page layout, within
  the page's existing look.

## Calls made in this design (please check)

- Step 1 ships alone first; step 2 follows if step 1 is useful.
- The board is a separate page at `<base>/board`, not a tab on the main
  page, so participants can see it next to the transcript.
- The main page always shows the board link, with its state; it is not
  shown only while something is presented.
- Only the newest screen is shown; no history.
- `--project-dir` companion sessions only.
- The frame template comes from the running companion's directory, with
  a bundled copy as fallback; no setting for the moderator.
- Clicks carry the participant's name in an added `user` field.
- `/files/` assets are not supported in step 1.
- Screens over 1 MB are replaced by a notice.
- Discovery polls every 2 s; no filesystem watch.
- A session counts as active only if its companion process is running.
- Clicks for a screen that is no longer current are dropped, with a
  message to the participant.
- Clicks are limited to 5 per client in 10 s, `text` to 200 characters.
- Each participant downloads each screen twice (main page and board
  page); no new relay route to avoid it.
- Mockups may load external resources; no CSP for now.
- No tally of participant clicks; the agent reports them.

These choices assume light use: the team is using the companion for
the first time. Each one is the simpler option and can be changed later
without changing the others.
