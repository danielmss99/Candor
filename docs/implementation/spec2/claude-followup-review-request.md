# Claude follow-up implementation review request

Review the uncommitted reconciliation changes made after your first review in
`docs/implementation/spec2/claude-implementation-review.md`.

This is a read-only review. Do not modify files. Inspect:

```text
git diff 918ee24
git diff --check
```

## Finding dispositions to verify

### Finding 1: capture-start timeout kill

Accepted and fixed. `CoreClient.handleTimeout(method)` now treats a timed-out
capture-start method as potentially active, enters
`capture-connection-degraded`, keeps the child alive, keeps the capture guard
active, and leaves Stop callable. The request registry removes the pending
entry before `handleTimeout`, so the fix intentionally checks the `method`
argument rather than querying the registry.

`hang-during-capture-start` was added to the controllable core. Its test proves:

- capture start times out;
- the child is not killed;
- degraded and recovery-required state is visible;
- capture remains guarded as potentially active;
- Stop succeeds;
- successful Stop clears degraded recovery state.

### Finding 2: retry clears recovery after process exit

Rejected after tracing and testing. In `handleExit`, capture recovery is recorded
first, then supervisor state becomes `exited`. Therefore `retryConnection()`
does not enter its `capture-connection-degraded` probe branch after a process
exit. It takes the ordinary handshake and `core.status` path, which does not
clear `captureRecoveryRequired`.

The `exit-during-capture` test now retries the replacement core and proves the
post-retry state is:

```text
state: running
captureActive: false
captureRecoveryRequired: true
```

Please verify whether this evidence fully disposes the finding. Report a defect
only if you can identify a reachable state transition that still clears the
process-exit recovery marker before explicit recovery.

### Finding 3: bare Rust envelopes

Accepted and fixed. Rust now requires all three metadata fields for every parsed
request. A Rust test rejects a bare `core.version` request. All 20 direct proof
clients now use `scripts/core-rpc-envelope.mjs` to send UUID v4 request IDs,
protocol version, and ISO timestamp metadata.

### Finding 4: dead synchronous export handler

Accepted and fixed. `candor-export:saveLocal` was removed. Static product and
Electron security checks now reject its reintroduction.

### Finding 5: required security source paths

Accepted and fixed. The four trust-boundary files are required by the source
security audit, with distinctive contract checks. The versioned proof-client
helper is also required.

### Finding 6: unvalidated capture active session

Accepted and fixed. `capture.status` now requires `activeSession` to be null or
an object with a nonempty string `recordingId`. Shared valid and invalid fixtures
cover the contract.

## Post-fix verification

- `npm run v3:verify`: passed.
- Rust: 87 tests passed.
- Vitest: 40 files, 134 tests passed.
- Rust formatting check: passed.
- Strict Clippy with `-D warnings`: passed.
- `npm run test:electron:build`: passed, 5 Playwright tests.
- Source-security proof: passed.
- M3 product-surface smoke: passed.
- `git diff --check`: passed.

## Required response

1. Re-evaluate each original finding as resolved, unresolved, or withdrawn.
2. Report any regression introduced by the reconciliation with severity,
   exact file and line or symbol, evidence, impact, fix, and proving test.
3. Give a final verdict: `approve`, `approve with non-blocking follow-ups`, or
   `changes required`.

Do not restate the implementation and do not report the already documented
external signing, hardware, cross-OS, network, clean-install, upgrade, or
duration evidence gaps as new code defects.
