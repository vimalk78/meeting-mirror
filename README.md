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
Start (or restart) pi; you'll see `Meeting Mirror page: http://localhost:7433`
when a session starts.

Requires the extension's dev dependencies for nothing at runtime — pi loads
the TypeScript directly. `npm install` is only needed to run the test suite
(`npx vitest run`).

## Commands

Sessions are **private by default** — nothing is served until you share:

| Command | Effect |
|---|---|
| `/mirror share` | Start serving this session's page and print the URL |
| `/mirror unshare` | Stop serving; connected pages disconnect |
| `/mirror` | Show sharing status, URL, and poll state |
| `/poll` | Extract a poll from the last assistant message (LLM call + terminal confirm) |
| `/poll 2` | Same, from the 2nd-last assistant message |
| `/poll Q \| opt \| opt` | Manual poll (pipe syntax) |
| `/reveal` | Reveal votes on the page |
| `/poll-close` | Close the current poll |
| `/mirror` | Show the page URL and poll status |

## Team access

The page is served from the presenter's machine on port 7433 (next free
port if taken). Teammates need network access to that machine — e.g. the
same office LAN or VPN. The transport is pluggable by design: a relay mode
for internal hosts where peer-to-peer access is blocked is planned (see the
[design doc](docs/superpowers/specs/2026-11-03-meeting-mirror-design.md)).

**Security note:** anyone who can reach the URL can read the session
transcript and vote. There is no authentication beyond the username. On a
trusted internal network this is usually fine; on anything else, don't.

## Development

```bash
npm install
npx vitest run   # 55 tests
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
