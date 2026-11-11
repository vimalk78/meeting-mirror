# Meeting Mirror — Remote Access Roadmap

Date: 2026-11-04
Status: agreed direction; not yet built

Background: the team is fully remote; nobody shares the presenter's LAN.
The CSB firewall (`redhat` zone) permits only SSH on NetBird/VPN
interfaces, and opening a port requires IT approval. Two paths forward,
both starting from the same code.

## Phase 0 — Decisions (blocking, user-driven)

1. Ask IT whether NetBird ACLs can open one port (7433) to the laptop,
   scoped to the team's NetBird group. If yes and acceptable, the
   LocalServer path works and no relay is needed.
2. Identify where a relay could live: an OpenShift cluster with
   deploy rights (permanent) or a Beaker loan (validation only).

## Phase 1 — Session key (done)

- `/mirror share` generates a random 128-bit session key.
- Every endpoint (page, /events, /vote, /identify) requires `?key=…`;
  requests without the correct key are rejected. The share URL is the
  credential.
- Rationale: gates transcript reading and vote participation; required
  by the relay design anyway, so build once for both transports.
- Optional in this phase: `MEETING_MIRROR_HOST` to bind a specific
  interface (e.g. wt0 only).

## Phase 2 — Relay v1 spec (drafted)

See `docs/superpowers/specs/2026-11-04-relay-v1-design.md`. Summary:

- Named rooms (e.g. `ols-4596`), random name when none is given.
- Room name and key stored in the pi session, so the same link works
  across meetings and survives a handoff via the session file or the
  HTML export's "↓ JSONL" button.
- `/mirror share <full link>` to take over a room.
- One moderator per room; the room is freed as soon as the moderator
  disconnects (no grace period).
- Confirmation prompt, default No, before starting a name as a new room.
- The relay keeps no state beyond live connections.

## Phase 3 — Relay build (TDD)

- `relay/` service (Node, ~200 lines): presenter WSS endpoint, page
  serving, event fan-out, vote forwarding.
- `RelayClient` in the extension implementing the existing `Transport`
  interface.
- SSE heartbeat becomes mandatory (a Route sits between browsers and
  the relay and will idle-kill connections).
- Packaging: container image + Deployment/Service/Route (cluster) or
  podman/systemd (Beaker).

## Phase 4 — Shakedown

- Solo test through the relay from two browser profiles.
- One real team meeting; fix what it surfaces.

## Later (deferred, not in v1)

- Show the brainstorming visual companion (mockups, diagrams, option
  cards) on the mirror page for remote teammates.
- Page color scheme: night, day, and follow-system modes with a toggle
  in the page. Today the page is light only; long meetings on a dark
  screen are hard on the eyes. CSS variables are already in place
  (`:root` in `page.css`), so the work is mostly a dark palette plus
  a small setting persisted in localStorage.

- Scan the moderator's own saved sessions for one that already used a
  room name, and mention it in the confirmation prompt.
- `/mirror rotate-key` for a room key that travelled too far.
- Route-level SSO or htpasswd in front of the relay if IT requires it.
- Room cleanup is not needed while the relay stores nothing between
  connections; revisit only if the relay starts remembering rooms.

## Parked

- Poll persistence across /reload and restarts via `pi.appendEntry()`
  (currently polls are in-memory only; accepted limitation, documented
  in README).

- Merge `feat/meeting-mirror` to main and tag (checkpoint after relay
  or earlier on request).
- `/mirror` printing a session label for distinguishing shared
  sessions.
- Playwright on top of the jsdom browser tests.
- `/poll` command-wiring tests (need an interactive session).

## Security notes for the IT conversation

- NetBird traffic is WireGuard-encrypted end-to-end; plaintext HTTP on
  wt0 is encrypted in transit.
- No persistence: unsharing stops all exposure; nothing is stored.
- Sharing is opt-in per session (`/mirror share`), off by default.
- With the Phase 1 session key, the share URL is the only credential;
  ACL scoping to the team group bounds the audience.
- Relay alternative: TLS termination and optional SSO at the Route, no
  laptop attack surface — stronger posture, one deployment.
