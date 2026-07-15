I now have a complete picture of all primary files. Here is the adversarial review.

---

# Candor Windows Public Beta Hardening — Focused Review

**Scope**: hardening files only, unrelated workspace changes excluded.
**Evidence base**: all fourteen Rust source files, eleven TypeScript/JavaScript files, two lock files, two signing scripts, and the verifier script read in full.

---

## Q1 — Can any LLM-ready or provenance path use a sentinel, stale, or renderer-supplied model identity?

**No.** The identity chain is correct on every boundary.

**Rust side**
- `bundled_ai_assets.rs:676-679` — `valid_sha256()` rejects exactly-zero SHA256 values (`value.bytes().any(|byte| byte != b'0')`), so an all-zeros sentinel can never pass the manifest validation step.
- `bundled_ai_assets.rs:283-307` — `required_language_identity()` requires `model_id` to be non-empty after trimming; it derives the SHA256 directly from the manifest record that was just verified against the file on disk (size + SHA256 match in `inspect_asset()`).
- `background_jobs.rs:413-431` — `required_local_llm_identity()` first checks that `configuration/source == "bundled-package"` in the live status before calling `required_language_identity()`. Any other source (managed, environment, mixed) is rejected with `LOCAL_LLM_IDENTITY_UNVERIFIED` before the model runs.
- Identity is checked **before** generation and **after** generation (`background_jobs.rs:239-258` for recap, `341-362` for ask) with `LOCAL_LLM_IDENTITY_CHANGED` if the bundle changed mid-run.

**Renderer boundary**
- The preload (`preload.cts`) exposes no surface for supplying model identity. The renderer cannot set `modelId`, `modelSha256`, or `runtimeSha256`.
- `canonicalAiProvenance()` in `operation-registry.ts:99-148` and `parseAiProvenance()` in `contracts.ts:908-951` both enforce:
  - `engine === "local-llm"` → `modelId` (non-null string), `modelSha256` and `runtimeSha256` (exactly `/^[a-f0-9]{64}$/`), `fallbackUsed === false`, `fallbackReason === null`.
  - `engine === "heuristic"` → `modelId`, `modelSha256`, `runtimeSha256` all null; `fallbackUsed === true`; `fallbackReason` a known string.

**One theoretical concern, not a practical defect**: the SHA256 cache in `bundled_ai_assets.rs:518-543` is keyed by (path, bytes, modified_unix_ms). An in-place file replacement with an identical size and NTFS mtime would serve a stale digest. This cannot happen for packaged assets in a signed installer under normal operation, so it does not require a fix before release.

**Verdict**: Identity path is sound. No sentinel, stale-cache, or renderer-supply issue is reachable in the release configuration.

---

## Q2 — Can Ask First accidentally fall back, or can strict retry overwrite a previous result?

**Neither**.

**Ask First cannot fall back automatically.**
- `ai_fallback_preference.rs:50-55` — `AskFirst.default_fallback_policy()` returns `RequireLocalLlm`.
- `background_jobs.rs:723-732` — `disclosed_fallback_reason()` returns `None` for `RequireLocalLlm`, making `recap_fallback_or_fail()` return an error instead of heuristic output.
- Cancellation, shutdown (`APP_SHUTTING_DOWN`), and recording-priority preemption (`RECORDING_PRIORITY`, `LOCAL_MODEL_JOB_ACTIVE`) are all blocked from triggering fallback by `is_non_fallback_error()` (`background_jobs.rs:712-720`).
- Additionally, the cancellation flag is checked at `background_jobs.rs:269` before `recap_fallback_or_fail()` is called, providing a second layer of protection.

**Strict retry does not overwrite the previous result.**
The strict-retry pattern (`intent: "strict-retry"`) creates a **new job** via `ai.recap.start` or `ai.ask.start` (`main.rs:1357-1393`). The original completed job remains in the job manager with its result intact. The new job has a fresh job ID and no prior result. If the new job fails (with `RequireLocalLlm` policy forbidding fallback), the original job's result is still readable via `jobs.get(originalJobId)`.

