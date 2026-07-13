# Claude implementation review reconciliation

Date: 2026-07-13

Claude reviewed the SPEC-2 implementation twice through the authenticated
Claude Code CLI. Codex validated every finding against the repository before
changing code. The first review is recorded in
`claude-implementation-review.md`; the focused follow-up is recorded in
`claude-followup-review.md`.

## Finding disposition

### 1. Capture-start timeout could terminate an active core

Status: resolved.

`CoreClient.handleTimeout()` now treats a timed-out capture-start method as a
potentially active recording. It keeps the child process alive, enters the
degraded capture state, preserves the close guard, and leaves Stop available.
The controllable-core test covers the timeout, degraded state, successful Stop,
and recovery-state cleanup.

### 2. Retry could clear recovery after a core exit

Status: withdrawn after state tracing and a proving test.

`handleExit()` records recovery and then moves the supervisor to `exited`.
`retryConnection()` therefore follows the ordinary handshake path, not the
degraded capture-status probe. That path does not clear the recovery marker.
The exit-during-capture test proves the marker remains set after a replacement
core connects.

### 3. Rust accepted bare request envelopes

Status: resolved.

The Rust JSONL boundary now requires protocol version, request ID, and sent-at
metadata on every parsed request. All direct proof clients use the shared
versioned request helper. Rust tests reject bare and partial envelopes.

### 4. Dead synchronous export IPC remained registered

Status: resolved.

The obsolete `candor-export:saveLocal` handler and its unused imports were
removed. Static Electron and product-surface checks reject reintroduction of the
channel.

### 5. Trust-boundary files were not source-audit requirements

Status: resolved.

The source-security audit now requires the operation registry, private core
input validator, capture recovery store, jobs IPC module, and versioned proof
request helper. Each file also has a distinctive contract check.

### 6. Capture active-session data was not runtime validated

Status: resolved.

The capture-status schema now requires `activeSession` to be null or an object
with a nonempty string `recordingId`. Shared valid and invalid fixtures cover
the rule.

## Follow-up verdict

Claude independently re-read `git diff 918ee24`, re-evaluated all six findings,
and returned `APPROVE`. It identified no regression in the reconciliation.

## Hosted CI follow-up

The first PR run exposed a cross-platform timing race in the oversized-response
fault harness. Ubuntu and macOS timed out while transferring a 24 MB test line
before the boundary fault reached the client. The test now injects a 1,024-byte
limit only for that harness mode and sends a 2,048-byte line. Production still
uses the 24 MB response limit.

The fault harness passed six consecutive local runs, and the complete staged
verification passed. Claude reviewed the final three-file change in
`claude-ci-followup-review.md` and returned `approve` with no required changes.

Claude review is advisory. Repository tests and release evidence remain the
authoritative acceptance record.
