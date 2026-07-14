I now have enough to write the full review. Here is the complete SPEC-6 independent architecture, security, and migration review.

---

# SPEC-6 Independent Architecture, Security, and Migration Review

**Scope:** `codex/spec6-ai-release-completion` against base `9eaf4e2`
**Reviewer stance:** independent — no implementation context carried in; decisions below are derived solely from the read artifacts.

---

## Executive Summary

The implementation is structurally sound and the most critical invariants (no heuristic output during cancellation/preemption, honest trust labels, encrypted staging) are correctly enforced. Eleven issues are documented below. None is a production blocker in isolation, but two interact in ways that could produce user-visible heuristic output without a disclosed fallback notice in a narrow window. All six spec questions receive concrete answers. Three spec requirements should be modified for safety.

---

## Phase-Ordered Plan

### Phase 0 — Already Landed and Verified Correct

| Area | File | Status |
|---|---|---|
| `AiExecutionMode` / `AiFallbackPolicy` enums and serialization | `job_manager.rs:99–121` | Correct |
| `LocalLlm` as `#[default]` | `job_manager.rs:109` | Correct |
| `is_non_fallback_error` guards `RECORDING_PRIORITY`, `JOB_CANCELLED`, `APP_SHUTTING_DOWN` | `background_jobs.rs:614–623` | Correct |
| `disclosed_fallback_reason` checks `cancelled` first | `background_jobs.rs:625–634` | Correct |
| Provenance struct with typed `engine` / `fallbackReason` / `fallbackUsed` | `background_jobs.rs:588–612` | Correct |
| ChaCha20-Poly1305 + AEAD staging, temp-rename atomic write | `dictionary_staging.rs:99–186` | Correct |
| TOCTOU symlink → canonicalize chain | `dictionary_staging.rs:207–241` | Correct (see Issue 6) |
| Orphan cleanup on startup only | `main.rs:386–394` | Correct (see Issue 10) |
| Schema v1 → v2 migration with backup and rollback | `job_manager.rs:1859–1927` | Correct (see Issue 8) |
| Trust label computed from key comparison, not package metadata | `dictionary_package.rs:235–252` | Correct |
| `import_bundled_general_package` rejects non–`verified-candor` | `terminology_dictionary.rs:413–424` | Correct |
| `selected_entry_order` 8-tier deterministic tie-break | `terminology_dictionary.rs:1710–1730` | Matches spec |
| `parseBackgroundTask` rejects ETA outside `running` state | `background-task.ts:222–230` | Correct |
| Provenance consistency cross-check (engine vs top-level) | `background-task.ts:235–253` | Correct |
| Events carry no result payload (`include_result=false`) | `job_manager.rs:1731` | Correct |
| Preload V3, typed `mode` / `fallbackPolicy` parameters | `preload.cts:10,113–124` | Correct |

### Phase 1 — Required Before the Release Gate Can Pass

See Issues 2, 5, 7, 9, 11 below.

### Phase 2 — Gated on External Artifacts (Real Models, Publisher Key, Signing)

- Setting `release_ready: true` in the bundle manifest
- Populating `model-lock.json` with exact SHA-256, byte counts, and immutable revision for Qwen3-4B-GGUF Q4\_K\_M
- Adding the production Candor publisher public-key file
- Running `spec6-release-publication-gate.mjs` against production evidence

---

## Required vs Optional Changes

### Required (must be resolved before Phase 1 closes)

1. **Issue 2** — `stable_local_ai_code` loss of specificity (see below).
2. **Issue 5** — `AllowDisclosed` as the default `AiFallbackPolicy` is policy-correct but the renderer API contract does not prevent calling `ai.recap.start` with `mode: "local-llm"` and `fallbackPolicy: "allow-disclosed"` from a code path that the UI treats as a "no fallback" manual trigger. Document or enforce at the IPC validation layer.
3. **Issue 7** — confirm `maintain_dictionary_staging` is called during normal operation, not only on cold startup.
4. **Issue 9** — the migration path for archives larger than 2.5 MB causes a non-retryable failure that permanently loses the queued import job. Add a size cap check before calling `stage_base64` and map oversized legacy archives to a retryable error with a clear user-facing message.
5. **Issue 11** — the `result` field in `BackgroundTask` is an unvalidated `JsonValue` even when `state === "completed"`. The `validateCompletedJobResult` function in `operation-registry.ts:332–339` is only called on the `jobs.get` code path. Events are safe (result is absent), but the type definition allows result in events, which could mislead callers. Either narrow the TypeScript type or add a note.

