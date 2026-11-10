# Meeting Mirror

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that
mirrors a live brainstorming session to a web page, so a team following
along over a shared screen can read at their own pace and vote on
options, planning-poker style.

## What it does

- **Live transcript** — conversation only (your prompts and the model's
  replies), rendered as Markdown. Tool calls and system messages are
  filtered out. Messages appear whole when complete.
- **Voting** — run `/poll` in pi. The extension extracts the question and
  options from the model's last message (a small side-channel LLM call),
  shows them in the terminal for confirmation, then opens a poll on every
  connected page. Teammates pick an option (click, or keys `1/2/3`,
  `A/B/C`) and may add a remark. Votes stay hidden.
- **Reveal** — `/reveal` shows everyone the tally: proportional bars with
  voter names, plus attributed remarks. Like planning poker, nobody anchors
  on early votes. `/poll-close` clears the poll.
- **Display-only** — nothing from the page flows back into the pi session.
  The moderator relays vote outcomes to the model.

## Install

```bash
bash install.sh
```

This symlinks the extension into `~/.pi/agent/extensions/meeting-mirror/`.
Start (or restart) pi; a new session prints a note that it is private until
you run `/mirror share`.

Requires Node's `ws` package at runtime: run `npm install` once after
cloning (and after pulling changes that touch `package.json`). The same
`npm install` also sets up the test suite (`npx vitest run`).

## Commands

Sessions are **private by default** — nothing is served until you share:

| Command | Local mode | Relay mode |
|---|---|---|
| `/mirror share` | Start a server on the laptop with a new random key, and print its links. (If this session has a stored room, relay mode is used instead.) | Reuse the room stored in this session. If none, create a room with a random name. |
| `/mirror share ols-4596` | Not supported: shows "Room names need relay mode (set MEETING_MIRROR_RELAY)." | Reuse the stored key for `ols-4596` if this session has one. If not, a confirmation prompt (default No) guards against accidentally starting a new room. |
| `/mirror share <full link>` | Not applicable: a link names its relay, so this always uses relay mode. | Use the name and key from the link, store them in this session, and share. Used for a handoff. |
| `/mirror unshare` | Stop the server. Open pages disconnect. | Disconnect from the relay. The room is freed at once. |
| `/mirror` | Show sharing status, the link, poll state and who is in the room. | Same. |
| `/poll` | Extract a poll from the last assistant message (LLM call + terminal confirm) | Same. |
| `/poll 2` | Same, from the 2nd-last assistant message |
| `/poll Q \| opt \| opt` | Manual poll (pipe syntax) |
| `/reveal` | Reveal votes on the page |
| `/poll-close` | Close the current poll |

## Team access

The page is served from the presenter's machine on port 7433 (next free
port if taken). Teammates need network access to that machine — e.g. the
same office LAN or VPN. For remote teams, use relay mode (below) instead.
Local mode is kept for solo testing.

**Known limitation — polls are in-memory only.** Poll state (question,
options, votes) lives in the extension's memory: it does not survive
`/reload`, a pi restart, or `/mirror unshare`-plus-restart. The
transcript does survive (it is reseeded from the session file), so after
a reload you will see the conversation but not an open poll. Close or
finish polls before reloading. Persisting polls is a known future item
(see the roadmap).

## Relay mode (remote teams)

Set `MEETING_MIRROR_RELAY=https://<relay-host>` before starting pi (for
example in `~/.bashrc`). It is needed only to start a brand-new room; a
full room link or a room stored in the session carries the relay address.

Rooms are name + key. The link `https://<relay>/s/<name>?key=<key>` is
stable across meetings and moderators as long as the room name and key
stay the same. The room is stored in the pi session, so resuming the
session or handing the session file to another moderator keeps the same
link.

**Handoff (Alice → Bob):** Alice gives Bob her session file — the
`.jsonl` from `~/.pi/agent/sessions/`, or the `/export` HTML (Bob clicks
"↓ JSONL" at the top right to get the file). Bob runs
`pi --session <file>.jsonl`, then `/mirror share`. The team's link works
unchanged and the page shows the conversation where Alice stopped.
Polls do not carry over.

**Recovery from a wrong share:** `/mirror unshare` (or quitting pi) frees
the room at once. Open the right session with `pi --session <file>.jsonl`
and `/mirror share` again. If the session file is unavailable,
`/mirror share <original link>` restores the room and link, but shows the
current session's conversation.

Note: a page opened with a key that does not match the room shows
"This link is not valid for this room." and stops updating. After the
right moderator shares the room, such a page must be reloaded with the
correct link.

**Deploying the relay** (OpenShift):

```bash
oc new-project meeting-mirror
oc apply -f deploy/relay.yaml
oc start-build relay --from-repo=. --follow
oc rollout status deploy/relay
oc get route relay   # the relay host for MEETING_MIRROR_RELAY
```

The relay holds no state and must run as exactly **one replica**
(`Recreate` strategy is set for rolling by image tag). If its route is
internet-reachable, the room key is the only protection — treat room
links as internal.

**Security note:** the share URL contains a per-session key — it is the
only credential. Anyone who can reach the port *and* has the URL can read
the transcript and vote; anyone without the key gets nothing (all
endpoints reject it). The key is random per session, so a URL from a
previous meeting never works on the next one. Still, treat the share link
like any internal document: send it to the meeting, not to a broad
channel. Set `MEETING_MIRROR_HOST` (e.g. `127.0.0.1` or a NetBird IP) to
bind a specific interface instead of all of them.

## Development

```bash
npm install
npx vitest run   # 154 tests
npx tsc --noEmit # type check (pure modules; index.ts is checked by pi itself)
```

Layout:

| File | Responsibility |
|---|---|
| `index.ts` | Extension entry: commands, session wiring |
| `index-helpers.ts` | Pure helpers (message filtering, Nth-last lookup) |
| `state.ts` | In-memory transcript + poll state, event vocabulary |
| `transport.ts` | Transport interface + `LocalServer` (SSE, votes) |
| `extract.ts` | `/poll` argument parsing + LLM poll extraction |
| `page.html/css/js` | The team-facing page |
