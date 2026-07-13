# Phase 6 Data Safety Design Reconciliation

Date: 2026-07-13

Claude review: `claude-phase6-data-safety-plan-review.md`

Verdict received: **Go with required fixes**

## Accepted Findings

1. Replace the existing unconditional SQLCipher `migrate()` implementation. It
   must never rewrite a current or future schema to version 1.
2. Return the schema version read from the database. No response may hardcode
   version 1 after migration.
3. Check SQLite journal mode before raw encrypted backup. Checkpoint and leave
   WAL mode before copying the main vault file.
4. Catch the complete per-recording recovery path. A chunk-scan failure must
   quarantine that one opaque recording and continue loading healthy siblings.
5. Implement a real delete operation that never consults license state.
6. Flush and `sync_all()` the encrypted migration backup before changing the
   original vault.
7. Capture pre-migration SQLCipher KDF/page settings and row/table invariants,
   then verify that migration preserves them. Do not force a hardcoded KDF value
   onto an existing vault.
8. Document the benign close race. `shutdown()` performs the second capture-state
   check and keeps the app open if capture starts during close.
9. Do not advertise true transcription or LLM cancellation over the current
   synchronous core loop. A renderer-only abort is not cancellation.

## Adjusted Findings

### Deletion

Claude proposed a bare `remove_dir_all` and called it atomic. Recursive removal is
not atomic and can fail after deleting only part of a recording. Candor will use:

1. exact opaque recording ID validation;
2. rejection while the recording is active or not durably finished;
3. explicit native user confirmation;
4. same-filesystem rename into a core-owned deletion tombstone;
5. recursive removal of the tombstone;
6. structured incomplete-deletion status if removal fails.

The recording disappears from the active library at the rename boundary. Success
is returned only when the tombstone is gone. This is still permanent deletion,
not an undoable trash feature.

### Forced Operating-System Exit

Launching an asynchronous finalization promise from Electron `will-quit` does not
guarantee that the OS waits for it. Ordinary close and application quit remain
protected by the installed close guard. Forced termination is covered by durable
chunks and deterministic startup recovery. The app will not claim that it can
delay Task Manager, power loss, or an uncooperative OS shutdown.

## Retained User Requirements

Claude suggested deferring disk pressure and next-launch backup retention. V4
keeps both because the accepted user specification explicitly requires them.

- The encrypted migration backup remains through the launch that migrated and
  is removed only after a different core launch verifies schema and row
  invariants.
- Low disk is persistent and warning-level. Blocking reserve prevents a new
  recording. A chunk write failure preserves the last committed manifest and
  yields a recoverable recording state.

## Already Complete

- Capture-aware close guard: commit `b7b0aea`.
- Content-free diagnostic preview and local export: commit `7d4e3b1`.

The original review request was written before those commits and is intentionally
preserved as timing evidence.

## Required Implementation Order

1. SQLCipher migration tests and migration framework.
2. Manifest future-version checks and per-record quarantine.
3. Disk health contract and durable write guards.
4. Confirmed license-independent deletion.
5. Renderer recovery and persistent storage-pressure states.
6. Full staged and packaged verification.
7. Focused Claude implementation review and finding disposition.

No persisted-data implementation begins until this reconciliation is recorded.