### Optional (improve defensibility but not blocking)

- Issue 1, 3, 4, 6, 8, 10, 12 below.

---

## Issue Catalogue

### Issue 1 — `stable_local_ai_code` is order-dependent for ambiguous error codes (low severity)

**File:** `background_jobs.rs:667–674`

`allowed_fallback_reason` is called with the *stabilized* code, so the stabilization mapping must be exhaustive. If a future service status emits a code containing multiple keywords (e.g., `"LOCAL_LLM_CORRUPT_NOT_FOUND"`), the first matching branch wins. The order — HASH/CORRUPT/FINGERPRINT → BUDGET/RESOURCE → MISSING/NOT\_FOUND/UNAVAILABLE → explicit command codes — is safe because integrity failures should outrank availability failures in fallback permissiveness. **No action required if the error taxonomy is kept mutually exclusive.**

### Issue 2 — `stable_local_ai_code` always returns `LOCAL_LLM_NOT_READY` for genuinely unknown codes (moderate)

**File:** `background_jobs.rs:667–674`

When a novel status code arrives that doesn't match any of the four fallback categories, `stable_local_ai_code` returns `"LOCAL_LLM_NOT_READY"`. `allowed_fallback_reason("LOCAL_LLM_NOT_READY")` returns `None`, so **fallback is correctly blocked**. However, the UI receives no specific error code for diagnosis. **Recommendation:** add a fifth passthrough case that propagates unknown codes up to the job error rather than silencing them into a generic label.

### Issue 3 — `AiFallbackPolicy::AllowDisclosed` is the default (moderate)

**File:** `job_manager.rs:116–119`, `background_jobs.rs:528–535`

Auto-recap after transcription uses `AiFallbackPolicy::AllowDisclosed`. This is consistent with the spec ("disclosed allowed failure"), but the disclosure mechanism is a `provenance.fallbackReason` field in the job result, not a UI-level warning. **Requirement 2** says "Heuristic fallback is allowed only for a disclosed allowed failure or an explicit user request." The provenance field satisfies "disclosed" at the data level; the renderer must surface it. Verify that `BackgroundActivity.tsx` and `MeetingDetailView.tsx` check `provenance.fallbackUsed` before rendering recap output as LLM-quality.

### Issue 4 — `spawn_descriptor` allows a successfully-completed preempted job to proceed (low)

**File:** `job_manager.rs:1380–1393`

If a recording starts while a LocalLlm job is in its final microseconds, the job may return `Ok(value)` before the preemption flag is checked. The outcome: the job completes normally with LLM output. This is correct — if the LLM finished first, its output is used. The safety invariant holds: no heuristic fallback, no silent degradation. **No action required.**

### Issue 5 — Renderer can request `mode: "heuristic-fallback"` directly via preload (moderate)

**File:** `preload.cts:113–124`, `validate-private-core-input.ts`

The preload API exposes `mode: "local-llm" | "heuristic-fallback"` and `fallbackPolicy: "allow-disclosed" | "require-local-llm"` to the renderer without validating which combinations are legal from UI paths. A UI bug (or crafted call) could invoke `generateRecap` with `mode: "heuristic-fallback"` and `fallbackPolicy: "require-local-llm"` — which is internally consistent (Rust executes heuristic directly without ever attempting LLM, returns `"user-requested"` as reason) but semantically contradictory. **Recommendation:** in `validate-private-core-input.ts`, reject `mode: "heuristic-fallback"` combined with `fallbackPolicy: "require-local-llm"` as an invalid parameter combination.

### Issue 6 — TOCTOU window between `symlink_metadata` and `canonicalize` (low)

**File:** `dictionary_staging.rs:207–241`

There is a window between the `symlink_metadata` check and `canonicalize` during which an attacker with write access to the staging directory could replace the regular file with a symlink. However: (a) the AEAD tag binds to the token, so any replaced ciphertext fails authentication; (b) `canonicalize` still detects out-of-directory symlinks. The defense-in-depth is adequate. **No action required.** Document the two-layer defense in a test comment if the threat model is ever revisited.

