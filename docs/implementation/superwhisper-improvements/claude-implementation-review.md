I've now read all scoped files. Here is the adversarial review.

---

## Implementation Review — Candor Local AI Handoff

### Explicit status on Critical and High severity

**No Critical or High findings.** The evidentiary/cleaned separation is structurally enforced at three independent layers: the manifest mutation lock, the `select_transcript_revision` kind-check (`recording_store.rs:2869`), and the `validate_manifest_structure` invariant (`recording_store.rs:7222`). The search path re-evaluates parent-vs-current at index time (`recording_store.rs:4368–4371`). No path was found to substitute cleaned text into the evidentiary slot, to use a stale cleaned revision for recap or search, or to exfiltrate meeting data through the acquisition broker.

---

## Confirmed Findings

---

### Medium — Content-length header absent: early size check passes vacuously

**File:** `electron/models/model-acquisition-service.ts`, lines 182–184

```typescript
const contentLength = Number(response.headers["content-length"] ?? entry.bytes);
if (!Number.isSafeInteger(contentLength) || contentLength !== entry.bytes) {
```

**Failure path:** HuggingFace CDN omits `Content-Length` on some chunked-transfer responses. When `response.headers["content-length"]` is `undefined`, the null-coalescing fallback evaluates to `entry.bytes`, making `contentLength !== entry.bytes` identically false. The "early reject" check then exits with no error, treating the server as having implicitly confirmed the correct size. The streaming guard at line 194 (`active.bytesReceived > entry.bytes`) still fires per-chunk, so no oversize content is installed. But the explicit content-length validation is a no-op when the header is absent, contrary to what the code appears to enforce.

**Why tests miss it:** Mock handlers in `model-acquisition-service.test.ts` either stub `content-length` or let the fallback pass; no test exercises the absent-header branch and asserts it is rejected.

**Smallest safe fix:**
```typescript
const rawContentLength = response.headers["content-length"];
if (rawContentLength === undefined) {
  response.destroy();
  throw new Error("Model download did not provide a content-length.");
}
const contentLength = Number(rawContentLength);
if (!Number.isSafeInteger(contentLength) || contentLength !== entry.bytes) {
  response.destroy();
  throw new Error("Model download size did not match the packaged catalog.");
}
```

**Focused test:** inject a mock response whose `headers` has no `content-length` key; assert `download()` throws before any chunk is sent to `models.importChunk`.

---

### Low — Parakeet passes the Electron IPC boundary before the Rust gate

**File:** `electron/security/validate-core-input.ts`, lines 249–255

```typescript
if (speechModelId !== undefined && (
  typeof speechModelId !== "string"
  || !new Set(["small.en", "small", "large-v3-turbo", "large-v3", "parakeet-tdt-0.6b-v3-int8"]).has(speechModelId)
)) {
  return fail(method, "speechModelId is not in the bounded local catalog");
}
```

`"parakeet-tdt-0.6b-v3-int8"` is accepted by the Electron input validator and forwarded to the Rust core, where `validate_speech_model_id` (`meeting_profiles.rs:988–993`) returns `PARAKEET_RELEASE_GATED`. No actual selection occurs. But the defence-in-depth pattern for a release-gated model should be: **reject at the IPC boundary so the core never sees the request**, not allow-at-boundary then reject in core. The current layering means a renderer compromise could spam the Rust core with Parakeet selection attempts, and the gate's location is not the most paranoid possible.

**Why tests miss it:** The test that covers the Rust gate (`parakeet_selection_fails_closed_until_release_gates_pass`, `meeting_profiles.rs:1347`) does not have an IPC-layer counterpart in `validate-core-input.test.ts`.

**Smallest safe fix:** Remove `"parakeet-tdt-0.6b-v3-int8"` from the allowlist set. Add it back only after all documented gates pass and the catalog entry gains `releaseState: "ready"`.

**Focused test:** add to `validate-core-input.test.ts`:
```typescript
expect(() => validateRendererCoreParams("profiles.upsert", {
  ...validProfileBase,
  speechModelId: "parakeet-tdt-0.6b-v3-int8"
})).toThrow("speechModelId is not in the bounded local catalog");
```

