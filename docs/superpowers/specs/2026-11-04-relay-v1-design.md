# Meeting Mirror — Relay v1 Design

Date: 2026-11-04
Status: draft for review
Extends: `2026-11-04-remote-access-roadmap.md` (Phase 2) and
`2026-11-03-meeting-mirror-design.md`

## Why

The team is remote and cannot reach the moderator's laptop. The
moderator's pi session connects out to a relay on a shared host, and
teammates open the page there.

## Goals

- Teammates use one stable link per refinement item, across meetings and
  across moderators.
- A moderator hands off to another teammate without the team changing
  links.
- A mistake (sharing the wrong session or a new room by accident) is easy
  to notice and quick to recover from.
- The relay stays simple: it keeps no state beyond live connections.

## Non-goals

- The relay does not store transcripts, polls, votes, or rooms between
  connections.
- No more than one moderator per room at a time.
- No SSO, key rotation, or room cleanup in v1 (see Later).

## Modes

- `MEETING_MIRROR_RELAY` unset: local mode. The page is served from the
  moderator's laptop, as today. Kept for solo testing.
- `MEETING_MIRROR_RELAY=https://<relay-host>` set: relay mode, described
  here. This is how the team shares.

The mode is decided per share: a full link or a room stored in this
session means relay mode; otherwise `MEETING_MIRROR_RELAY` decides.

`MEETING_MIRROR_RELAY` is an environment variable, so it must be set
before pi starts, for example `export MEETING_MIRROR_RELAY=…` in
`~/.bashrc`. It is needed only to start a brand-new room. A full room link
contains the relay address, and a stored room remembers its relay, so
taking over a room or resuming a session works without it. `install.sh`
may offer to add the export line.

## Rooms

A room is the pair **name + key**.

- **Name** is the address. It tells the relay which room a browser or a
  moderator wants. It is public and may be chosen by the moderator, for
  example a Jira id: `ols-4596`. Allowed: lowercase letters, digits, and
  dashes, 3–30 characters. If no name is given, the extension picks a
  random 8-character name (Crockford base32).
- **Key** is the credential. It is a random UUID. Without it, nobody can
  read, vote, or present. A guessable name is acceptable because the key
  does all the gating.
- **Link:** `https://<relay-host>/s/<name>?key=<key>`

### Stored in the pi session

When a room is shared, the extension saves `{ name, key, relay }` with
`pi.appendEntry("meeting-mirror-room", …)`. This entry is in the session
file but is not sent to the model. On a later `/mirror share` from the
same session, or from a copy of it, the extension finds the stored room
and reuses the same link.

## Commands

| Command | Local mode | Relay mode |
|---|---|---|
| `/mirror share` | Start a server on the laptop with a new random key, and print its links. (If this session has a stored room, relay mode is used instead.) | Reuse the room stored in this session. If none, create a room with a random name. |
| `/mirror share ols-4596` | Not supported: shows "Room names need relay mode (set MEETING_MIRROR_RELAY)." | Reuse the stored key for `ols-4596` if this session has one. If not, show the confirmation prompt below, then create the room. |
| `/mirror share <full link>` | Not applicable: a link names its relay, so this always uses relay mode. | Use the name and key from the link, store them in this session, and share. Used for a handoff. |
| `/mirror unshare` | Stop the server. Open pages disconnect. | Disconnect from the relay. The room is freed at once. |
| `/mirror` | Show sharing status, the link, and poll status. | Same. |

Other differences:

| | Local mode | Relay mode |
|---|---|---|
| Who can open the page | Only people who can reach the laptop's port | Anyone with the link |
| Room names | None | Chosen by the moderator, or random |
| Link across shares | New link every share | Same link while the session keeps the room |
| Handoff to another moderator | Not possible: the link points at Alice's laptop | Take over with the session file or the link |
| Stored in the pi session | Nothing | Room name, key, and relay address |
| Ending the share | Server stops | Room is freed on the relay |

Polls, voting, the member list, and the page itself behave the same in
both modes.

### Confirmation prompt

Shown when `/mirror share <name>` is used and this session has no stored
room with that name. The default is No.

```
Room "ols-4596" has not been shared from this pi session before.

If your team has used this room already, continue from that conversation instead:

  • Your own earlier session: quit, then reopen it with  pi --resume
  • A teammate's session: ask them for the session file, then open it with
      pi --session <file>.jsonl
    Session files are in ~/.pi/agent/sessions/<project-folder>/
    If you have an /export HTML file: open it in a browser, click "↓ JSONL"
    at the top right, then use  pi --session <downloaded>.jsonl
  • You only have the room link: run  /mirror share <link>
    (keeps the team's link, but shows this session's conversation)

Start "ols-4596" as a new room? Any existing link for this room will stop working. (y/N)
```

## Relay rules

1. **A room exists only while a moderator is connected.** The relay keeps
   nothing between connections.
2. **One moderator per room.** If a room already has a connected
   moderator, a second share of the same name fails with "room busy". The
   relay never takes over a room.
3. **A room is freed as soon as its moderator disconnects.** There is no
   grace period. Quitting pi, Ctrl+C, a crash, and `/mirror unshare` all
   close the connection at once. A laptop that sleeps or loses network is
   detected by a missed heartbeat, about 30 seconds at most.
4. **No moderator connected:** browsers on the room show "Waiting for the
   moderator" and keep retrying. When a moderator shares the room again,
   open pages resume without reloading.
5. **Wrong key:** requests with a key that does not match the connected
   moderator's key are rejected.

