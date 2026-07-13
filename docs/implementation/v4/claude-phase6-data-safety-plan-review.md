I have now read all the key sources. Here is the adversarial review.

---

# Phase 6 Data Safety Design Review

**Verdict: GO WITH REQUIRED FIXES**

Five fixes must land before any migration code ships. Two findings are design-level corrections. Several questions get definitive answers. Evidence is grounded in the source files read above.

---

## Findings

### Finding 1 — HIGH | vault_store.rs:516

**The `migrate()` function runs unconditionally on every `open_os_key_connection()` call and contains the silent downgrade bug the plan was written to fix.**

Evidence: `vault_store.rs:516` runs `INSERT OR REPLACE INTO candor_meta(key, value) VALUES ('schemaVersion', '1')` inside `execute_batch()`. `open_os_key_connection()` (line 367) always calls `migrate()`. After shipping schema 2, every open of an existing schema 2 vault silently rewrites `schemaVersion` back to `'1'`. The open returns the keyed connection and the caller is unaware.

The plan's intent (detect version, gate migration, reject futures) is correct. The implementation must replace the current `migrate()` entirely — not wrap it — so the downgrade path is removed at the root. Any implementation that calls the old `migrate()` at any point for an existing vault will reproduce the bug.

Smallest safe correction: gate the whole `execute_batch` body behind a version detection block; never call `INSERT OR REPLACE` on `schemaVersion` for a vault that already has a row there; write the version value only inside the migration transaction and only after verifying it is not already ≥ 2.

---

### Finding 2 — HIGH | vault_store.rs:133 and `open_or_create()` return value

**The `open_or_create()` response hardcodes `"schemaVersion": 1` as a JSON literal rather than reading it from the database.**

Evidence: line 133 of `vault_store.rs`:
```rust
"schemaVersion": 1,
```
After the plan ships schema 2, every call through `open_or_create()` (used by the passphrase-proof path and its tests) will report version 1 to callers regardless of what the database actually contains. This creates a false invariant in all the tests that assert `opened["schemaVersion"]` — they will still pass while the underlying database holds a different value.

Smallest safe correction: after migration, call `read_schema_version(&conn)?` and embed the result in the response JSON. The tests must then assert the actual dynamic value.

---

### Finding 3 — HIGH | vault_store.rs migration backup path

**The plan copies the encrypted vault file without first verifying that SQLite is in DELETE (rollback-journal) mode. A WAL-mode vault produces an incomplete backup.**

Evidence: the Rust source contains no `PRAGMA journal_mode` call anywhere in the crate (only in generated bindgen output). SQLite and SQLCipher default to DELETE mode, so the current production vault is almost certainly in DELETE mode and a post-close copy is safe. However, the plan never states this assumption, and a future feature (or a user who previously opened the vault with a WAL-enabling client) could have left WAL mode active. In WAL mode, copying only the main file omits committed pages still in the WAL file, silently producing a partial backup.

Smallest safe correction: before closing the connection for backup, run:
```sql
PRAGMA journal_mode;
```
If the result is `wal`, run `PRAGMA wal_checkpoint(TRUNCATE)` followed by `PRAGMA journal_mode=DELETE`. Verify the mode is `delete` before proceeding. This is a one-time check inside the schema 1 → 2 migration path and has no cost at runtime once schema 2 is confirmed.

---

### Finding 4 — HIGH | recording_store.rs:1704–1706, all_recording_manifests

**A recording directory where both `manifest.json` and its candidates are corrupt, and where `scan_chunks()` also fails (e.g. OS error reading the directory), propagates an error that aborts the entire library list. The plan's quarantine receipt only helps if the fault is caught; the current fallback path still throws.**

Evidence: `all_recording_manifests()` line 1706:
```rust
Err(_) => self.manifest_from_chunks(&id, &entry.path())?,
```
The `?` means `scan_chunks()` failure propagates to the caller. `list()`, `list_page()`, `search()`, and `all_recording_summaries()` all call `all_recording_manifests()`. One unreadable recording directory with a failed directory scan (permission error, deleted by antivirus, NTFS corruption) silently fails the entire library.

The plan says "leave corrupt recording directories untouched … omit that record from normal lists while continuing to return healthy recordings." The fix must also cover the `manifest_from_chunks()` → `scan_chunks()` arm, not only the initial `read_manifest()` arm. The quarantine receipt path must be the fallback for any error in this loop, not just parse errors.

Smallest safe correction: wrap the entire per-directory block (both `read_manifest` and `manifest_from_chunks`) in a match that, on any error, writes a quarantine receipt and `continue`s rather than propagating. The `?` must not appear inside this loop.

---

### Finding 5 — HIGH | G: No delete RPC exists anywhere in the codebase

**The mission states "existing recordings must remain openable, exportable, and deletable regardless of license or network state." There is no `recording.durable.delete` IPC method, no Rust implementation, and no UI affordance.**

