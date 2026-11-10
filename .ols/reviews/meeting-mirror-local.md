---
review_id: meeting-mirror-local
mode: quality-only
review_round: 2
overall_score: 87
verdict: needs_review
criteria: []
---

## Summary

Round 2 review. All 10 round-1 findings were addressed; the fixes are
real, not cosmetic, and are covered by new tests (65 passing,
`tsc --noEmit` clean with `index.ts` now included). One new must-fix
issue was introduced by the token fix, plus minor follow-ups.

## Round 1 Findings — Status

- CSRF via `/vote` — **fixed** (Content-Type must be `application/json`,
  which forces a CORS preflight the server never grants; 415 otherwise;
  tested).
- Vote impersonation — **fixed** (token→username binding, 401/403 paths,
  duplicate-name rejection on `/identify`; tested).
- Unbounded request body — **fixed** (64 KB cap, 413, `req.destroy()`).
- Failed server start leaving `server` set — **fixed** (`server = null`
  in the catch).
- Silent vote rejection in the browser — **fixed** (status-line
  feedback on 409/401/network error).
- Misleading "No poll is open" after reveal — **fixed** (distinct
  "Votes have already been revealed" message).
- resync breakage on rewind/fork — **fixed** (id-tracked seen-set in
  `resyncFromBranch`, unit-tested). Residual: id-less entries fall back
  to positional `#i` keys, which can mis-track a rewound branch —
  acceptable if pi entries always carry ids.
- `index.ts` untyped/untested — **fixed** (in tsconfig, helpers
  extracted and tested; wiring itself remains untested).
- Unreachable notify URL for teammates — **fixed** (LAN IP appended).
- Minor items — dead code removed; manual poll >8 options now
  rejected; remark truncated server-side to 500 chars.

## Round 2 — New Findings

### Issue 1: Returning teammates are locked out of voting after a session restart
- **Category:** error handling
- **Location:** page.js:initIdentify / castVote
- **Concern:** `localStorage` keeps `username` and `voteToken` across pi
  sessions, but tokens live in the `LocalServer` instance recreated on
  every `session_start`. On reload the overlay is skipped
  (`username && voteToken` both present), the stale token is sent, and
  every vote fails with 401 "token required (identify first)" — with no
  path back to the identify overlay short of clearing localStorage.
  Fix: on a 401, clear the stored username/token and re-show the
  overlay (or have the server accept re-identification for a name whose
  old token is no longer valid).
- **Severity:** must-fix
- **Confidence:** confirmed

### Issue 2: `/identify` token growth is unbounded
- **Category:** other
- **Location:** transport.ts:tokens map
- **Concern:** Every successful `/identify` adds a token that lives
  until the server stops, and the duplicate-name check is a linear
  scan. A LAN peer can spam identify to grow the map without bound
  (and lock every name). No rate limit or cap.
- **Severity:** should-fix
- **Confidence:** confirmed

### Issue 3: LLM extraction path still allows >8 options
- **Category:** other
- **Location:** extract.ts:extractPoll
- **Concern:** The 8-option cap was added to manual pipe syntax only.
  `extractPoll` accepts any `options.length >= 2`, falling back to
  numeric keys beyond H — reintroducing the keyboard-shortcut/key
  mismatch noted in round 1.
- **Severity:** nice-to-have
- **Confidence:** confirmed