`jobs.retry` (the paused/failed job restart path) does wipe `entry.result = None` before re-running (`job_manager.rs:1049`). However, this is never called with a non-null result to lose: only Failed, Cancelled, and Paused jobs are retryable (`job_manager.rs:1033-1035`), and none of those states ever carry a prior result:
- `finish_entry_cancelled()` sets `result = None`.
- `finish_failed()` never sets `result` (only sets `error`).
- Paused jobs (`set_paused()`) have no result; `from_persisted()` explicitly sets `error = None` for paused recovery.

**Verdict**: Ask First is strict. Strict retry is safe. No regression.

---

## Q3 — Are output schemas, source grounding, cancellation, prompt transport, and frontend selection fail-closed?

All five properties are fail-closed.

**Output schemas**
- `GROUNDED_RECAP_JSON_SCHEMA` and `GROUNDED_ASK_JSON_SCHEMA` (`local_instruct_model.rs:56-57`) use `"additionalProperties": false` and `"const":[]` / `"const": null` to fix the shape of each mode. The schema is passed via `--json-schema` to `llama-completion` (`run_llama_command()` line 1015-1017).
- Thinking is disabled in both subprocess flag arrays via `"--reasoning", "off", "--reasoning-budget", "0"` (lines 58-75).

**Source grounding**
- After inference, `validate_grounded_batch()` → `validate_and_render()` cross-validates every `sourceId` in the output against the actual segment citation IDs. A claim with an unknown source ID is rejected.
- The operation registry's `strictLocalAiResultSchema()` (`operation-registry.ts:215-241`) independently verifies that `sourceIds` in the rendered result all exist in the `citations` array, and that each claim's `sourceIds` references only verified citation IDs.

**Cancellation**
- The subprocess poll loop in `run_llama_command()` (`local_instruct_model.rs:1087-1096`) checks the cancellation flag every 25 ms, kills and waits for the child, drains both pipes, and returns `LOCAL_LLM_COMMAND_CANCELLED`. This code cannot be reached with a null cancellation flag in the background job path because `JobContext::cancellation_flag()` always returns the job's own `AtomicBool`.

**Prompt transport**
- On Windows, `open_private_prompt_file()` (`local_instruct_model.rs:876-938`) uses `CreateFileW` with a DACL of `D:P(A;;FA;;;OW)(A;;FA;;;SY)` — owner and LocalSystem only. `CREATE_NEW` prevents races.
- `run_prompt_with_config()` (line 808-826) deletes the prompt file after the command returns. If the deletion fails, the function returns `LOCAL_LLM_PROMPT_DELETE_FAILED` and the run is aborted.
- `sensitive_path_kind()` (lines 1196-1220) scans the model output for model path, binary path, and prompt path substrings; any match returns `LOCAL_LLM_OUTPUT_PATH_EXPOSURE`.

**Frontend selection**
- `run_llama_command()` line 989-994: if `!is_llama_completion_frontend(binary_path)`, the function immediately returns `LOCAL_LLM_FRONTEND_UNSUPPORTED` before spawning any process. The legacy `llama-cli` flags array can never be reached.

**Observation (no fix needed)**: `LLAMA_CLI_SUBPROCESS_FLAGS` (line 58-66) and the `else { &LLAMA_CLI_SUBPROCESS_FLAGS }` branch at line 997-998 are unreachable dead code now that the frontend guard at line 989-994 exits before them. This is harmless but could be removed for clarity.

**Verdict**: All five properties fail-closed.

---

## Q4 — Do background task ordering, announcements, and cancellation match their typed states?

**Yes**, with one observation on a non-defect.

**Ordering**: `BackgroundActivity.tsx:93-98` lists sections as `[failed, inProgress, queued, recent]`, filtered for non-empty. Failed tasks ("Needs attention") appear before active and queued work, satisfying the accepted ordering.

