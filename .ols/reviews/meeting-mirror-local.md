---
review_id: meeting-mirror-local
mode: quality-only
review_round: 1
overall_score: 45
verdict: fail
criteria: []
---

## Summary

Code quality review — no requirements assessed. Tests (57) all pass, pure
logic is well-factored and well-tested, and XSS escaping in the page is
correct. However, the network surface has serious security gaps (CSRF,
vote impersonation, unbounded request bodies) and the extension entry
point has error-handling and resync bugs.

## Code Quality Issues

### Issue 1: CSRF — any website can cast votes as any user
- **Category:** other (security)
- **Location:** transport.ts:handleVote / readJson
- **Concern:** The server ignores `Content-Type` and `Origin`. Since
  `readJson` parses any body, a malicious page in any teammate's browser
  can do `fetch("http://localhost:7433/vote", { method: "POST",
  mode: "no-cors", body: JSON.stringify({ username: "alice", choice: "A" }) })`
  — a no-cors simple request that succeeds, casting or overwriting votes
  for arbitrary usernames.
- **Severity:** must-fix
- **Confidence:** confirmed

### Issue 2: Vote impersonation — username is unauthenticated
- **Category:** other (security)
- **Location:** transport.ts:handleIdentify / state.ts:castVote
- **Concern:** `/identify` validates the name and returns 204 but stores
  nothing and enforces nothing. Any client can vote under any name,
  silently overwriting that person's vote (`votes.set(username, ...)`).
  Two humans picking the same name also silently share one vote.
- **Severity:** must-fix
- **Confidence:** confirmed

### Issue 3: Unbounded request body accumulation
- **Category:** error handling
- **Location:** transport.ts:readJson
- **Concern:** `data += chunk` with no size limit. Anyone on the LAN can
  OOM the host process by streaming an endless body to `/vote`.
- **Severity:** must-fix
- **Confidence:** confirmed

### Issue 4: Failed server start leaves `server` non-null
- **Category:** error handling
- **Location:** index.ts:session_start
- **Concern:** `server = new LocalServer(state)` is assigned before
  `await server.start()`. If `start()` throws, the catch only notifies —
  `server` stays set with `chosenPort = 0`. The `/mirror` command then
  reports `http://localhost:0 — ...` instead of "not running". Set
  `server = null` in the catch.
- **Severity:** must-fix
- **Confidence:** confirmed

### Issue 5: Voter gets no feedback when a vote is rejected
- **Category:** error handling
- **Location:** page.js:castVote
- **Concern:** `if (res.ok && pollActive)` — the failure branch does
  nothing. A 409 (poll closed, unknown choice) or network error is
  silently dropped; the voter believes they voted.
- **Severity:** should-fix
- **Confidence:** confirmed

### Issue 6: Misleading error when voting after reveal
- **Category:** other
- **Location:** state.ts:castVote / reveal
- **Concern:** After reveal, `castVote` throws "No poll is open." even
  though a poll is open — it's just revealed. The HTTP layer maps this
  to 409 with a message that confuses the client.
- **Severity:** should-fix
- **Confidence:** confirmed

### Issue 7: resync breaks if the branch shrinks or rewinds
- **Category:** error handling
- **Location:** index.ts:resync
- **Concern:** `processedEntries` only grows. If the session branch ever
  gets shorter or is rewritten (message edit, branch switch without a new
  session_start), the loop `for (i = processedEntries; i < branch.length)`
  never runs and the page silently stops updating. Depends on pi API
  guarantees for `getBranch()`.
- **Severity:** should-fix
- **Confidence:** unsure

### Issue 8: index.ts excluded from type-checking and untested
- **Category:** tests
- **Location:** tsconfig.json (exclude), index.ts
- **Concern:** The largest, most integration-heavy file (command wiring,
  LLM completion call, terminal confirm flow) is excluded from
  `tsc --noEmit` and has zero test coverage; extract.ts's `CompleteFn`
  seam shows the logic was designed to be testable but the wiring isn't.
- **Severity:** should-fix
- **Confidence:** confirmed

### Issue 9: Notified URL is unreachable for teammates
- **Category:** other
- **Location:** transport.ts:url getter, index.ts:session_start
- **Concern:** The server binds `0.0.0.0` but the default display host is
  `localhost`, so the notify message ("Meeting Mirror page:
  http://localhost:PORT") is useless to the LAN teammates the 0.0.0.0
  bind was added for. The extension has no access to the machine's LAN
  IP to display a reachable URL.
- **Severity:** should-fix
- **Confidence:** confirmed

### Issue 10 (minor)
- **Category:** other
- **Location:** page.js:keyboardShortcuts
- **Concern:** Digit shortcut indexes options positionally while option
  keys can fall back to "9"/"10" (>8 options) — key labels and shortcuts
  diverge. Also `remark` length is capped at 500 only client-side;
  server accepts arbitrary length. `formatTimestamp` is dead code.
- **Severity:** nice-to-have
- **Confidence:** confirmed