---

### Low — `cleanupFallbackApplied` default is tautological but silently wrong under interface drift

**Files:**
- `crates/candor-core/src/local_instruct_model.rs`, line 2315
- `crates/candor-core/src/background_jobs.rs`, lines 499–501

Both sites use `.unwrap_or(Value::Bool(true))` or `.unwrap_or(true)` when extracting `cleanupFallbackApplied` from the transcript or recap result. `transcript_for_local_ai` always populates the field (`recording_store.rs:2620`), so the default never fires on the live path.

The risk is latent: if the upstream transcript shape were refactored to omit the field, both sites would silently record "cleanup fallback applied = true" in processing receipts for recordings where cleanup actually succeeded, making the receipt lineage misleading. Because the conservative default can only over-report fallback (not under-report), it cannot cause cleaned text to be treated as raw — but it corrupts the audit trail.

**Why tests miss it:** All tests supply a full transcript. No test constructs a transcript without `cleanupFallbackApplied` and asserts the error condition.

**Smallest safe fix** (in `local_instruct_response`): Replace the `unwrap_or` with an explicit error:
```rust
let cleanup_fallback_applied = transcript
    .get("cleanupFallbackApplied")
    .cloned()
    .ok_or_else(|| LocalInstructError::new(
        "LOCAL_LLM_TRANSCRIPT_LINEAGE_MISSING",
        "transcript did not include cleanup lineage",
    ))?;
```

**Focused test:** pass a transcript `Value` without the `cleanupFallbackApplied` key into `local_instruct_response` and assert it returns `LOCAL_LLM_TRANSCRIPT_LINEAGE_MISSING`.

---

## Questions / Defence-in-Depth Notes (not confirmed defects)

**1. No processing receipt written for the `ask` path.**
`background_jobs.rs:ask()` calls `record_ai_processing_fact` but never calls `record_recap_receipt`. The `recap()` path does write a receipt. If the product contract requires that every AI interaction produces a verifiable receipt, `ask` is incomplete. If `ask` is intentionally receipt-exempt (it produces no stored structured output), that should be documented in a constant or comment.

**2. Reused-cleanup return skips the receipt for the current invocation.**
When `transcript_for_local_ai` returns `inputRevisionKind == "ai-cleaned"` (`background_jobs.rs:233–255`), the function returns immediately using a synthetic `json!({...})` without writing any receipt. The existing receipt from the original cleanup run remains. This is likely correct (the revision is unchanged, so no new receipt is needed), but there is no test that verifies the `reused: true` fast-path does not leave a half-recorded state if the job is cancelled between the `transcript_for_local_ai` call and the return.

**3. Migration backup fallback silently drops the `migrated` flag (`meeting_profiles.rs:601–608`).**
When the primary profile file is unreadable and the backup is read successfully, the code calls `read_store(&backup).map(|(stored, _)| stored)` — discarding whether migration ran. If the backup is schema 1, the migrated store is returned without being persisted. On the next `load()`, migration runs again. This is idempotent but wastes a write and could mask a persistent write failure. A test for this exact branch is recommended.

**4. Source-audit node-network regex does not cover computed module names.**
`scripts/source-security-rules.mjs:384–388` uses a literal-string regex to block `from "node:https"` style imports. It does not detect `require("node:" + "https")` or a variable pointing to `"node:https"`. This is a known, inherent limitation of text-based auditing. The 37 mutation tests and the secondary `electron-runtime:no-network-calls` check (covering `electron.net` via `containsElectronNetCall`) mitigate the gap. No fix required, but worth noting in the audit's known-limitation disclosure.

**5. `cancelDownload` IPC sends `JsonValue | undefined` into `cancel(modelId?: string)` at the TypeScript call site.**
`models-ipc.ts:39` passes `modelId` (type `JsonValue | undefined`) to `cancel()` after the `validModelId` guard. TypeScript's type narrowing after `if (cond) throw` should narrow `modelId` to `string | undefined`, but the absence of an explicit `as string` assertion means the narrowing depends on the guard being typed as a `value is string` predicate — which `validModelId` is. Verified safe. No fix needed.

