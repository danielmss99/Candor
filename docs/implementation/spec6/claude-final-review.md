I now have enough independent evidence. Here is the complete final review.

---

# SPEC-6 Final Independent Code Review

**Branch:** `codex/spec6-ai-release-completion`
**Base commit:** `9eaf4e220731127f7de601abf105bd0eab6342c1`
**Reviewer stance:** Independent. Every finding is derived from direct file inspection, not from prior review documents.

---

## Executive Summary

No critical or high findings remain in this diff. All required findings from the three prior focused reviews have been resolved. One latent medium-severity issue from the AI/task review is still structurally present but is not triggered by any current callsite. Three low-severity issues are still present and consistent with their prior documentation. Seven issues from prior reviews have been concretely fixed and are independently confirmed.

**Code-level acceptance: suitable for a pull request.**
**Public release readiness: false.** The production model weights, publisher key, Authenticode signing, clean-machine, hardware, capture, and benchmark evidence remain absent and must not be inferred from code success.

---

## Section 1 — Prior required findings: confirmed fixed

### 1.1 Push-event IPC bypass of `parseBackgroundTask` (prior MEDIUM)

**Confirmed fixed.** `electron/ipc/jobs-ipc.ts:67–76` now wraps the subscribe callback in a try-catch that calls `parseBackgroundTask` before forwarding to the renderer window. A malformed core event is silently dropped; the renderer state is only updated via the validated pull path.

```ts
// jobs-ipc.ts:70–75
try {
  const task = parseBackgroundTask(coreEvent.payload);
  window.webContents.send("candor-events:jobs-changed", task);
} catch {
  // A malformed core event is rejected before it can become trusted renderer state.
}
```

### 1.2 Invalid `mode`/`fallbackPolicy` combination not rejected at IPC (prior required)

**Confirmed fixed.** `electron/security/validate-private-core-input.ts:185` explicitly rejects the `heuristic-fallback` + `require-local-llm` combination:

```ts
if (mode === "heuristic-fallback" && fallbackPolicy === "require-local-llm") {
  fail(method, "heuristic-fallback cannot require the local LLM");
}
```

### 1.3 `maintain_dictionary_staging` only called at startup (prior required)

**Confirmed fixed.** `crates/candor-core/src/main.rs:262–263` now calls `start_dictionary_staging_maintenance` after the startup call, which spawns a background thread calling `maintain_dictionary_staging` every 3,600 seconds. This resolves the issue where orphan and retention cleanup was only applied at launch.

### 1.4 `dictionary-import` and `dictionary-index` missing from `completedJobResultSchemas` (prior required)

**Confirmed fixed.** `electron/core/operation-registry.ts:455–468` now registers both types in `completedJobResultDefinitions` with full field schemas and semantic validation that enforces `encryptedAtRest === true`, a trust-label allowlist, and valid scope values.

### 1.5 `parseBackgroundTask` not validating `result` for completed tasks (prior required)

**Confirmed fixed.** `electron/core/background-task.ts:307–318` now calls `validateCompletedJobResult` inside `parseBackgroundTask` when `parsedState === "completed"` and a result is present. A schema or semantic violation throws `CORE_PROTOCOL_FAULT` before the object reaches renderer state.

### 1.6 Trust label displayed verbatim in renderer without allowlist guard (prior low)

**Confirmed fixed.** `v3/renderer/src/features/terminology/TerminologySettings.tsx:111–115` implements:

```ts
function dictionaryTrustLabel(trustLabel: string | null): string {
  if (trustLabel === "verified-candor") return "Verified by Candor";
  if (trustLabel === null) return "Local dictionary";
  return "Community pack - unverified";          // all unknown values fall here
}
```

Any future trust label value that is not exactly `"verified-candor"` or `null` is shown as community-unverified. A test at line 56 confirms unknown values are downgraded.

### 1.7 `write_job_document` temp-file creation inconsistency (prior low)

