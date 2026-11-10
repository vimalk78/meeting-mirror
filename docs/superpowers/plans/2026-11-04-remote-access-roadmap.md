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

## Phase 2 — Relay v1 spec (keep it simple)

v1 is deliberately minimal: one share = one room, nothing persists.

- `/mirror share` (relay mode) dials out to the relay over WSS, creates
  a room with a random short id and a random key, and prints
  `https://<relay>/s/<room-id>?key=<key>`.
- `/mirror unshare` (or the presenter disconnecting) ends the room.
- Every share creates a new room and a new link. A multi-day
  refinement or a moderator handoff means posting a new link; the
  transcript itself carries over through pi's session file or export.
- Relay is a dumb proxy: no transcript logic, no vote state; votes flow
  browser → relay → presenter's connection.
- Auth: the room key only.
- Failure modes to spec: relay restart, laptop sleep or network drop
  (presenter reconnects with backoff to the same room while the relay
  still holds it), two tabs per teammate.
- Output: spec addendum to the design doc, reviewed before coding.

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

## Later — richer room model (deferred, not in v1)

Agreed in discussion, intentionally postponed for simplicity:

- Stable rooms that survive across meetings: the room id and key are
  stored in the pi session (`pi.appendEntry()`), so the same moderator
  resuming the session reattaches to the same link.
- Named rooms chosen by the moderator, e.g. a Jira id:
  `/mirror share ols-4596` (create or claim), and
  `/mirror share <full-url>` to attach to an existing room (handoff to
  another moderator). Names: lowercase letters, digits, dashes,
  3–30 characters. A guessable name is fine because the key is the
  credential.
- Single-presenter rule: the relay rejects a second presenter attaching
  to a room that already has one ("room busy"), never silently takes
  over.
- "Waiting for the moderator" page state while a room has no
  presenter; browsers keep retrying and resume when one attaches.
- Squatting and cleanup: rooms with no presenter and no browsers for
  24 hours are garbage-collected, so a squatted name frees itself.
- `/mirror rotate-key` for a suspected leaked room key.
- Route-level SSO or htpasswd in front of the relay if IT requires it.

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