---

## Summary Against Each Contract Question

| # | Question | Status |
|---|---|---|
| 1 | Can AI-cleaned text become evidentiary, survive a parent-selection change, or be published without its receipt atomically? | **No.** `select_transcript_revision` rejects `AiCleaned` (line 2869); `validate_manifest_structure` rejects `current_transcript_revision_id` pointing to `AiCleaned` (line 7222); `complete_cleanup_attempt` holds the manifest lock and writes revision+receipt in one atomic replace. |
| 2 | Can stale lineage be used, a fallback be hidden, or the immutable source be lost? | **No.** `transcript_for_local_ai` filters cleaned revision by parent-vs-current check (line 2585–2588). `disclosed_fallback_reason` explicitly rejects fallback on cancellation and preemption codes. The `unwrap_or(true)` defaults ensure over-disclosure, not under-disclosure. |
| 3 | Are cleanup schema and output checks strict enough? | **Yes, with a note.** `deny_unknown_fields` on both structs, JSON schema enforced via `--json-schema` flag, `raw_source_id` identity check, byte limit, control-char rejection, and numeric token invariant. Protected numeric tokens do not catch Roman numerals or spelled-out numbers, which is an acceptable scope boundary given the prompt constraint ("obvious disfluencies only"). |
| 4 | Can renderer input, redirects, HTTP behaviour, cancellation, or broker lifecycle create SSRF, arbitrary download, partial install, or meeting-data egress? | **No critical path, but content-length check is vacuous on absent header** (Medium finding above). URL validated against hardcoded allowlist, initial URL must exactly match catalog entry, SHA-256 verified end-to-end, `active.bytesReceived > entry.bytes` enforced per-chunk. |
| 5 | Is the source-audit exception exact and mutation-tested? | **Yes.** The exception is scoped to `modelAcquisitionPath` only, the check requires `node:https` specifically and bars `net/tls/dgram/dns/fetch/WebSocket/EventSource/electron.net`. 37 mutation tests passed. Computed module names are an inherent text-audit blind spot. |
| 6 | Is profile migration atomic, backward-compatible, bounded, and Whisper-preserving? Can Parakeet be selected indirectly? | **Mostly yes, with a Low finding.** Migration preserves existing Whisper tier via `model_id_for_profile(capture_source, local_model_tier, &language)`. Parakeet is blocked by `validate_speech_model_id` in Rust — but the IPC boundary admits it (Low finding above). |
| 7 | Do search, receipts, and Trust History distinguish original, cleaned, and summary lineage without indexing stale cleaned text? | **Yes.** `searchable_text_rows_bounded` (line 4368–4371) re-filters `current_cleaned_revision_id` by parent-vs-current at index time. Stale cleaned rows are omitted. Chunk rows are labelled `cleanedTranscriptSegment` vs `originalTranscriptSegment`. |
| 8 | Do preload, IPC, and operation schemas preserve fixed method/event allowlists, pathless responses, and no renderer key material? | **Yes.** Preload is frozen-object-of-named-channels with no generic IPC, no filesystem, no path, and `withRendererCustody` enforces `rawPathExposed: false` and `keyMaterialExposedToRenderer: false` on every response. Source audit enforces the preload surface. |
| 9 | Are any supplied tests tautological, missing an important concurrency or corruption case, or inconsistent with the documented release state? | **Three gaps identified:** content-length absent-header test missing (Medium above), IPC-boundary Parakeet rejection test missing (Low above), and `cleanupFallbackApplied` missing-field error test missing (Low above). No tautological test found. Concurrency: the manifest mutation lock serialises all cleanup/recap writes; the only race window (cancellation between `ensure_not_cancelled` and `complete_cleanup_attempt`) results in a committed-but-cancelled revision, which is detectable in the receipt's outcome field. No test covers this window specifically. |