Evidence: searching the entire TypeScript IPC layer and Rust core for any delete operation returns zero results. `retention_status()` (recording_store.rs:305–319) confirms `"policy": "manual-delete-only"` but there is no mechanism inside the app to perform that deletion.

The plan's proposed Section G (trash + undo + purge) is over-engineered for Phase 6. Undo requires a durable trash area, a purge operation, and a UI recovery path — all of which can come later. A bare delete — `fs::remove_dir_all` wrapped in `validate_id` — satisfies the guarantee for Phase 6 and is consistent with the mission. Undo and trash are Phase 7 scope.

Smallest safe correction for Phase 6: implement `recording.durable.delete` in Rust as an atomic `remove_dir_all` on the validated recording directory. Write no quarantine receipt; the user asked for deletion. Return a pathless success or structured error. The license service must not be consulted. No IPC method other than this exact one is required to satisfy the Phase 6 mission statement.

---

### Finding 6 — MEDIUM | vault_store.rs backup write

**The plan byte-copies the encrypted vault to the backup file but the proposal text does not require `sync_all()` on the backup before proceeding with migration. A power failure during backup write produces a silently truncated backup.**

The current `write_manifest()` model (recording_store.rs:2344–2352) correctly calls `sync_all()` on every write. The vault backup path must follow the same discipline: open the backup file, write all bytes, call `sync_all()`, close, then proceed to reopen the vault and run the migration transaction. Only after `sync_all()` is confirmed successful is it safe to touch the original.

---

### Finding 7 — MEDIUM | electron/main.ts:159–161, will-quit path

**`will-quit` swallows `CORE_CAPTURE_ACTIVE` silently. A system-forced quit (OS shutdown, log-off, Task Manager) during an active recording abandons the core without calling `finalizeCaptureForClose()`.**

Evidence:
```ts
app.on("will-quit", () => {
  void coreClient.shutdown().catch(() => undefined);
});
```
`shutdown()` throws `CORE_CAPTURE_ACTIVE` if capture is active; `.catch(() => undefined)` discards it. The core is not sent a `capture.stop` before the process exits. The OS then terminates the process. Startup recovery will mark the recording `NeedsRecovery`, so no data is permanently lost, but the close guard's "stop, save, and quit" protection does not apply.

This cannot be fully fixed — OS-level forced quits cannot always be deferred. However the `will-quit` handler should attempt `finalizeCaptureForClose(timeoutMs)` with a short deadline (e.g. 3000 ms) before falling back to a bare `shutdown()`. If that also fails, allow the quit; recovery handles the rest. The `.catch(() => undefined)` on a capture-aware path is dangerous when the error is not meaningless.

---

### Finding 8 — LOW | Section D already implemented

**The "Current Evidence" in the review document says "electron/main.ts shuts down the core in before-quit but has no capture-aware close guard." This is factually false as of the current branch.**

Evidence: `electron/main.ts` lines 12–13 and 76–108 install `installCaptureCloseGuard` with `phase()`, `confirmStopAndQuit`, `finalizeCapture`, `shutdownCore`, and `reportFailure` fully wired. `electron/window/capture-close-guard.ts` is complete. `captureGuardPhase()` and `finalizeCaptureForClose()` are implemented in `core-client.ts`. The close guard is part of the current branch; the documentation was written before that commit landed.

The plan's proposed Section D is already done. Remove it from the "Proposed Implementation" list and note it as complete in the Phase 6 verification checklist. Carrying it as an open task risks duplicate or conflicting implementation.

---

### Finding 9 — LOW | Close guard race is benign but must be documented

**There is a TOCTOU window between `phase()` returning "idle" in the close guard and `shutdown()` executing its own `captureGuardPhase()` check. A new recording that starts in that window is caught by the second check.**

`shutdown()` re-checks `captureGuardPhase()` (core-client.ts:223) and throws `CORE_CAPTURE_ACTIVE`, which the close guard's catch block forwards to `reportFailure()`. No data is lost; the user sees the error modal and must try again. The race is benign. The smallest safe correction is a single-sentence code comment explaining this design rather than any code change.

---

## Answers to the Eight Questions

**Q1: Is raw file copy safe at the proposed point?**
Yes, for the current codebase — the vault uses SQLite DELETE (rollback journal) mode and no PRAGMA sets WAL. After a clean close, the main file is complete. But the plan must add an explicit journal-mode check (Finding 3 above) before any copy proceeds, because this assumption is not enforced anywhere in code.

**Q2: Is launch-ID backup retention sufficient to prove "successful next launch"?**
No, but it is a reasonable proxy. The launch-ID proves "the migration transaction committed and the vault opened successfully on a subsequent process start." It does not prove the user performed any operation successfully. This is acceptable for a Phase 6 proof, provided the plan documents the limitation explicitly. A more durable definition of "success" (e.g., first successful `list_recordings`) would be stronger but adds complexity that is not justified for Phase 6.