**Accessibility announcements**: `terminalTasksAnnouncement()` (`BackgroundActivity.tsx:62-72`) aggregates all terminal-state changes in one string: completed, failed, and cancelled counts are joined. Simultaneous terminal changes produce a single announcement, not multiple rapid updates.

**Cancellation target set**: `CANCELLABLE_TASK_STATES` (`BackgroundActivity.tsx:56-60`) = `{queued, running, paused}`. This is identical to the Rust `JobState::cancellable()` (`job_manager.rs:102-104`). Cancelling and all terminal states are excluded.

**`cancel_all()` scope** (`job_manager.rs:929-971`): iterates only over `entry.state.cancellable()` jobs. Already-Cancelling jobs are counted as `skipped_count` (lines 938-940) and are not double-cancelled.

**`cancelRequested` consistency**: The TypeScript parser (`background-task.ts:306-318`) enforces that `cancelRequested === true` for `cancelling` and `cancelled` states, with the sole exception of `stage === "yielding-to-recording"` where preemption sets the state to Cancelling without a user cancel. The Rust implementation generates exactly this exception (`job_manager.rs:1321-1323`).

**Verdict**: Ordering, announcements, and cancellation all match.

---

## Q5 — Can public packaging succeed unsigned, omit sidecar signing, or leak signing secrets?

**No to all three.**

**Fail-closed on missing configuration**: `electron-builder.release.cjs` calls `buildWindowsReleaseConfig()` with no environment override, so it reads `process.env`. `requireSigningEnvironment()` (`windows-release-signing-config.cjs:15-47`) checks all seven required variables and throws a descriptive error naming every missing one before returning. The build cannot proceed without all of them.

**HTTPS enforcement**: `parsedEndpoint.protocol !== "https:"` check at line 31-34 rejects HTTP endpoints. Both `http://` and non-URL strings are caught.

**`forceCodeSigning: true`**: Set at `windows-release-signing-config.cjs:64`. This instructs electron-builder to fail if code signing cannot complete.

**Sidecar signing**: `signExts` always includes `.exe` (line 71). The `spec6` verifier confirms that `extraResources` contains an entry with `to === "bin"` and a filter including `"candor-core.exe"` (`spec6-release-signing-config.mjs:59-63`), ensuring the sidecar is covered by the `.exe` signing extension.

**Credential leak**: `azureSignOptions` contains `publisherName`, `endpoint`, `codeSigningAccountName`, `certificateProfileName`, `fileDigest`, `timestampDigest`, and `timestampRfc3161` only. `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID`, and `AZURE_CLIENT_ID` are consumed by the Azure SDK from `process.env` and never written into the config object. The spec6 verifier asserts this at lines 53-57.

**Verdict**: Signing is fail-closed. No sidecar omission path. No credential leak into config.

---

## Q6 — Do model-lock and verifier rules accurately describe Whisper provenance?

**Yes**, and the distinction is correctly maintained at two levels.

**`third_party/model-lock.json`**:
- `"upstreamPublisher": "OpenAI"` — identifies the original model author.
- `"distributionSource": "ggerganov/whisper.cpp"` with a pinned `"distributionRevision": "5359861c739e955e79d9a303bcbc70fb988958b1"` — identifies the canonical artifact source.
- `"provenanceStatus": "canonical-whisper-cpp-artifact-pinned"` — correctly describes that the artifact is the whisper.cpp distribution, not a direct OpenAI release.

All four speech model candidates share the same `distributionRevision`, and all point to the same HuggingFace `ggerganov/whisper.cpp` space for their `sourceUrl`, consistent with pinning a single distribution snapshot.

**`third_party/runtime-lock.json`**:
- For the speech runtime, both the whisper-rs wrapper (`"component": "whisper-rs and whisper-rs-sys"`) and the embedded upstream library (`"component": "embedded whisper.cpp 1.8.3"`) are separately licensed and sourced. This correctly distinguishes the Rust binding crate from the embedded C++ library.
- The `whisper-model-card` notice pins the HuggingFace README at the same distribution revision (`5359861c...`), confirming artifact traceability.