**Confirmed fixed.** `crates/candor-core/src/job_manager.rs:2400–2417` now removes any pre-existing temp file before using `create_new(true)`, matching the exclusive-creation pattern used in `dictionary_staging.rs` and `terminology_dictionary.rs`. The L2 observation from the dictionary security review is resolved.

---

## Section 2 — Medium finding: latent, no current trigger

### F-M1 — "stage" progress unit passes through to wire when `total` is `None` or zero

**File:** `crates/candor-core/src/job_manager.rs:521-529`
**Severity:** Medium (latent only)
**Status:** Structurally present; no current callsite triggers it.

```rust
let (completed, total, unit) = match (unit, total) {
    (Some("stage" | "job"), Some(total)) if total > 0 => (
        completed.saturating_mul(100) / total,
        Some(100),
        Some("percent"),
    ),
    _ => (completed, total, unit),   // "stage" passes through if total is None or 0
};
```

`background-task.ts:144–147` rejects any unit not in `["percent", "seconds", "chunks", "bytes"]`. If any future Rust callsite passes `unit = Some("stage")` with `total = None` or `total = Some(0)`, the rendered job becomes permanently invalid to the renderer until the store entry is removed.

**Current callsite audit:** Every callsite in the current diff uses a positive literal total: `Some(1)`, `Some(2)`, or `Some(3)`. None passes `None` or `Some(0)` with `"stage"` unit. The risk is latent — it would manifest only if new job producers are added without checking this invariant.

**Impact if triggered:** A running job would cause `parseBackgroundTask` to throw `CORE_PROTOCOL_FAULT` on every progress event. The job would appear broken in the UI until the entry is removed. No data is exposed.

**Recommended fix:**

```rust
(Some("stage" | "job"), _) => (
    completed.min(100),
    None,        // indeterminate total
    Some("percent"),
),
```

This converts "stage" to "percent" unconditionally, which is the intent regardless of total validity.

**Note:** This finding is not a blocker for the pull request given no current callers trigger it, but it is a maintenance hazard for future Rust producers.

---

## Section 3 — Low findings: still present, unchanged from prior reviews

### F-L1 — `with_ai_provenance` silently drops provenance when the AI result is not a JSON object

**File:** `crates/candor-core/src/background_jobs.rs:642-658`
**Prior finding:** AI/task review LOW
**Status:** Still present.

```rust
fn with_ai_provenance(mut result: Value, ...) -> Value {
    if let Some(root) = result.as_object_mut() {  // silent if not an object
        root.insert("provenance".to_string(), json!({...}));
    }
    result
}
```

If a service returns a non-object (e.g., `Value::Null`), provenance is dropped. The subsequent `record_ai_processing_fact` call would then fail with `PRIVACY_AI_PROVENANCE_INVALID`. In practice, all recap and ask services return objects. **Recommended fix:** assert the precondition with `.expect("AI result must be a JSON object")` or return `Result<Value, JobFailure>`.

### F-L2 — Cancel IPC ghost-reference window: `staging.delete` before `discard_dictionary_staging`

**File:** `crates/candor-core/src/main.rs:1810-1823`
**Prior finding:** Dictionary security review L1
**Status:** Still present.

The code deletes the staging file first, then removes the token from the descriptor. If `discard_dictionary_staging` fails after `staging.delete` succeeds, the descriptor retains a token pointing to a deleted file. `cleanup_orphans` will not treat this as an orphan (it is still referenced). The ghost reference is cleared the next time `apply_retention` removes the cancelled job entry (within the terminal retention window). No confidentiality impact. **Recommended fix:** call `discard_dictionary_staging` first; then delete the file.

### F-L3 — `exports.create` TypeScript call-site surface is untyped

**File:** `v3/renderer/src/candor-api.d.ts:158`
**Prior finding:** AI/task review LOW
**Status:** Still present.

