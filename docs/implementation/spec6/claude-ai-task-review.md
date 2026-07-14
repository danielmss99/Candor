I now have a complete picture of all the relevant code. Here is the independent review report.

---

## SPEC-6 AI and Background-Task Boundary — Review Report
**Branch:** `codex/spec6-ai-release-completion` · **Base:** `9eaf4e2`

---

### MEDIUM — Push-event IPC path bypasses `parseBackgroundTask`

**Files:** `electron/core/jobs-ipc.ts:67–71`, `electron/preload.cts:147`, `v3/renderer/src/core/jobs.ts:69–73`

**Evidence:**
The subscribe callback in `jobs-ipc.ts` forwards `coreEvent.payload` directly to the renderer without any structural validation:

```ts
// jobs-ipc.ts:67-71
dependencies.core.subscribe((coreEvent) => {
  const window = dependencies.getMainWindow();
  if (!window || window.isDestroyed()) return;
  window.webContents.send("candor-events:jobs-changed", coreEvent.payload); // raw, unvalidated
});
```

The preload delivers this as raw `JsonValue`, but `candor-api.d.ts:178` declares the listener as `(payload: BackgroundTask) => void`. Consumers in `jobs.ts` access `payload.jobId` and `payload.terminal` directly from the unvalidated payload.

The pull path (`jobs.get` → `jobs-ipc.ts:14`) correctly applies `parseBackgroundTask`. The push path does not.

**Impact:**
The type contract between main and renderer is broken on the event path. All safety assertions (`rawPathExposed !== false`, `keyMaterialExposedToRenderer !== false`, `sourceDataPreserved === true`, `terminal === terminalStateSet.has(state)`, `cancelRequested === cancellationState`) are only enforced on pull. An unexpected or malformed event payload reaches the renderer as a `BackgroundTask`.

**Mitigating factors:**
`emit()` always calls `value(false)` (`job_manager.rs:1830`), so `result` is always `null` in push events — the most sensitive fields never appear in the push path. In practice, `options.onProgress?.(payload)` in `jobs.ts:71` is never called from the reviewed code, and terminal resolution always falls through to the validated `inspect()` → `getJob()` pull. The practical risk window is narrow.

**Fix:**

```ts
// jobs-ipc.ts — in the subscribe callback
try {
  const validated = parseBackgroundTask(coreEvent.payload) as unknown as JsonValue;
  window.webContents.send("candor-events:jobs-changed", validated);
} catch {
  // drop malformed event silently — pull will reconcile
}
```

---

### MEDIUM — "stage" progress unit leaks to the wire when `total ≤ 0`

**File:** `crates/candor-core/src/job_manager.rs:521–530`

**Evidence:**

```rust
let (completed, total, unit) = match (unit, total) {
    (Some("stage" | "job"), Some(total)) if total > 0 => (
        completed.saturating_mul(100) / total,
        Some(100),
        Some("percent"),
    ),
    _ => (completed, total, unit),  // "stage" passes through if total == 0 or None
};
```

`background-task.ts:144–147` rejects any unit not in `["percent", "seconds", "chunks", "bytes"]`:

```ts
|| typeof progress.unit !== "string"
|| !unitSet.has(progress.unit)
```

If any callee invokes `context.progress("stage-name", value, None, Some("stage"))` or with `total=0`, it emits the literal string `"stage"` to the job store, and the next `parseBackgroundTask` call throws `CORE_PROTOCOL_FAULT`, rendering the job permanently invalid to the renderer until the entry is removed.

**Current coverage:** All calls in the reviewed scope use `Some("stage")` with positive totals, so this is not currently triggered. The risk is latent and would appear if any new service or transcription job calls `context.progress` with `None` total and "stage" unit.

**Fix:** Replace the catch-all with an explicit fallback:

```rust
(Some("stage" | "job"), _) => (
    completed.min(99), // cap below 100 so "unknown progress" is obvious
    None,
    Some("percent"),
),
```

---

### LOW — `with_ai_provenance` silently drops provenance on non-object result

**File:** `crates/candor-core/src/background_jobs.rs:642–658`

**Evidence:**

```rust
fn with_ai_provenance(mut result: Value, ...) -> Value {
    if let Some(root) = result.as_object_mut() {
        root.insert("provenance".to_string(), json!({...}));
    }
    result  // returned unchanged if not an object
}
```

If `heuristic_recap` or `heuristic_ask` returns `Value::Null` or an array, provenance is silently omitted. The subsequent `record_ai_processing_fact` call receives `result.get("provenance").unwrap_or(&Value::Null)`, which is `null`, and fails with `PRIVACY_AI_PROVENANCE_INVALID` — a retryable error that surfaces as a confusing persistence failure rather than an AI-output error.

**Impact:** Low — the heuristic services return objects in practice, and the failure is recoverable. But the error surface is misleading.

**Fix:** Assert the precondition:

```rust
fn with_ai_provenance(mut result: Value, ...) -> Value {
    let root = result.as_object_mut()
        .expect("AI result must be a JSON object");
    root.insert("provenance".to_string(), json!({...}));
    result
}
```

Or return a `Result<Value, JobFailure>` from this helper.

---

### LOW — `exports.create` TypeScript surface is untyped `JsonValue`

**Files:** `electron/preload.cts:125`, `v3/renderer/src/candor-api.d.ts:158`

**Evidence:**

```ts
// candor-api.d.ts:158
create(input: JsonValue): Promise<JobAccepted>;
```

Runtime validation in `validatePrivateCoreParamsAlias("export.create", input)` fully constrains the shape, but the TypeScript declaration gives callers no type safety at the call site. A caller that forgets `recordingId` or passes the wrong format string gets no compile-time feedback.

**Fix:**