**Q3: Corrupt manifests — skip with receipt or fail closed?**
Skip. Failing closed violates the primary mission requirement that healthy recordings remain accessible. The current behavior already skips corrupt manifests by falling back to chunk scanning; the plan extends this correctly by quarantining directories where even chunk scanning fails. The quarantine receipt must be persisted outside the recording directory to avoid dirtying the recording's own directory.

**Q4: What invariants are missing from the SQLCipher and manifest verification?**

For SQLCipher schema 2 post-migration invariants:
- `PRAGMA cipher_version` is non-empty (already checked in `validate_sqlcipher`)
- `PRAGMA kdf_iter` matches the expected value (SQLCipher default 256000; must not change across migration)
- `PRAGMA cipher_page_size` unchanged
- Both `candor_meta` and `candor_recordings` tables exist with the expected column count
- `candor_recordings` row count matches the pre-migration row count (stored before migration begins)
- `schemaVersion` reads as `'2'` after commit

For recording manifest migration invariants:
- `recording_id` in migrated manifest matches the directory name
- `chunks.len()` equals the pre-migration count
- Each `chunk.file_name` in the chunk list corresponds to an existing file on disk
- Chunk indices are contiguous from 0 (no gaps, no duplicates)
- `state` is not a variant unknown to the new code

**Q5: Does the close guard have a race between status check and stop, and what is the smallest safe correction?**
The race exists (Finding 9) and is benign. The second `captureGuardPhase()` check inside `shutdown()` catches a recording that starts between the close guard's idle check and `shutdown()`. No code change is required; a code comment explaining the design is sufficient.

**Q6: Which items are required for Phase 6 and which should be deferred?**

Required (Phase 6 incomplete without these):
- A: SQLCipher migration framework with version detection, reject-future-versions, backup, single transaction, rollback path (Findings 1–3, 6)
- B: Manifest quarantine so one corrupt recording cannot fail the library list (Finding 4)
- G: Bare `recording.durable.delete` (Finding 5)

Already done (remove from plan):
- D: Capture-aware close guard (Finding 8)
- E: Basic safe diagnostics (`diagnostic-report.ts` is implemented and already allowlisted)

Safe to defer to Phase 7:
- A.7: Two-launch backup-retention proof (acceptable, but not needed to prevent data loss)
- C: Disk pressure (important feature, not a data-loss bug in the current codebase)
- G trash/undo/purge beyond bare delete

**Q7: Is there a safe incremental true-cancellation design with the current synchronous stdio core?**
No. The Rust JSONL dispatch loop is single-threaded and synchronous. While a `capture.stop` or transcription call is executing, the loop cannot receive a second message. A renderer `AbortController` would abandon the Node.js side of the response without interrupting the Rust work; the core would continue running until the blocking call returns, then write a response to stdout that nobody is reading. The pipe buffer would eventually fill and block the core process itself.

Cooperative cancellation (a flag checked between segments/chunks) is implementable but requires adding async infrastructure (tokio or a cancel-token pattern) to the Rust core. That is Phase 7+ scope. Phase 6 must explicitly document this gap in `CLAUDE.md` or an implementation note so no future developer ships a dishonest "cancelling…" UI state over a synchronous call.

**Q8: Must the data-safe local trash operation ship in Phase 6 to make the licensing guarantee real?**
Yes, but only as a bare delete. The mission guarantees recordings are "deletable regardless of license." Without any delete RPC, the app cannot fulfill this guarantee programmatically — the user must use the OS file manager. For a local-first privacy product, that is not acceptable. The trash/undo/purge design in the plan is significantly over-scoped for Phase 6. Implement `recording.durable.delete` as a plain atomic removal (Finding 5). If the user asks for undo, that is Phase 7.

---

## Verification Expectations — Gaps

The plan's verification list omits the following required tests:
1. Open a schema 2 vault, close, reopen — assert `schemaVersion` is still `'2'` (guards against Finding 1 reintroduction)
2. Copy a vault file in WAL mode and verify the backup test forces DELETE mode first (guards Finding 3)
3. A recording directory with an unreadable directory (simulate with a non-directory block) must not prevent `list()` from returning other recordings (guards Finding 4)
4. `recording.durable.delete` removes the directory and the recording no longer appears in `list()` — license state not consulted (guards Finding 5)

---

## Final Verdict

**GO WITH REQUIRED FIXES**

Five findings (1–5) must be resolved before any migration code is committed. Findings 6–7 should land in the same PR. Finding 8 is a documentation correction only. The underlying architectural direction is sound: the backup-before-migration pattern, quarantine receipts, and close guard design are all correct. The blocking issues are implementation correctness (downgrade bug, hardcoded schema version, WAL assumption, library-abort, missing delete) not architectural flaw.