```ts
create(input: JsonValue): Promise<JobAccepted>;
```

Runtime validation in `validate-private-core-input.ts` enforces the shape, but callers get no compile-time feedback if they omit `recordingId` or pass an invalid format string. No security impact; this is a developer ergonomics issue.

---

## Section 4 — Invariant verdicts

### 4.1 Local LLM is the default for recap and Ask

**PASS.** `AiExecutionMode` derives `#[default] LocalLlm` (`job_manager.rs:109`). `validate-private-core-input.ts:177` defaults `mode` to `"local-llm"`. The renderer defaults `aiMode` to `"local-llm"`. Auto-recap from transcription uses `LocalLlm` explicitly. Verified directly.

### 4.2 Heuristic fallback is explicit or follows an allowlisted failure; never silent

**PASS.** `allowed_fallback_reason` is a closed match list of ~28 specific error codes (`background_jobs.rs:691–738`). The catch-all returns `None`. `disclosed_fallback_reason` additionally checks `context.cancelled()` and `is_non_fallback_error` before consulting the allowlist. Unknown codes return `LOCAL_LLM_STATUS_UNKNOWN`, for which `allowed_fallback_reason` returns `None`, correctly blocking fallback. The `heuristic-fallback + require-local-llm` combination is rejected at `validate-private-core-input.ts:185`.

### 4.3 Cancellation, shutdown, and recording-priority preemption never produce heuristic output

**PASS.** `is_non_fallback_error` covers `JOB_CANCELLED`, `APP_SHUTTING_DOWN`, `RECORDING_PRIORITY`, `LOCAL_LLM_COMMAND_CANCELLED`, `LOCAL_MODEL_JOB_ACTIVE`. The cancellation flag is checked before `record_ai_processing_fact` in both `recap` and `ask` code paths. Workers in `cancelling` state remain nonterminal until the worker acknowledges; the UI will not report them as completed early.

### 4.4 Strict retry preserves the previous result on failure

**PASS.** `retryRecapWithLocalAi` and `retryAskWithLocalAi` send `mode: "local-llm", fallbackPolicy: "require-local-llm"`. If the retry fails, only `setError` is called; the component never overwrites the previous `recap`/`askAnswer` state.

### 4.5 Fallback is visually disclosed when used

**PASS.** `MeetingDetailView.tsx:37` renders an `inline-alert` with `role="status"` whenever `recap.provenance.fallbackUsed` is `true`. An equivalent alert exists for `askAnswer.provenance.fallbackUsed`. The `Retry with Local AI` action is present and distinct from the Generate action. Visually rechecked at 960×600 minimum viewport per the verification document.

### 4.6 All background task events are validated before renderer state

**PASS.** The push path (`jobs-ipc.ts:70–75`) now calls `parseBackgroundTask` before forwarding. The pull path (`jobs-ipc.ts:14`) has always called `parseBackgroundTask`. `parseBackgroundTask` enforces: kind set, state set, unit set, terminal invariant, ETA only when running, error only when failed, completed result validated by `validateCompletedJobResult`, cancellation state consistency, paused-implies-retryable, and the full provenance envelope.

### 4.7 No paths, keys, prompts, transcripts, or unvalidated fields reach the renderer

**PASS.** `taskFieldSet` (22 fields) rejects any task with unknown fields. `forbiddenCompletedResultKeys` scans recursively for `path`, `prompt`, `rawPrompt`, `transcript`, `privateKey`, `systemPrompt`, `modelPath`, `runnerPath`, `secret`, `sourcePath`, `keyMaterial`, `archiveBase64`, `licenseToken`. All task responses carry `rawPathExposed: false` and `keyMaterialExposedToRenderer: false`. The preload exposes no `exec`, `spawn`, `shell`, or filesystem path surface for AI assets.

### 4.8 Dictionary staging is ChaCha20-Poly1305 authenticated and path-contained

