# Meeting Mirror

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that
mirrors a live brainstorming session to a web page. Participants who
follow along over a shared screen can read at their own pace and vote on
options, planning-poker style.

## What it does

- **Live transcript** — conversation only (your prompts and the model's
  replies), rendered as Markdown. Tool calls and system messages are
  filtered out. Messages appear whole when complete.
- **Voting** — run `/poll` in pi. The extension extracts the question and
  options from the model's last message (a small side-channel LLM call).
  It shows them in the terminal for confirmation, then opens a poll on
  every connected page. Participants pick an option (click, or keys `1/2/3`,
  `A/B/C`) and can add a remark. Votes stay hidden.
- **Reveal** — `/reveal` shows everyone the tally: proportional bars with
  voter names, plus attributed remarks. Like planning poker, nobody anchors
  on early votes. `/poll-close` clears the poll.
- **Display-only** — nothing from the page flows back into the pi session.
  The moderator relays vote outcomes to the model.

## How it works

Meeting Mirror has three parts:

```
 moderator (pi + extension) ──WSS──▶ relay ◀──HTTPS── participants (browsers)
```

- **Moderator:** the pi session that runs the extension. It holds all
  the state: the transcript, the poll, the votes, and the names of the
  participants who joined. It connects out to the relay, so the laptop
  of the moderator needs no open port.
- **Relay:** a small server on a shared host. It passes messages between
  the moderator and the browsers, and stores nothing. A room exists on
  the relay only while its moderator is connected.
- **Participants:** the people who open the room link in a browser. They
  read the transcript, join with a name, and vote. Nothing that they do
  reaches the pi session.

Because the moderator holds all the state:

- When the moderator disconnects, pages show "Waiting for the
  moderator…". The relay has nothing to show without it.
