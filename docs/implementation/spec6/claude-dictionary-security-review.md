I now have a complete picture of all the in-scope code. Here is my review.

---

## SPEC-6 Dictionary Security and Migration — Independent Review

**Base commit**: `9eaf4e220731127f7de601abf105bd0eab6342c1`
**Scope**: dictionary staging, package verification, terminology store, job lifecycle, IPC layer, renderer workspace, bundle verifier

---

### Critical findings: **none**
### High findings: **none**
### Medium findings: **none**

---

### Low findings

---

#### L1 — `jobs.cancel` IPC: ghost-reference window if the physical delete succeeds but `discard_dictionary_staging` then fails

**File**: `crates/candor-core/src/main.rs:1801–1824`

```rust
match state.job_manager.cancel(&params.job_id) {
    Ok(value) => {
        let staging_token = ...dictionary_staging_reference...?;
        if let Some(token) = staging_token {
            if let Err(error) = state.dictionary_staging.delete(&token) {
                return make_error_with_retryability(...);  // ← returns here
            }
            if let Err(error) = state.job_manager.discard_dictionary_staging(...) {
                return make_job_error(id, error);           // ← or here
            }
        }
```

**Impact**: If `staging.delete` succeeds but `discard_dictionary_staging` fails (e.g. mutex poisoned), the on-disk staging file is gone but the job descriptor still carries the token. The descriptor is therefore a dangling reference. `dictionary_staging_references()` will include the orphan token and block `cleanup_orphans` from treating it as an orphan. The entry is cleaned up at the next `apply_retention` run (startup or hourly), which correctly removes cancelled `DictionaryImport` descriptors and returns their tokens. Encrypted contents are never re-readable, so there is no confidentiality impact; correctness is restored within one hour.

**Evidence**: `maintain_dictionary_staging` → `apply_retention` at `main.rs:261,388–396`; cancelled-dictionary retention path at `job_manager.rs:1239–1252`.

**Fix**: Swap the order — call `discard_dictionary_staging` first (takes the token out of the descriptor, making the reference inert), then call `staging.delete`. If the delete then fails retryably, the token is returned and can be re-submitted; if it fails with NotFound the file is already gone.

```rust
if let Some(token) = staging_token {
    state.job_manager.discard_dictionary_staging(&params.job_id)?;
    if let Err(e) = state.dictionary_staging.delete(&token) {
        if e.retryable { return make_error_with_retryability(...); }
        // NotFound is already handled as Ok() in DictionaryStaging::delete
    }
}
```

---

#### L2 — `write_job_document` uses `create(true).truncate(true)` for its temp file instead of `create_new(true)`

**File**: `crates/candor-core/src/main.rs`-invoked `write_job_document` at `job_manager.rs:2393–2398`

Both `terminology_dictionary.rs:1237–1249` and `dictionary_staging.rs:154–163` explicitly remove any pre-existing temp file then use `create_new(true)`. `write_job_document` silently truncates an existing temp file via `create(true).truncate(true)`. Under the serialising `persistence_lock` this is safe, but if the file creation fails for a non-permissions reason (e.g. quota exceeded), there is no cleanup of the partially-created temp file, and the error path at `job_manager.rs:2426–2436` restores the target from backup but leaves the temp file intact. Subsequent writes succeed because `truncate(true)` overwrites it.

**Impact**: Negligible — the temp file is encrypted, cannot be read without the OS key, and is overwritten on the next persist call. However, the inconsistency could produce confusion during incident analysis.

**Fix**: Mirror the pattern used elsewhere:
```rust
let temporary = config.root.join(JOB_STORE_TEMP_FILE);
if temporary.exists() {
    fs::remove_file(&temporary).map_err(|_| ...)?;
}
let mut file = OpenOptions::new().create_new(true).write(true).open(&temporary)...;
```

---

### Invariant verdicts

