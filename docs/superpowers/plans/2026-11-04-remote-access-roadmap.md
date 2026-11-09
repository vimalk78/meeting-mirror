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

## Phase 1 — Session key (build first, serves both paths)

- `/mirror share` generates a random 128-bit session key.
- Every endpoint (page, /events, /vote, /identify) requires `?key=…`;
  requests without the correct key are rejected. The share URL is the
  credential.
- Rationale: gates transcript reading and vote participation; required
  by the relay design anyway, so build once for both transports.
- Optional in this phase: `MEETING_MIRROR_HOST` to bind a specific
  interface (e.g. wt0 only).

## Phase 2 — Relay brainstorm + spec

- One relay process multiplexing presenter sessions; pages at
  `/s/<session-id>?key=…`.
- Presenter connects outbound (WSS) — no inbound to the laptop, which
  is also what CSB policy allows.
- Relay is a dumb proxy: no transcript logic, no vote state; votes flow
  browser → relay → presenter's connection.
- `/mirror share` under the relay = dial out + print the share URL;
  `/mirror unshare` = drop the connection.
- Auth: the session key; Route-level SSO/htpasswd if IT requires.
- Spec failure modes: relay restart, laptop sleep, two tabs per
  teammate, presenter reconnect with backoff.
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

## Parked

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