- Polls do not survive `/reload`. They live in the memory of the
  moderator (see [Known limitation](#known-limitation-polls-are-in-memory-only)).
- Another moderator can take over with only the session file (see
  [Handoff](#rooms)).

## Install

1. Install the extension and its runtime dependency:

   ```bash
   npm install
   bash install.sh
   ```

   `install.sh` symlinks the repository into
   `~/.pi/agent/extensions/meeting-mirror/`. Run `npm install` again after
   you pull changes to `package.json`.

2. Set the relay address before you start pi, for example in `~/.bashrc`.
   `install.sh` offers to add this line for you.

   ```bash
   export MEETING_MIRROR_RELAY=https://<relay-host>
   ```

   If `MEETING_MIRROR_RELAY` is not set, `/mirror share` serves the page
   from your laptop only. That mode is for testing (see
   [Testing without a relay](#testing-without-a-relay)).

3. Start (or restart) pi. A new session is private until you run
   `/mirror share`.

## Commands

| Command | What it does |
|---|---|
| `/mirror share` | Share the room stored in this session. If there is none, create a room with a random name. |
| `/mirror share ols-4596` | Share the room `ols-4596`. If this session has no stored key for that name, a confirmation prompt (default No) asks before it starts a new room. |
| `/mirror share <full link>` | Share with the name and key from the link, and store them in this session. Use this for a handoff. |
| `/mirror unshare` | Disconnect from the relay. The room is freed at once. |
| `/mirror` | Show the sharing status, the link, the poll state, and who is in the room. |
| `/poll` | Extract a poll from the last assistant message (LLM call + terminal confirmation). |
| `/poll 2` | Same, from the 2nd-last assistant message. |
| `/poll Q \| opt \| opt` | Open a manual poll (pipe syntax). |
| `/reveal` | Reveal the votes on the page. |
| `/poll-close` | Close the current poll. |

## Rooms

A room is a **name + key**.

- **Name:** the address of the room. It is not secret. You can pick one,
  for example a Jira id such as `ols-4596`. Allowed: lowercase letters,
  digits, and dashes, 3–30 characters.
- **Key:** a random UUID. It is the only credential. Without it, nobody
  can read, vote, or present.
- **Link:** `https://<relay-host>/s/<name>?key=<key>`

The extension stores the room in the pi session. If you resume the
session, or give the session file to another moderator, participants
keep the same link. A full link or a stored room includes the relay address,
so `MEETING_MIRROR_RELAY` is necessary only to start a new room.

The relay keeps a room only while its moderator is connected. If the
moderator disconnects, open pages show "Waiting for the moderator…".
They continue automatically when the moderator shares the room again.
Pages also reconnect by themselves after a relay restart.

**Handoff (Alice → Bob):**

1. Alice gives Bob her session file. This is the `.jsonl` file from
   `~/.pi/agent/sessions/`, or her `/export` HTML file. From the HTML
   file, Bob clicks "↓ JSONL" at the top right to get the `.jsonl` file.
2. Bob runs `pi --session <file>.jsonl`.
3. Bob runs `/mirror share`.

The link for participants does not change. The page shows the conversation where
Alice stopped. Polls do not carry over.

**Recovery from a wrong share:**

1. Run `/mirror unshare`, or quit pi. The room is freed at once.
2. Open the correct session with `pi --session <file>.jsonl`.
3. Run `/mirror share` again.

If the session file is not available, run `/mirror share <original link>`.
This restores the room and the link, but the page shows the current
session's conversation.

A page opened with a key that does not match the room shows "This link
is not valid for this room." and stops updating. Reload that page with
the correct link.

## Security

- The room key is the only credential. Anyone with the link can read the
  transcript and vote.
- The key does not change between meetings. It stays the same as long as
  the session keeps the room.
- The key is stored as plain text in the pi session file. pi's `/export`
  HTML file contains it too. **A session file or an export gives the same
  access as the room link.** Share them only with people who can have
  the link.
- If the relay route is reachable from the internet, the key is the only
  protection. Send room links to the meeting, not to a broad channel.

## Known limitation: polls are in memory only

Poll state (question, options, votes) lives in the memory of the
extension. It does not survive `/reload` or a pi restart. The transcript
does survive, because the extension reads it again from the session file.
After a reload you see the conversation, but not an open poll. Close or
finish polls before you reload. Saving polls is a future item (see the
roadmap).

## Deploying the relay

On OpenShift:

```bash
oc new-project meeting-mirror
oc apply -f deploy/relay.yaml
oc start-build relay --from-repo=. --follow
oc rollout status deploy/relay
oc get route relay   # the relay host for MEETING_MIRROR_RELAY
```

The relay keeps no state. It must run as exactly **one replica**. The
deployment uses the `Recreate` strategy, so a new image replaces the pod
instead of running two pods at the same time.

With podman, build from the repository root:

```bash
podman build -f relay/Containerfile -t meeting-mirror-relay .
podman run -p 8080:8080 meeting-mirror-relay
```

Put TLS in front of the relay. Participants must connect over HTTPS,
and the moderator over WSS.

## Development

```bash
npm install
npx vitest run             # 154 tests
npx tsc -p .               # type check the extension
npx tsc -p relay --noEmit  # type check the relay
```

Layout:

| File | Responsibility |
|---|---|
| `src/index.ts` | Extension entry: commands, session wiring |
| `src/index-share.ts` | `/mirror share` decision (relay or local, new or stored room) |
| `src/index-helpers.ts` | Pure helpers (message filtering, Nth-last lookup) |
| `src/state.ts` | In-memory transcript and poll state, event vocabulary |
| `src/hub.ts` | Room logic: names, presence, votes, member list |
| `src/rooms.ts` | Room names, links, stored-room lookup |
| `src/relay-client.ts` | Connection from the moderator's pi to the relay |
| `src/transport.ts` | Transport interface and `LocalServer` (testing without a relay) |
| `src/extract.ts` | `/poll` argument parsing and LLM poll extraction |
| `page/` | The page for participants (`page.html`, `page.css`, `page.js`) |
| `relay/src/` | The relay server |
| `deploy/relay.yaml` | OpenShift resources for the relay |

### Testing without a relay

If `MEETING_MIRROR_RELAY` is not set and the session has no stored room,
`/mirror share` starts a server on your laptop. Use this mode for solo
tests only.

- The server listens on port 7433. If that port is in use, it tries the
  next free port.
- Each share makes a new random key, so the link changes every time.
- Room names are not available. `/mirror share <name>` shows
  "Room names need relay mode (set MEETING_MIRROR_RELAY)."
- `/mirror unshare` stops the server. Open pages disconnect.
- To select a different port, set `MEETING_MIRROR_PORT`.
- To listen on one interface only, set `MEETING_MIRROR_HOST` (for example
  `127.0.0.1`). By default the server listens on all interfaces.