| # | Invariant | Verdict |
|---|-----------|---------|
| 1 | Persisted descriptors contain only token, SHA-256, display name, byte count; legacy Base64 in schema-v1 only | **PASS** — `validate_current_descriptor` rejects any schema-v2 document where `legacy_archive_base64` or `legacy_source_file_name` is present (`job_manager.rs:2074–2078`). `bounded_persisted_result` caps the result field. |
| 2 | Staged archives authenticated/encrypted, atomic write, path-contained, regular-file only, size bounded, re-verified before import | **PASS** — ChaCha20Poly1305 with per-token AAD; temp→sync→rename; `symlink_metadata` + dual `is_file`/`is_symlink` check; `MAX_ARCHIVE_BYTES = 2 500 000`; canonical-path containment check; `read_verified` called immediately before `import_dictionary` (`background_jobs.rs:502`). |
| 3 | Success/cancel/non-retryable-failure delete staged data; retryable, Ask, terminal, orphan obey bounded retention | **PASS** — Success path: `remove_dictionary_staging` at `background_jobs.rs:555`. Cancel path: IPC handler deletes then discards (`main.rs:1811–1823`); `jobs.cancelAll` clears all refs (`main.rs:1832–1844`). Non-retryable failure: file deleted at `background_jobs.rs:509,534,551`. Retryable: `RETRYABLE_DICTIONARY_STAGING_RETENTION_MS = 72 h` enforced by `apply_retention`. Ask questions cleared by `apply_retention` after `ASK_QUESTION_RETENTION_MS = 24 h` from both the descriptor and the persisted result. Terminal jobs removed after `TERMINAL_JOB_RETENTION_MS = 7 d`. Orphans: 24 h via `cleanup_orphans`. |
| 4 | Schema-v1 migration: backup, stage each archive, commit schema v2, verify, restore byte-for-byte on failure; oversized archives don't drop other jobs | **PASS** — `prepare_job_document` copies to `migration.bak` before any mutation (`job_manager.rs:1999`); iterates all descriptors via `migrate_descriptor`; writes then reads back and validates the upgraded document; on any error removes created staging tokens, removes the failed target, and renames the backup back (`job_manager.rs:2029–2040`). Tested by `oversized_legacy_dictionary_migration_rolls_back_without_data_loss` — the Recap job in the same store is preserved and the store reverts byte-for-byte. |
| 5 | Conflict order: meeting, project, org, personal, specialist, general; then preference, context relevance, category match, approved corrections, semver, stable ID | **PASS** — `DictionaryScope::precedence()` assigns 0–5 exactly as specified; `selected_entry_order` compares in the correct ascending/descending direction for each tier (`terminology_dictionary.rs:1710–1730`). Covered by `dictionary_conflicts_follow_scope_then_fixed_tie_breakers`. |
| 6 | Project scope cannot activate before a real project identifier exists | **PASS** — `dictionary_scope_is_valid` returns `false` unconditionally for `DictionaryScope::Project` (`terminology_dictionary.rs:1624`). `validate_document` enforces this at every read and write. Covered by `legacy_trust_is_downgraded_and_project_scope_is_reserved`. |
| 7 | Only the exact bundled key ID + Ed25519 bytes produce `verified-candor`; all other labels visibly downgraded | **PASS** — `verify_candordict_bytes_with_trust` requires both `anchor.key_id == signature.key_id` AND `anchor.public_key == signing_public_key` (`dictionary_package.rs:235–252`). `normalize_legacy_dictionary_metadata` downgrades `"verified-candor-bundle"` and any other non-canonical label to `"community-unverified"`. `validate_document` whitelists only `None`, `"community-unverified"`, and `"verified-candor"`. |
| 8 | Publisher-key schema enforces positive rotation generation; private keys and model assets outside Git | **PASS** — `DictionaryTrustAnchor::from_json_bytes` rejects `rotation_generation == 0` (`dictionary_package.rs:132`). `spec3-verify-ai-bundle.mjs:130` independently enforces `rotationGeneration < 1` in the build verifier. |
| 9 | No archive bytes, keys, paths, prompts, transcripts, or persisted Ask questions in renderer-facing state or diagnostics | **PASS** — `status_for` emits only name, IDs, counts, flags; all response objects carry `rawPathExposed: false`, `keyMaterialExposedToRenderer: false`. `whisper_prompt` is never exposed beyond the core. Ask questions are nulled from both descriptor and result after 24 h by `apply_retention` (`job_manager.rs:1226–1237`). Job `value(false)` omits result entirely for list endpoints; `value(true)` for `jobs.get` may include a `question` field from the result, which is by design (user's own question) and is scrubbed after acknowledgement or 24 h. |

---

### No critical or high findings remain.

The two low-severity observations (L1, L2) are in the job-cancel cleanup path and an inconsistency in temp-file creation; neither creates a data-exposure risk given the existing encryption and retention machinery. All nine invariants are satisfied by the code as written and supported by the test suite.