**Verifier (`spec3-verify-ai-bundle.mjs`)**: Performs SHA256 file verification against manifest-declared hashes and containment checks against the bundle root. It does not independently validate the provenance chain against model-lock, but the bundled manifest's `sourceUrl` and `revision` fields are verified by the install process.

**Verdict**: Provenance is accurately described and correctly distinguished.

---

## Q7 — Which critical or high-severity issues must be fixed before the full verification run?

**No critical or high-severity defects were found.** One low-severity race condition is the only confirmed observable defect.

---

### L-01 · Low severity · `jobs.cancelAll` staging cleanup can race a concurrent import job

**Files**: `crates/candor-core/src/main.rs:1903-1918` and `crates/candor-core/src/background_jobs.rs:526-555`

**Evidence**:
```rust
// main.rs — handler runs on the single-threaded request loop
"jobs.cancelAll" => match state.job_manager.cancel_all() {
    Ok(value) => {
        for token in state.job_manager.dictionary_staging_references() {
            if let Err(error) = state.dictionary_staging.delete(&token) {
                return make_error_with_retryability(...);  // ← returns error response
            }
        }
        state.job_manager.discard_all_dictionary_staging();
        value
    }
```

```rust
// background_jobs.rs — running in its own thread
if context.cancelled() {
    self.remove_dictionary_staging(&staging_token)?;  // deletes file
    return Err(JobFailure::new("JOB_CANCELLED", ...));
}
```

**How it triggers**: `cancel_all()` sets the running import job to `Cancelling` and stores the atomic cancellation flag. The background thread is still running. On the next statement, `main.rs` reads `dictionary_staging_references()`, finds the import job's token (its descriptor is still present), and attempts `dictionary_staging.delete(&token)`. Meanwhile, the background thread's next cancellation check fires, deletes the same staging file, and exits.

**Two failure modes**:
1. Main thread deletes first → background job's `remove_dictionary_staging()` returns an error → the job transitions to `Failed` with a staging error code rather than `Cancelled`. The user sees "Failed" instead of "Cancelled."
2. Background job deletes first → main thread's `delete()` fails → the `cancelAll` request handler returns an error response to the renderer even though all jobs were in fact cancelled.

**No security impact, no data loss.**

**Concrete fix**: Change `dictionary_staging.delete()` to tolerate a missing file (return `Ok(())` if the file does not exist), or move the staging cleanup loop to after `discard_all_dictionary_staging()` so the token-to-descriptor mapping is cleared first, reducing (though not eliminating) the window.

---

### Improvements identified (not defects, no fix required before release)

**I-01**: `LLAMA_CLI_SUBPROCESS_FLAGS` (`local_instruct_model.rs:58-66`) and the `else { &LLAMA_CLI_SUBPROCESS_FLAGS }` branch at line 997-998 are dead code. The `!completion_frontend` early-return guard at lines 989-994 exits before they can be reached. No semantic effect; can be removed in a follow-up.

**I-02**: Old persisted Recap and Ask job descriptors that lack a `fallback_policy` field (e.g., from schema v1 recovery) will deserialize to the Rust default `AllowDisclosed` (`job_manager.rs:126`). This means paused jobs that recover across a schema upgrade will retry with a permissive policy even if the user has `AskFirst` or `Never` preference. This is a one-time migration trade-off acceptable for a public beta given the schema version bump.

---

### Answers in brief

| Q | Verdict |
|---|---------|
| 1. Sentinel/stale/renderer identity | **No** — identity chain is tight at every layer |
| 2. Ask First accidental fallback / strict retry overwrites | **No** to both |
| 3. Schema, grounding, cancellation, transport, frontend | **All fail-closed** |
| 4. Task ordering, announcements, cancellation states | **Match exactly** |
| 5. Unsigned packaging / missing sidecar / credential leak | **None possible** |
| 6. Whisper provenance accuracy | **Correctly described** |
| 7. Must-fix before full verification run | **None** (L-01 is low severity, no security/data impact) |