### Issue 7 — `cleanup_orphans` is only called at startup (moderate)

**File:** `main.rs:386–394`

`maintain_dictionary_staging` is called once during process startup. If a user imports several dictionaries in a session, each leaving a staging token on completion that is immediately deleted, this is fine. But if a crash occurs mid-session and the next launch takes more than 24 hours, orphan files accumulate. **Recommendation:** also call `maintain_dictionary_staging` after `apply_retention` in the periodic background task cycle, not only at cold startup.

### Issue 8 — Migration rollback failure is catastrophic (low)

**File:** `job_manager.rs:1912–1927`

If migration writes succeed but `fs::rename(migration_backup → target)` fails (e.g., cross-device), the system returns `JOB_STORE_MIGRATION_ROLLBACK_FAILED`. The user's job store is lost. **Mitigations present:** the `.migration.bak` file persists and can be manually restored by a support workflow. **Recommendation:** log (to stderr, not to structured output) the backup path alongside the error code so a support tool can locate it without accessing raw paths in the renderer.

### Issue 9 — Legacy archives larger than `MAX_ARCHIVE_BYTES` (2.5 MB) fail migration non-retryably (required)

**File:** `job_manager.rs:1985–1993`, `dictionary_staging.rs:82–96`

`stage_base64` returns `DICTIONARY_ARCHIVE_TOO_LARGE` which is non-retryable. If a user's stored dictionary import exceeds 2.5 MB (compressed), migration fails and the job cannot be recovered; it becomes a non-retryable `JobFailure` propagated from `migrate_descriptor`. The descriptor is then cleared (because migration failed), losing the retry opportunity. **Recommendation:** before calling `stage_base64`, check `archive.len()` and return a retryable `JobManagerError` with code `JOB_STORE_MIGRATION_ARCHIVE_TOO_LARGE` that marks the dictionary job as failed-non-retryable without aborting the entire migration for other jobs. The current implementation aborts all-or-nothing.

### Issue 10 — `completedJobResultSchemas` does not include `dictionary-import` or `dictionary-index` (low)

**File:** `operation-registry.ts:320–330`

Jobs of type `dictionary-import` and `dictionary-index` complete successfully but have no entry in `completedJobResultSchemas`. `validateCompletedJobResult` throws for unregistered types. This means the `jobs.get` call for a completed `dictionary-import` job would throw at the operation-registry layer. **Verify:** add `dictionary-import` and `dictionary-index` schemas, or verify these job types are never fetched individually via `jobs.get` after completion.

### Issue 11 — `BackgroundTask.result` is an untyped `JsonValue` even in `completed` state (required)

**File:** `background-task.ts:69–70`

The TypeScript type allows `result?: JsonValue` for completed tasks. `parseBackgroundTask` does not validate the result structure. In the event path this is safe (results are absent), but callers who call `api.app.getJob` and branch on `task.state === "completed"` can receive unvalidated result objects. The `validateCompletedJobResult` function exists but is not invoked by `parseBackgroundTask`. **Recommendation:** in `parseBackgroundTask`, if `state === "completed"`, call `validateCompletedJobResult` on the task value before returning.

### Issue 12 — Trust label propagated as a raw string through the renderer without a UI allowlist (low)

**File:** `terminology_dictionary.rs:598–615` (returns `trustLabel` in import result); `TerminologySettings.tsx` (presumably renders it)

The trust label arrives from Rust as a string (`"verified-candor"` or `"community-unverified"`). If additional label values are added in the future, the renderer must not display unrecognized values as if they convey Candor endorsement. **Recommendation:** in the renderer, treat any value other than `"verified-candor"` as `"community-unverified"` rather than displaying the raw string.

---

## Migration Sequence (Q2 Answer)

The safe migration sequence for legacy Base64 descriptors is:

1. **Read & decrypt** the existing encrypted job store (schema v1).
2. **Create the migration backup** (`background-jobs.bin.migration.bak`) before modifying anything.
3. **For each `DictionaryImport` descriptor** with an empty `staging_token`:
   a. Validate `legacy_source_file_name` is present and a valid `.candordict` filename.
   b. Validate `legacy_archive_base64` is present and within the size limit (currently enforced — see Issue 9 for the gap).
   c. Call `staging.stage_base64`, append the returned token to `staged_tokens`.
   d. Overwrite the descriptor fields.