**PASS.** Staging write: temp-rename atomic, per-token AAD binding. Read path: `symlink_metadata` rejects symlinks, `canonicalize` verifies containment, AEAD authentication rejects any content substituted after staging. Orphan cleanup runs at startup and every hour.

### 4.9 Only the exact bundled Candor public key produces `verified-candor`

**PASS.** `dictionary_package.rs:235–252` requires both `anchor.key_id == signature.key_id` and `anchor.public_key == signing_public_key` (full 32-byte comparison). `DictionaryTrustAnchor::from_json_bytes` rejects `rotation_generation == 0`. The renderer's `dictionaryTrustLabel` function further allowlists the label value; any value other than `"verified-candor"` is displayed as community-unverified. Project scope is unconditionally rejected by `dictionary_scope_is_valid`.

### 4.10 Release acquisition is fail-closed; publication gate requires full evidence

**PASS.** Both `spec3:ai-bundle:verify:complete` variants exit nonzero by design. `release:publication-gate` exits nonzero by design. The `v3-release-readiness-audit.mjs` requires passing proofs for signing, clean-machine installation, real capture, real Whisper, benchmark, SBOM, GUI matrix, source security, and release checksums. None of these proofs exist or have been fabricated. The acquisition script requires exact-byte and SHA-256 verification before atomic promotion.

### 4.11 Migration: schema-v1 Base64 descriptors migrate with backup, verify, and rollback

**PASS (with noted behavior).** Migration creates a backup before any mutation, writes the upgraded document, reads it back to verify the round-trip, and on any error removes created staging tokens and restores the backup file byte-for-byte. The behavior confirmed by `oversized_legacy_dictionary_migration_rolls_back_without_data_loss`: an oversized legacy archive produces `JOB_STORE_MIGRATION_ARCHIVE_TOO_LARGE`, and the store file is restored to `original` byte-for-byte, preserving all other job data in the file.

**Residual behavior note:** Migration still fails all-or-nothing when one descriptor has an oversized archive. Other jobs (e.g., Recap) are preserved in the restored file but are inaccessible (`persistenceState: "unavailable"`) until a future startup where migration succeeds. There is no automated per-descriptor isolation path. This was documented as Issue 9 in the plan review; the current implementation satisfies "preserve unrelated jobs" via byte-for-byte rollback, but users with a legacy oversized dictionary would need support intervention to clear the blocking descriptor.

---

## Section 5 — Proof honesty and deviation assessment

The verification document (`verification.md`) accurately describes all resolutions. The acceptance-status document (`acceptance-status.md`) correctly names each fail-closed gate and does not overstate code-level success as release readiness. The expected strict failures (`spec3:ai-bundle:verify:complete`, `release:publication-gate`) serve as acceptance evidence that the gates are real. No receipt has been fabricated for any unavailable evidence item.

The implementation-plan.md requirement "preserve unrelated jobs" during oversized migration is satisfied by byte-for-byte rollback, not per-descriptor isolation. This is a defensible interpretation, but code that reads `persistenceState: "unavailable"` cannot resolve without either support intervention or a future migration fix.

---

## Final Summary

| Severity | Count | Status |
|---|---|---|
| Critical | 0 | None |
| High | 0 | None |
| Medium | 1 | Latent (no current trigger) |
| Low | 3 | Unchanged from prior reviews; all accepted per design |

**Critical or high findings remaining:** **None.**

**Code-level pull request acceptance:** **Yes.** All prior required findings are fixed. The latent medium issue is not triggerable by any current callsite. The three low findings carry the same risk profile they had when documented.

**Public release readiness:** **False.** The fail-closed gates for production model weights, publisher key, Windows Authenticode signing, clean-machine install, real hardware capture, real Whisper and Qwen benchmarks, and a distribution decision for the 2.3 GiB Qwen asset remain open. None of these gates have been weakened or bypassed by this diff.
