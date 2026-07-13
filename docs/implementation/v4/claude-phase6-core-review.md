I now have full visibility into all four source files and the vault implementation (which lives in `vault_store.rs`, not `sqlcipher_vault.rs`). Here is my analysis.

---

## Verdict: GO WITH REQUIRED FIXES

The architecture is solid. Migration, quarantine, and deletion flows all implement the stated invariants correctly — with **one exception that requires a fix before shipping.**

---

## Findings — Ordered by Severity

### DEFECT 1 — HIGH | Schema-0 manifests fall through to rebuild, violating Invariant 1

**File:** `recording_store.rs:2100–2104`
**Evidence:**
```rust
fn load_or_rebuild_manifest(...) -> Result<RecordingManifest, ...> {
    match read_manifest(dir) {
        Ok(manifest) => Ok(manifest),
        Err(error) if error.code == "RECORDING_MANIFEST_SCHEMA_TOO_NEW" => Err(error),
        Err(_) => self.manifest_from_chunks(recording_id, dir),  // ← fallthrough
    }
}
```
`parse_and_validate_manifest` returns `RECORDING_MANIFEST_SCHEMA_UNSUPPORTED` for schema version 0. That error code does **not** match the guard and falls through to `manifest_from_chunks`. The caller (`recover()`) then calls `write_manifest`, overwriting the schema-0 file with a schema-2 rebuild.

**User impact:** Any schema-0 recording on disk is silently rebuilt. Label and privacy events are lost. The invariant "unsupported manifests are never modified" is violated.

**Fix — one line:**
```rust
match read_manifest(dir) {
    Ok(manifest) => Ok(manifest),
    Err(error) if error.code == "RECORDING_MANIFEST_SCHEMA_TOO_NEW" => Err(error),
    Err(error) if error.code == "RECORDING_MANIFEST_SCHEMA_UNSUPPORTED" => Err(error),  // ADD
    Err(_) => self.manifest_from_chunks(recording_id, dir),
}
```
The recording will then be quarantined, matching the future-schema behavior.

---

### DEFECT 2 — MEDIUM | `.bak` is deleted before rename succeeds; silent restoration swallows the error

**File:** `recording_store.rs:2973–2990`
**Evidence:**
```rust
if backup_path.exists() {
    fs::remove_file(&backup_path)?;   // step 1: .bak deleted
}
// ...
if had_manifest { fs::rename(&manifest_path, &backup_path)?; }  // step 2
if let Err(err) = fs::rename(&tmp_path, &manifest_path) {       // step 3 fails
    if had_manifest && backup_path.exists() {
        let _ = fs::rename(&backup_path, &manifest_path);        // step 4 silently ignored
    }
    return Err(...);
}
```
If step 3 fails AND step 4 silently fails: `.json` is gone, `.bak` is gone, `.tmp` holds the uncommitted new manifest. `read_manifest` falls back to `.tmp`, so the caller receives an error but the next read succeeds with the "failed" write's content. This is a false-error (over-conservative), not a false-success — the data is safe — but it breaks error semantics and could confuse retry logic in the renderer.

**Fix:** Move step 1 (remove old `.bak`) to **after** step 3 succeeds. The `.bak` rotation becomes post-commit cleanup rather than a prerequisite, eliminating the window where no safe manifest exists.

---

### DEFECT 3 — LOW | `scan_chunks` fully decrypts every chunk just to obtain plaintext length

**File:** `recording_store.rs:2056–2063`
**Evidence:** `decrypt_chunk_len` calls `decrypt_chunk_bytes`, reading and decrypting the entire file to return `len()`. For a long recording with many large audio chunks, recovery could be very slow.

**Fix:** Store the plaintext byte count in the first few bytes of the `.cchunk` envelope header, or fall back to `stored_bytes - overhead` as an approximation during scan-rebuild. Not critical but notable for recordings approaching the real hardware-recording duration that is currently unverified.

---

## Explicit Invariant Assessments