4. **For each Recap/Ask descriptor** with a `legacy_quality` field, map to `(mode, fallback_policy)` per the migration table.
5. **Write the updated document** (schema v2) to a temp file, rename atomically.
6. **Read back and decrypt** to verify round-trip integrity.
7. **On any failure:** delete all tokens from `staged_tokens`, restore from the migration backup.
8. **On success:** leave the migration backup in place; delete it on the next successful startup where `schema_version == 2`.

The current implementation at `job_manager.rs:1859–1927` follows this sequence except for Issue 9 (all-or-nothing failure on oversized archives).

**Rollback note:** if the key store is unavailable when staging is attempted (e.g., OS credential store locked during migration), all migration attempts fail with `DICTIONARY_STAGING_KEY_FAILED` (retryable). The migration backup is restored. On next launch the migration will retry. This is safe.

---

## Staged Dictionary Lifecycle and Cleanup Rules (Q3 Answer)

| Event | Action |
|---|---|
| User selects file | `DictionaryStaging::stage_bytes` → encrypted file `{token}.stage`, `StagedDictionary` returned |
| Job submitted | `staging_token` stored in `JobDescriptor::DictionaryImport`, persisted to encrypted job store |
| Job starts | `read_verified` (AEAD auth, containment, integrity check), then immediately `delete` |
| Job succeeds | Staging file already deleted at job start |
| Job fails (retryable) | Staging file persisted; retained up to `RETRYABLE_DICTIONARY_STAGING_RETENTION_MS` (72 h) |
| Job cancelled | `import_dictionary` deletes the staging file; `finish_cancelled` clears the descriptor |
| Retention applied | Files with expired retryable-failed or paused jobs: `delete` called, descriptor cleared |
| Startup | `maintain_dictionary_staging` calls `apply_retention` then `cleanup_orphans` (24 h threshold) |

**TOCTOU prevention:** The `read_verified` path validates in this order: (1) `symlink_metadata` rejects symlinks and directories, (2) `canonicalize` verifies containment inside the staging root, (3) AEAD authentication rejects any content that was replaced or corrupted after staging. An attacker who can write to the staging directory cannot produce a valid authenticated ciphertext without the OS key store secret.

**Orphan growth cap:** the staging directory can grow to `MAX_ARCHIVE_BYTES × (number of concurrent retryable imports)`. With the 72-hour retention and 2.5 MB cap per entry, the maximum orphan growth between startups is bounded. The 24-hour cleanup threshold applies to files not referenced by any active job.

**Recommendation:** call `maintain_dictionary_staging` also after the periodic background retention sweep (see Issue 7), not only on cold startup.

---

## Typed Task and Provenance Contracts (Q4 Answer)

### Public (renderer-safe)

```
BackgroundTask {
  jobId, type, state, createdAt, updatedAt, stage, progress,
  estimatedRemainingMs,   // only when state === "running"
  recordingId, parentJobId,
  error,                  // only when state === "failed"
  provenance: {
    engine,               // "local-llm" | "heuristic"
    modelId,              // required when engine === "local-llm"
    fallbackUsed,         // bool
    fallbackReason,       // required when fallbackUsed === true
    promptVersion, generatedAt
  },
  cancelRequested, retryCount, retryable, terminal,
  resultAvailableAfterRestart,
  sourceDataPreserved: true,
  rawPathExposed: false,
  keyMaterialExposedToRenderer: false
}
```

### Must remain private (never renderer-visible)

- `staging_token` and `expected_sha256` (staging descriptor)
- `legacy_archive_base64` (raw dictionary bytes)
- `question` content after `ASK_QUESTION_RETENTION_MS` (24 h) — correctly cleared by retention
- `preempt_requested`, `shutdown_pause_requested` — internal scheduler state
- Model file paths, key derivation material, prompt text

### `result` field policy

The `result` field is present only in `jobs.get` responses (`include_result=true`); events always carry `null`. This is correct. However, the TypeScript type `result?: JsonValue` should be narrowed: either validate it when state is `completed` (Issue 11) or narrow the field to `undefined` in the event-sourced types.