## Data flow

- The moderator's extension keeps all state, as today: transcript, poll,
  votes, and joined names.
- When a browser connects, the relay asks the moderator for a snapshot
  and forwards it.
- Transcript and poll events go moderator → relay → all browsers.
- Join and vote requests go browser → relay → moderator. The moderator's
  reply goes back to that browser.
- Heartbeats: the relay sends an SSE comment to browsers every 25 seconds,
  and the moderator connection uses ping/pong. Routers and proxies close
  idle connections otherwise.

## Session id

A third identifier, separate from the room name and key.

| | Answers | Lifetime | Secret? |
|---|---|---|---|
| Room name | Which room? | Stable across meetings and moderators | No |
| Key | Are you allowed in? | Stable; stored in the pi session | Yes |
| Session id | Which run of the moderator's pi is serving the room now? | New when pi starts or another moderator shares; kept across reconnects | No |

- The moderator's extension creates the session id when it starts and
  sends it with every snapshot. The relay passes it along unchanged. It
  is not stored anywhere.
- Joined names live in the extension's memory. A new run starts with an
  empty list, so the page compares the snapshot's session id with the one
  it saved when the person joined, and asks for the name again if they
  differ.
- A reconnect of the same run (laptop wake, network drop, relay restart)
  keeps the session id, so nobody has to rejoin.

## Members and names

- **One name per person.** Each browser keeps a random client id in local
  storage. Tabs in one browser profile share it and count as one person.
- **Name conflicts.** A name belongs to the first browser that joins with
  it. A different browser asking for the same name gets: *"John is
  already in the room. Choose another name, for example John K."* The
  name becomes free again once its owner has no page open, so someone who
  cleared their browser data can rejoin as themselves.
- **Who is in the room.** The page shows "In the room: Alice, Bob, John
  (3)", updated as people join and leave. `/mirror` shows the same list in
  the moderator's terminal. Presence comes from open page connections:
  the relay tells the moderator when a joined browser connects or
  disconnects.
- **Who has voted.** While a poll is open, the member list shows a tick
  next to each person who has voted: "In the room: Alice ✓, Bob, John ✓
  (2 of 3 voted)". Only the fact of voting is shown, never the choice,
  until `/reveal`. Changing a vote does not change the tick. The
  extension's vote update carries the voters' names instead of only a
  count. `/mirror` shows the same in the moderator's terminal.

## Handoff (Alice to Bob)

1. Alice gives Bob her session file, either the `.jsonl` from
   `~/.pi/agent/sessions/`, or her `/export` HTML (Bob clicks **↓ JSONL**
   to get the file).
2. Bob runs `pi --session <file>.jsonl`. He has Alice's conversation and
   her stored room.
3. Bob runs `/mirror share`. The team's existing link works and shows the
   conversation where Alice stopped.

Polls do not carry over. That is acceptable: once revealed, a poll's
purpose is fulfilled, and the conversation that follows records the
outcome.

## Recovery from a mistake

Example: Bob runs `/mirror share ols-4596` in a fresh session and answers
"y" to the prompt. The room now has a new key, and the team's link fails.
Nothing is lost: Alice's file and every teammate's bookmark still have the
original link.

1. Bob runs `/mirror unshare`, or quits pi. The room is freed at once.
2. Bob opens Alice's session with `pi --session <file>.jsonl`.
3. Bob runs `/mirror share`. The original link works again.
4. If Bob posted the wrong link in chat, he says to ignore it.

If Alice's file is not available, `/mirror share <original link>` restores
the room and link from any teammate's bookmark, but the page shows Bob's
current session.

## Security

- The key is the only credential. The room name is not secret.
- The key is stored in plain text in the session file, and pi's HTML
  `/export` embeds it too. **An export or session file gives the same
  access as the room link.** Share them only with the team. (Accepted for
  v1.)
- TLS terminates at the relay's route. Traffic between relay and browsers,
  and between moderator and relay, uses HTTPS and WSS.
- The relay keeps no data at rest.

## Failure modes

| Event | What happens |
|---|---|
| Relay restarts | Moderator extension reconnects with backoff and re-registers the stored room. Browsers reconnect and get a new snapshot. |
| Moderator laptop sleeps | Missed heartbeat frees the room within about 30 seconds. Browsers show "Waiting for the moderator". On wake, the extension reconnects with the stored room. |
| Moderator's network drops briefly | Room is freed, then reclaimed when the extension reconnects, usually within seconds. |
| Second moderator shares a busy room | "room busy"; nothing changes. |
| Teammate has two tabs open | Both work, as in local mode. |

## Packaging

- One container image for the relay. It can run on OpenShift
  (Deployment, Service, Route) or with podman on a Beaker host.
- **Test target:** an OpenShift cluster approved for testing. If its
  routes are reachable from the internet, the page is public and
  protected only by the room key. Acceptable for testing; revisit before
  relying on it for real meetings.
- Sharing from the laptop (local mode) remains for solo testing only; the
  team uses the relay.

## Later (not in v1)

- Show the brainstorming skill's visual companion (mockups, diagrams,
  option cards) on the same page, so remote teammates see what the
  moderator sees in the browser companion, not just the text.
- Look through the moderator's own saved sessions for one that already
  used the room name, and name it in the confirmation prompt (helps a
  moderator who started a fresh session by mistake).
- `/mirror rotate-key` for a key that travelled too far.
- SSO or htpasswd at the relay route, if IT requires it.
- Poll persistence across `/reload` (still in-memory only).