**Migration downgrade safety:** `VAULT_SCHEMA_TOO_NEW` is returned before any connection is modified (`vault_store.rs:532–538`). The vault file is byte-identical after the call. The file-digest comparison in `create_durable_verified_backup` and the `verify_legacy_v1_after_failed_migration` post-rollback check close the loop on the "commit without valid backup" question. **PASS.**

**Backup atomicity:** Backup is created inside an EXCLUSIVE SQLite transaction after WAL is checkpointed to DELETE mode (`prepare_for_raw_backup` then `migrate_v1_to_v2`). The partial file (`*.partial`) guard prevents a half-written backup from appearing as complete. Two-level verification (size + SHA-256) is performed before and after rename. **PASS.**

**Quarantine immutability:** Every per-recording error in `recover()` and `collect_recording_manifests()` goes to `quarantine_summary` without any write to the recording directory. `contentModified: false` is truthful. No healthy meetings are hidden because each directory is processed independently. **PASS.**

**Deletion retry safety:** The pending-marker is written atomically (`.tmp` → rename) before the active dir is moved. `recover_pending_deletions` on every startup drives the state machine to completion regardless of which step was interrupted. The only-pending-marker path in `delete_finished` correctly skips the Finished re-check because the marker is only ever written after that check passes. **PASS.**

**False-saved risk:** `write_durable_chunk_file` uses `create_new(true)` and removes the file on `write_all` or `sync_all` failure. The manifest is pushed only after the chunk file succeeds and synced. `write_manifest` errors propagate as chunk-write errors to the caller. No path exists where the API returns success but the chunk or manifest was not durably committed. **PASS.**

---

## Adversarial Question Answers

**Crash/WAL/rename/ordering:** The manifest is resilient — `.tmp` is written and synced before `.bak` rotation, and all three candidates are tried in priority order. Chunk writes fail visibly; no orphaned chunk causes a false-success state. `NeedsRecovery` is set on restart for any `Recording`-state recording.

**Migration without backup or on future schema:** Future schema is rejected before the connection executes any DDL. The backup is verified (SHA-256 + size) and atomically committed before the exclusive transaction commits schema changes. Rollback is verified by re-reading schema version and row count. **No path exists to commit without a valid backup.**

**Corrupt/future manifest fallthrough:** Future manifests are quarantined, not rebuilt. Schema-0 manifests **currently fall through** — this is Defect 1 above.

**Deletion leaving unrecoverable index/intent:** `reconcile_recovered_deletions` on every startup cleans vault index entries for any ID listed in `completedDeletionIds`. If vault cleanup fails, the pending marker survives and the cycle repeats. The index is eventually consistent, not immediately consistent — this is acceptable and intentional.

**Disk check bypass:** The TOCTOU window between `ensure_chunk_write_space` and `write_durable_chunk_file` is real but harmless. If the write fails, the partial file is removed, the manifest is unchanged, and the error propagates. Recovery correctly marks the recording `NeedsRecovery`. No false-success is possible.

**Test assertion quality:** Migration tests (`failed_migration_rolls_back_and_retains_the_verified_backup`, `future_schema_is_rejected_without_rewrite_or_backup`, `wal_vault_is_checkpointed_and_backed_up_in_delete_mode`) assert the dangerous behaviors, not just response shape. Capture tests do the same for overflow and writer-failure paths. **Missing:** no test for the schema-0 fallthrough, no test for manifest `.tmp` fallback path after a simulated rename failure, and no test for the disk-check-fail-then-write-fails scenario. These gaps do not block shipping but should be filed.

---

## Smallest Required Fix Set

1. **`recording_store.rs:2102`** — Add `Err(error) if error.code == "RECORDING_MANIFEST_SCHEMA_UNSUPPORTED" => Err(error),` to `load_or_rebuild_manifest`.

**Re-review files after fix:**
- `recording_store.rs` — confirm the new arm is present, confirm existing `recover()` and `collect_recording_manifests()` correctly quarantine on the propagated error, and add one test that seeds a schema-0 manifest and asserts it is quarantined rather than overwritten.