---

## Trust Anchor Differentiation (Q5 Answer)

The current two-tier model is correct and should not be collapsed:

| Property | `verified-candor` | `community-unverified` |
|---|---|---|
| Trust label source | Computed by comparing `key_id + public_key` against the bundled anchor | Always assigned when trust check fails |
| Signature verification | Ed25519 structural integrity + Candor chain | Ed25519 structural integrity only |
| UI display | "Verified by Candor" (safe to display) | "Community package – unverified" |
| Import path | Only via `import_bundled_general_package` (enforces label at the guard) | Via `import_verified_package` |

**What the label must never do:**
- Be read from package metadata (the package has no `trustLabel` field — correct)
- Be displayed verbatim from the terminology store without the renderer-side allowlist check (Issue 12)
- Be granted to packages whose key matches by ID only, not by key bytes — the implementation checks both (`anchor.key_id == signature.key_id && anchor.public_key == signing_public_key`)

**What distinguishes community packages:** they are self-signed (the package includes its own public key in `signature.json`). Structural Ed25519 validity is still verified. The only thing the trust anchor adds is chain-of-custody: only a key that Candor bundled at ship time can produce `verified-candor`. A community package with a strong Ed25519 signature is still structurally sound but cannot impersonate Candor provenance.

---

## Safe Release Asset Changes While Real Models Are Absent (Q6 Answer)

### Safe to land now (no external evidence needed)

- All mode, fallback policy, and provenance code changes (landed)
- The migration code and schema v2 bump (landed)
- The staging infrastructure (landed)
- The trust anchor verification path (landed)
- The bundle verifier infrastructure and fail-closed gate (landed, `spec3-verify-ai-bundle.mjs`)
- Acquisition script `spec6-acquire-release-model.mjs` (fail-closed by design)
- `spec6-release-publication-gate.mjs` (gating script structure; does not publish)

### Must wait for real assets

- `release_ready: true` in the bundle manifest — **must not be set** until models are verified
- SHA-256 + byte counts + immutable revision in `model-lock.json` — absent entries mean `acquire` script fails cleanly
- Production Candor publisher public key — absent means `ensure_bundled_general_dictionary` fails at `BUNDLED_DICTIONARY_TRUST_ANCHOR_MISSING`, no dictionary imported, no false trust label displayed
- CI runs of the verification gate — cannot pass until all of the above are present

The current `fixture: true` / `release_ready: false` in the bundle manifest is the correct sentinel. The bundle verifier self-test covers this flag. **Do not set `release_ready: true` in any CI target until all of: model file, publisher key file, and external receipt are cryptographically verified by the gate script.**

---

## Tests and Acceptance Checks

### Required before Phase 1 closes

| Test | What to verify |
|---|---|
| `fallback_policy_is_explicit_and_never_masks_preemption_or_cancellation` (present) | Passes. Covers `RECORDING_PRIORITY` and `cancelled=true` guard. |
| New unit test: `large_legacy_archive_fails_retryably_in_migration` | Supply a descriptor with `legacy_archive_base64` encoding more than 2.5 MB; assert `JobManagerError.code` is `JOB_STORE_MIGRATION_ARCHIVE_TOO_LARGE` and other jobs in the store survive migration |
| New unit test: `heuristic_mode_with_require_local_llm_policy_rejected_at_ipc` | Send `mode: "heuristic-fallback"` + `fallbackPolicy: "require-local-llm"` to `validate-private-core-input`; assert the params are rejected |
| New unit test: `completed_job_result_validated_in_parse_background_task` | Supply a `completed` task with a structurally wrong result; assert `parseBackgroundTask` throws `CORE_PROTOCOL_FAULT` |
| New unit test: `dictionary_import_and_index_result_schemas_registered` | Verify `completedJobResultSchemas.has("dictionary-import")` and `completedJobResultSchemas.has("dictionary-index")` |
| New unit test: `trust_label_allowlist_in_renderer` | Supply a trust label value of `"super-verified"` to the renderer component; assert it renders as `"community-unverified"` |

### Acceptance gates for Phase 2 (external assets)

- Bundle verifier passes in Standard mode (not just self-test mode)
- `spec6-release-publication-gate.mjs` exits 0
- The production publisher key file produces `verified-candor` on the general dictionary
- The Whisper model lock entry verifies against the downloaded file's SHA-256
- Hardware proof receipt format is committed and non-fabricated