```ts
create(input: {
  recordingId: string;
  format?: "markdown" | "docx" | "pdf" | "wav";
  channel?: string;
  report?: JsonValue;
  options?: JsonValue;
}): Promise<JobAccepted>;
```

---

### Invariant-by-invariant verdicts

**1 - Local LLM is the default for recap and Ask** ✅
`AiExecutionMode` derives `#[default] LocalLlm` (`job_manager.rs:113`). The auto-recap follow-up from transcription hardcodes `LocalLlm` (`background_jobs.rs:578`). The input validator defaults `mode` to `"local-llm"` (`validate-private-core-input.ts:177`). The renderer defaults `aiMode` to `"local-llm"` (`useLocalAiWorkspace.ts:131`).

**2 - Heuristic fallback is explicit or follows an allowlisted failure** ✅
`disclosed_fallback_reason` gates fallback on `allowed_fallback_reason`, which is an explicit allowlist of ~28 error codes (`background_jobs.rs:691–740`). Unrecognized codes produce `None`. Explicit `HeuristicFallback` mode is only accepted when the caller provides `mode: "heuristic-fallback"`, and the input validator rejects `heuristic-fallback + require-local-llm` (`validate-private-core-input.ts:185`).

**3 - Cancellation, shutdown, and recording-priority preemption never create heuristic output** ✅
`is_non_fallback_error` covers `JOB_CANCELLED`, `APP_SHUTTING_DOWN`, `RECORDING_PRIORITY`, `LOCAL_LLM_COMMAND_CANCELLED`, `LOCAL_MODEL_JOB_ACTIVE` (`background_jobs.rs:669–678`). `disclosed_fallback_reason` checks `context.cancelled()` first. In `spawn_descriptor`, the preemption path is only entered on `result.is_err()`. If a job completes naturally while preemption is in flight, `finish_completed` checks `entry.state == Cancelling` (set by `set_recording_active`) and calls `finish_entry_cancelled` instead (`job_manager.rs:1693–1694`). Post-result cancellation is also caught by the `if context.cancelled()` guard in `recap`/`ask` before `record_ai_processing_fact` (`background_jobs.rs:271–276`, `363–369`).

**4 - Strict retry requires the local LLM and preserves the previous result on failure** ✅
`retryRecapWithLocalAi` and `retryAskWithLocalAi` send `mode: "local-llm", fallbackPolicy: "require-local-llm"` (`useLocalAiWorkspace.ts:375–379`, `414–418`). If the retry job fails, `waitForJob` throws, the `catch` in `useOperationRunner.ts:55` runs `setError` only, and `setRecap`/`setAskAnswer` are never called — the previous result is preserved in component state.

**5 - Provenance is typed, safe, persistent, and visible whenever fallback is used** ✅ (with LOW caveat above)
`with_ai_provenance` stamps a structured provenance object with typed `engine`, `fallbackUsed`, `fallbackReason` (allowlist), `promptVersion`, and `generatedAt`. `record_ai_processing_fact` re-validates every field before persisting to the recording manifest. `canonicalAiProvenance` in `operation-registry.ts:99–130` validates the same envelope at the IPC boundary. `parseProvenance` in `background-task.ts:204–240` validates it again before renderer state. `MeetingDetailView.tsx` renders an `inline-alert` whenever `provenance.fallbackUsed` (`MeetingDetailView.tsx:37`, `44`). The only gap is the silent drop described under LOW above.

**6 - All background task kinds, states, progress units, ETA rules, terminal semantics, and completed results are validated before renderer state** ✅ (with MEDIUM caveat on push-event path)
`parseBackgroundTask` enforces `kindSet`, `stateSet`, `unitSet`, `terminal === terminalStateSet.has(state)`, `cancelRequested === cancellationState`, `paused → retryable`, `estimatedRemainingMs only when Running`, and error only when `state === "failed"`. `validateCompletedJobResult` enforces per-type result schemas with `rejectSensitiveResultKeys` scanning recursively. The pull path is fully protected; the push path is not (MEDIUM finding).

**7 - Renderer-facing tasks cannot expose paths, keys, prompts, transcripts, or unvalidated extension fields** ✅
`taskFieldSet` (22 fields) hard-rejects any field outside the allowlist via `hasOnlyFields`. `forbiddenCompletedResultKeys` includes `"path"`, `"prompt"`, `"rawPrompt"`, `"transcript"`, `"privateKey"`, `"systemPrompt"`, `"modelPath"`, `"runnerPath"`, `"secret"`, `"sourcePath"`, `"keyMaterial"`, `"archiveBase64"`, `"licenseToken"` and is applied recursively by `rejectSensitiveResultKeys`. The `recordingId` in the task payload is validated against `safeIdentifierPattern` (not a filesystem path). The stage field is constrained to `safeStagePattern = /^[a-z0-9][a-z0-9-]{0,63}$/`. Results are always projected through `canonicalResult` field lists.

**8 - `CandorApiV3` exposes no generic command or executable path surface** ✅
`preload.cts` exposes no `exec`, `spawn`, `shell`, `path`, or `command` surface. File-picker operations (`chooseSpeechModel`, `chooseEnhancedComponent`, `importLegacy`, `importDictionary`) open OS-native dialogs in the main process — the renderer supplies at most a type-constrained `component: "engine" | "model"`, an `expectedSha256`, or a `modelId`; never a filesystem path. `ai.instructAssetsImportFromPath` (which accepts `sourcePath`) is in `privateConfigs` only and has no corresponding preload entry or IPC channel.

---

### No critical or high findings remain.

The two medium findings (push-event validation gap, "stage" unit leak) are reliability/contract issues without a currently exploitable path. All eight invariants hold on the pull path; the push path has a partial gap limited to non-result metadata.