---

## Adversarial Assessment of Requirements That Should Be Modified

### Requirement 2 — "Heuristic fallback is allowed only for a disclosed allowed failure" — strengthen the disclosure path

**Current state:** Disclosure is a `provenance.fallbackReason` field in the job result. This is machine-readable but there is no spec requirement for the UI to surface it.

**Risk:** A renderer that reads `result.summary` without checking `result.provenance.fallbackUsed` will silently display heuristic output with no visual distinction from LLM output.

**Recommended modification:** Add a normative renderer requirement: any UI that renders recap or answer content must check `provenance.fallbackUsed` and display a visible affordance (e.g., a badge or footnote) when it is `true`. This should be a required acceptance check, not just recommended.

### Requirement 9 — "Only a package chained to the bundled Candor publisher public key may display `Verified by Candor`" — add a version-binding requirement

**Current state:** The trust anchor is a static public key loaded from a file path. If the private key is ever compromised, all packages signed with it retain `verified-candor` indefinitely.

**Risk:** Key rotation requires a code change to re-bundle the public key. There is no revocation mechanism.

**Recommended modification:** The bundled trust anchor document should include a `notValidAfter` or `rotationGeneration` field that the Rust verifier enforces. For the current release this can be set to a distant future date; the field should be present so the schema can be enforced later without a breaking change.

### Requirement 10 — "Standard targets ... a general dictionary" — the bundled dictionary gate must be fail-open for the absence case, not fail-closed

**Current state:** `ensure_bundled_general_dictionary` returns `Ok(())` if `general_dictionary()` returns `None` (no asset present). This is correct. If the asset exists but the key is missing, it fails with `BUNDLED_DICTIONARY_TRUST_ANCHOR_MISSING`. This failure currently propagates as a job failure during startup recovery, which may block background processing entirely.

**Risk:** A partial bundle (dictionary file present, key file missing) causes a startup-time job failure that is retryable-false and may block the user from submitting new background work until acknowledged.

**Recommended modification:** When the bundled dictionary trust anchor is absent but the dictionary file is present, treat this as a deferred bundle-repair condition (emit a diagnostic warning, skip the dictionary import), rather than a hard `BUNDLED_DICTIONARY_TRUST_ANCHOR_MISSING` job failure. Only fail closed if both the file and the key are present but the key fails to verify the file.

---

## Summary Table

| # | Severity | Required | Finding |
|---|---|---|---|
| 1 | Low | No | `allowed_fallback_reason` order-dependent on ambiguous codes |
| 2 | Moderate | Phase 1 | Unknown status codes silently become `LOCAL_LLM_NOT_READY`, losing diagnostic specificity |
| 3 | Moderate | No (document) | `AllowDisclosed` default exposes heuristic fallback path if renderer doesn't check provenance |
| 4 | Low | No | Successfully-completed preempted job proceeds — intentional and safe |
| 5 | Moderate | Phase 1 | `mode: "heuristic-fallback"` + `fallbackPolicy: "require-local-llm"` is a semantically invalid combination; not rejected at IPC boundary |
| 6 | Low | No | TOCTOU window between symlink check and canonicalize — mitigated by AEAD |
| 7 | Moderate | Phase 1 | `cleanup_orphans` called only on startup, not in periodic cycle |
| 8 | Low | No | Migration rollback failure loses job store — backup present, recovery manual |
| 9 | Required | Phase 1 | Oversized legacy archives fail migration all-or-nothing, losing unrelated jobs |
| 10 | Moderate | Phase 1 | `dictionary-import`/`dictionary-index` missing from `completedJobResultSchemas` |
| 11 | Moderate | Phase 1 | `parseBackgroundTask` does not validate `result` for completed tasks |
| 12 | Low | No | Trust label displayed verbatim in renderer without allowlist guard |

---

The implementation correctly satisfies the hardest invariants: preemption never produces heuristic output, the trust chain is computed rather than declared, staging is authenticated with AEAD, and the bundle gate is fail-closed. The five Phase 1 items (Issues 5, 7, 9, 10, 11) are the remaining delta before the internal implementation is ready to accept real production assets.
