I now have enough context to write the full plan.

---

# SPEC-5 Refined Implementation Plan

Independent senior review. Read-only assessment. No repository edits made.

---

## Grounding observations

Before addressing the seven questions, two structural facts constrain every decision:

**The closures-in-threads model is the load-bearing problem.** `JobManager::submit` takes `FnOnce(JobContext) -> Result<Value, JobFailure> + Send + 'static`. Non-serializable closures capture clones of services (recording store, model manager, terminology service). There is no way to persist or restart a closure. Every persistence approach must replace the closure with a serializable descriptor, and that descriptor must be convertible back to the same work by Rust code — not by the renderer.

**The inference gate and the model scheduler are two separate serialization points that the plan must not conflate.** `inference_gate: Mutex<()>` in `JobManagerInner` is the coarse job-level gate (one inference job at a time). `LocalModelScheduler` is the fine-grained per-thread scheduler (one model inference call at a time). Recording priority should act on the coarse gate. Cancellation flags act at the fine level.

---

## Answers to the seven planning questions

### Q1 — Smallest safe persistence architecture

**Answer: a single JSONL append-log for pending descriptors, compacted atomically on terminal state.**

The correct model already exists in this codebase: `RecordingStore` uses JSONL manifest files with atomic rename. Reuse the same pattern.

Structure:
- One file: `{settings_root}/jobs/pending-jobs.jsonl`
- Each line: `{ "jobId": "...", "descriptor": {...}, "queuedAt": "..." }` — written before the thread spawns
- On terminal completion: write a second line `{ "jobId": "...", "terminal": true, "state": "..." }` — the latest entry for a job id wins
- On startup: scan the log, collect all job ids where the last entry is non-terminal, compact to a new file, re-queue those jobs

This does not require SQLite, a database crate, or WAL machinery. The existing file I/O patterns and atomic-rename discipline already in `recording_store.rs` are sufficient.

**Scope constraint:** Only jobs submitted via the new `submit_descriptor` path are restartable. The existing closure-based `submit` path remains as-is for non-restartable work (model verification, V2 import, export, benchmark). The restartable jobs are exactly three: `transcription`, `recap`, and `ask`. These are the ones the handoff requires to survive a crash.

### Q2 — Task descriptors replacing closures without widening the trust boundary

**Answer: define a Rust-internal `TaskDescriptor` enum in `job_manager.rs`; never expose the enum to the renderer.**

```rust
// in job_manager.rs or a new job_descriptor.rs
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum TaskDescriptor {
    Transcription {
        recording_id: String,
        #[serde(default)]
        chain: Option<Box<TaskDescriptor>>,
    },
    Recap {
        recording_id: String,
        #[serde(default)]
        quality: AiJobQuality,
    },
    Ask {
        recording_id: String,
        question: String,
        #[serde(default)]
        quality: AiJobQuality,
    },
}
```

The public API stays as `submit_descriptor(descriptor: TaskDescriptor, services: &ServiceBundle)`. The renderer can still call `transcription.start` and `ai.recap.start` — those RPC handlers decode their own typed params and then call `submit_descriptor`. No renderer-provided string reaches the descriptor's kind discriminator.

`ServiceBundle` is a `Clone`-able struct holding `RecordingStore`, `BundledAiAssets`, `TerminologyService`, and `ModelManager` — the same clones already threaded into closures today. This is the only API surface change in `main.rs`: replace the inline closure with `state.job_manager.submit_descriptor(descriptor, &ServiceBundle::from_state(state))`.

The trust boundary is unchanged: the renderer sends RPC method names and typed params; Rust decodes them into `TaskDescriptor` variants using the existing `deny_unknown_fields` serde pattern.

### Q3 — Recording priority without arbitrary suspension

**Answer: gate new inference on a `recording_active` flag; never try to interrupt a running inference.**

The cancellation flags in whisper-rs and llama.cpp allow cooperative early exit. They do not allow suspension and resumption. Attempting to "pause" mid-inference risks leaving model state inconsistent.

The correct, safe policy:

1. Add `recording_active: Arc<AtomicBool>` to `JobManagerInner`.
2. When `capture.start{Mic,System,MicAndSystem}` succeeds, call `job_manager.set_recording_active(true)`.
3. In `submit` (and `submit_descriptor`), before acquiring `inference_gate`, check `recording_active`. If set, return immediately with `JobFailure { code: "RECORDING_PRIORITY", retryable: true }` without touching the gate.
4. When `capture.stop` completes finalization (the durable store write returns `Ok`), call `job_manager.set_recording_active(false)`.
5. The auto-queued transcription (Phase 2) is submitted _after_ `set_recording_active(false)` — it is therefore never blocked by itself.

A job that is already running inference when a new capture starts is allowed to finish. Only _new_ inference jobs are gated. This is acceptable: the overlap is at most a few seconds, finalization is never delayed, and the running inference job will not overwrite capture audio.

**Monitoring surface:** expose `recordingActive` in `ai.status` so the renderer can explain to users why new AI jobs are queued but not starting.

### Q4 — Where chaining should live

**Answer: in Rust core, embedded in the `TaskDescriptor` as an optional `chain` field, executed by `JobManager` on successful completion.**

The chain must be independent of the renderer because:
- The renderer may be mid-navigation or display a loading state when the transcription job completes
- A renderer-driven chain would fail silently if the window is closed or the renderer reloads

The flow:
1. `capture.stop` calls `job_manager.submit_descriptor(TaskDescriptor::Transcription { recording_id, chain: Some(Box::new(TaskDescriptor::Recap { recording_id, quality: Fast })) })`
2. `JobManager::finish_completed` checks whether the finished job had a `chain` descriptor. If so, it calls `submit_descriptor` for the chain immediately (on the same thread, before emitting `jobs.changed`).
3. The chain is persisted as part of the parent descriptor; if the app crashes after transcription completes but before recap is queued, the replay logic detects a completed transcription with a pending chain and re-queues only the recap.

If transcription is cancelled or fails, the chain is discarded. The recording audio is safe. The user sees the transcription as failed and can retry manually.

The renderer does not need any knowledge of chaining. It observes two `jobs.changed` events in sequence.

### Q5 — Safe `.candordict` container and signature policy

**Answer: a ZIP archive with a detached Ed25519 signature; three trust tiers; no per-term pharmaceutical allow-list.**

**Archive layout:**
```
example.candordict (ZIP)
├── manifest.json     { name, version, trustTier, signerKeyId, entryCount }
├── entries.jsonl     one TerminologyEntry per line, same schema as current import
└── SIGNATURE.bin     Ed25519 signature over SHA-256(manifest.json || entries.jsonl)
```

**Trust tiers:**
| Tier | Signature required | Signing key source | Default `requiresApproval` |
|---|---|---|---|
| `candor-official` | Yes | Embedded public key constant in binary | No (entries are auto-applied) |
| `organization` | Yes | User-imported org key (stored in terminology store) | No |
| `community-unverified` | No | — | **All entries** |

The pharmaceutical safeguard in the handoff is stated as a term-list check. **This should not be implemented literally.** A static pharmaceutical term database: (a) goes stale, (b) produces false positives on legitimate medical terms, (c) is a maintenance obligation with no review process. The correct policy is to apply `requiresApproval: true` to all entries from `community-unverified` packs. This is stricter, simpler, and does not require curating a drug name list. Only `candor-official` and `organization` packs with valid signatures bypass the per-correction approval gate — and those packs would be reviewed before signing.

**Bounds:** apply the same `MAX_ENTRIES_PER_DICTIONARY: 20_000` and `MAX_TOTAL_ENTRIES: 50_000` limits already in `terminology_dictionary.rs`. Check uncompressed size before extracting (max 8 MB for the entries file). Reject archives with more than 3 files in the ZIP root.

**Rust dependencies needed:** `zip = "2"` (already a common crate in the Rust ecosystem), `ed25519-dalek = "2"`. Both are pure-Rust, no build-time obstacles on the existing Windows toolchain.

### Q6 — Close behavior without tray persistence

**Answer: an explicit dialog with three options; no background mode; persisted descriptors provide the safety net.**

When the close button fires and `job_manager.has_active_jobs()` returns true (separate from active capture):

```
"Background tasks are still running.

  [Wait until finished]        — dismisses dialog, user stays in app
  [Cancel tasks and quit]      — signals all cancellable jobs, waits ≤ 5 s, then closes
  [Quit now]                   — closes immediately; pending descriptors will restart next launch
```

"Quit now" is safe precisely because Phase 1 (persistent descriptors) means incomplete transcription and recap jobs will be re-queued automatically on next launch. The user does not lose data. The dialog should say so: "Unfinished tasks will restart automatically next time you open Candor."

There is no fourth option for tray persistence. There is no background mode. If the user chooses "Quit now", the `core.shutdown` RPC fires and the process exits.

The existing `capture-close-guard.ts` handles capture. The new guard layer wraps it: capture check happens first (because capture involves live audio and cannot restart); active-jobs check happens second.

### Q7 — Repository-controlled acceptance checks vs external release blockers

**Repository-controlled (implement now):**
- Job persistence: `submit_descriptor` → JSONL → restart recovery test passes
- Capture-stop chain: `capture.stop` → transcription job queued → recap job queued (verifiable with synthetic test)
- Recording-priority gate: inference jobs return `RECORDING_PRIORITY` while `recordingActive` is true
- Close guard: dialog appears when active jobs exist, no silent tray persistence
- `.candordict` import: valid archive with good signature imports; bad signature rejected; community-unverified entries flagged
- Pharmaceutical safeguard alternative: `community-unverified` entries all set `requiresApproval: true`
- Background Activity panel: visible job list with acknowledged completed and failed-with-retry states

**Must remain external release blockers (do not implement or claim):**
- Real Whisper model files on disk (hashes exist in model-lock, files do not)
- LLM GGUF artifact with verified SHA-256 (`expectedSha256: null` in model-lock)
- LLM redistribution review (`redistributionReview: "pending"`)
- Benchmarks on representative hardware (all `benchmarkStatus: "pending"`)
- Code signing certificates, notarization, and clean-machine offline receipts
- `releaseReady: true` in `build/ai-bundle/manifest.json`

---

## Phase-ordered implementation plan

### Phase 1 — Persistent job descriptors *(Rust only)*

**Files owned:**
- `crates/candor-core/src/job_manager.rs` — add `TaskDescriptor`, `ServiceBundle`, `submit_descriptor`, `set_recording_active`, `has_active_jobs`, plus `pending_jobs.jsonl` read/write
- `crates/candor-core/src/main.rs` — add `ServiceBundle::from_state(state)`, update `transcription.start`, `ai.recap.start`, `ai.ask.start` to call `submit_descriptor`

**Required changes:**
1. `TaskDescriptor` enum (Transcription, Recap, Ask) with `chain: Option<Box<TaskDescriptor>>`
2. `JobPersistenceLog`: append-on-submit, mark-on-terminal, compact-on-startup
3. `JobManager::submit_descriptor` dispatches descriptor to the existing closure machinery
4. On `finish_completed`, fire chain if present (before emitting event)
5. On startup, `JobManager::recover_pending(log, services)` re-queues non-terminal entries

**Tests to add:**
- Job submitted, process conceptually restarts (drain thread, reconstruct manager from log file), job is re-queued
- Chain: transcription completes → recap is auto-submitted
- Chain: transcription fails → recap is NOT submitted
- Terminal descriptor entries are not re-queued
- Partial JSONL line (simulate crash mid-write) is skipped without panic

### Phase 2 — Recording-priority gate *(Rust only)*

**Files owned:**
- `crates/candor-core/src/job_manager.rs` — add `recording_active: Arc<AtomicBool>`, `set_recording_active(bool)`
- `crates/candor-core/src/main.rs` — call `set_recording_active(true)` in capture start handlers; call `set_recording_active(false)` after finalization in `capture.stop`

**Tests to add:**
- Inference job submitted while `recording_active = true` returns `RECORDING_PRIORITY` immediately
- Inference job submitted after `set_recording_active(false)` proceeds normally
- Non-inference job (export) is not affected by `recording_active`

### Phase 3 — Capture-stop auto-chain *(Rust only)*

**Files owned:**
- `crates/candor-core/src/main.rs` — `capture.stop` handler: after `capture_manager.stop()` returns `Ok`, before returning to renderer, call `submit_descriptor(Transcription { recording_id, chain: Some(Recap { ... }) })`

**Note:** This changes the meaning of `capture.stop`. The renderer currently calls `transcription.start` separately. After this change, it should not. Add a `"autoProcessingQueued": true` field to the `capture.stop` response so the renderer can detect the new behavior and skip its own `transcription.start` call without a flag.

**Tests to add:**
- Synthetic capture stop produces a queued transcription job
- Transcription completion produces a queued recap job
- If transcription job is cancelled, recap is not auto-submitted
- `capture.stop` response includes `autoProcessingQueued: true`

### Phase 4 — Active-jobs close guard *(TypeScript/Electron)*

**Files owned:**
- `electron/window/capture-close-guard.ts` — extend `CaptureCloseGuardDependencies` to include `activeJobCount(): number` and `cancelAllJobs(): Promise<void>`
- Electron main window setup — wire `activeJobCount` and `cancelAllJobs` to the core client

**Required changes:**
1. After the capture-phase check passes (phase is idle), check `activeJobCount() > 0`
2. Show a dialog with Wait / Cancel-and-quit / Quit-now options
3. "Cancel tasks and quit": `cancelAllJobs()` then poll `activeJobCount()` until 0 or 5-second timeout, then `approveAndClose()`
4. "Quit now": `approveAndClose()` immediately
5. "Wait": reset `closeInProgress = false`, return

**Tests to add:**
- Guard with no active capture and no active jobs: close proceeds without dialog
- Guard with active jobs and no capture: dialog appears; "wait" keeps window open
- Guard with active capture: existing capture behavior is unchanged

### Phase 5 — Global background activity panel *(TypeScript/Renderer)*

**Files owned:**
- New `v3/renderer/src/features/jobs/BackgroundActivityPanel.tsx`
- `v3/renderer/src/features/startup/useRuntimeStatus.ts` — no structural changes needed; `jobs` is already exported

**Required changes:**
1. Panel showing each non-acknowledged job: type label, stage, progress bar, cancel button (if non-terminal), retry button (if failed and retryable), dismiss button (if terminal)
2. Retry re-issues the same RPC: failed `transcription` → calls `transcription.start` with same recording ID; failed `recap` → calls `ai.recap.start`
3. Panel is visible when `jobs.length > 0`; empty state shows nothing (no persistent panel chrome)
4. `jobs.changed` event already updates the `jobs` array in `useRuntimeStatus`; panel reactively reflects changes

**Optional (defer):**
- Completion notification toasts
- Job count badge on a nav item

### Phase 6 — `.candordict` archive import *(Rust only)*

**Files owned:**
- `crates/candor-core/src/terminology_dictionary.rs` — add `import_candordict(path)` method, `CandordictTrustTier` enum
- `crates/candor-core/Cargo.toml` — add `zip = "2"` and `ed25519-dalek = "2"`
- `crates/candor-core/src/main.rs` — add `terminology.importDictpack` RPC method

**Required changes:**
1. Read and validate ZIP structure; reject archives > 16 MB compressed or with unexpected files
2. Extract and validate `manifest.json` schema
3. Read `entries.jsonl` line by line with the existing per-entry bounds checks
4. Verify signature against embedded Candor key constant (fail closed if `candor-official` trust claimed but signature is bad)
5. Set `requires_approval: true` on all entries from `community-unverified` packs
6. Import via existing `TerminologyService::import_entries_bounded()` — same bounds apply

**Tests to add:**
- Valid `candor-official` archive with correct signature: imports, entries not flagged
- `candor-official` archive with corrupted signature: rejected with `CANDORDICT_SIGNATURE_INVALID`
- `community-unverified` archive: imports; all entries have `requiresApproval = true`
- Archive exceeding size limit: rejected before extraction
- Archive with extra files: rejected
- Entries in pack that exceed `MAX_ENTRIES_PER_DICTIONARY`: rejected

---

## Required vs optional summary

| Item | Required | Rationale |
|---|---|---|
| Persistent descriptors (Phase 1) | **Required** | Handoff requires restart recovery; without it, a crash discards the pipeline |
| Recording priority gate (Phase 2) | **Required** | Non-negotiable constraint: recording must outrank inference |
| Auto-chain on capture stop (Phase 3) | **Required** | Handoff: durable-finalization-to-transcription-to-recap |
| Active-jobs close guard (Phase 4) | **Required** | Handoff: explicit close behavior; prevents silent job abandonment |
| Background activity panel (Phase 5) | **Required (minimal)** | Users cannot observe or act on background work without it |
| `.candordict` with trust tiers (Phase 6) | **Required** | Handoff: signed data-only packages with safeguards |
| Pharmaceutical safeguard replacement | **Required** | See Q5: blanket `requiresApproval` for community packs is the correct implementation |
| Completion notification toasts | Optional | Deferrable; not needed for safety or the handoff contract |
| Retry UX beyond re-issuing same RPC | Optional | Sufficient to call the same start method with the same params |
| LLM selection | **Blocked externally** | Do not unblock without redistribution review and benchmark evidence |
| `releaseReady: true` in manifest | **Blocked externally** | Do not set without real model assets, CI hash verification, and offline receipts |

---

## Assumptions and unresolved questions

**Assumptions made:**
1. The `zip` crate is acceptable as a new dependency. If it is not, `.candordict` can use a flat tar.gz instead with the same security properties.
2. `ed25519-dalek 2.x` is acceptable. It has no `unsafe` code paths in signature verification and is widely used.
3. The `recording_id` is available in `capture_manager.stop()` response; `main.rs` reads it to construct the auto-chained descriptor.
4. The renderer currently calls `transcription.start` manually after observing a completed capture. Phase 3 changes this contract. The `autoProcessingQueued: true` field on `capture.stop` response is how the renderer learns to skip that call. This is a breaking API change within the same binary, so it requires updating the renderer simultaneously.

**Unresolved questions:**
1. Does the `settings_root_for_core()` path have write access on all target platforms? (It must, since terminology store writes there already — but this should be verified before adding the jobs log.)
2. Should `chain` descriptors be user-cancellable independently? (For example, cancel only the recap, not the transcription.) Current design: the chain is an internal implementation detail; the user sees two separate jobs once both are queued.
3. What is the exact format for the Candor-official `.candordict` signing key? The binary constant needs to be established before Phase 6 can produce signed test fixtures. A test-only keypair should be used for the Rust tests; the production key is an external artifact.
4. Is `AiJobQuality` the right parameter for the auto-queued recap? The handoff specifies Fast tier for auto-recap and Best only on explicit user request. This is already the default value (`#[default] Fast`) in `AiJobQuality`, so the chain would set `quality: AiJobQuality::Fast` without further decision.

---

## Likely failure modes and data-safety risks

| Risk | Severity | Mitigation |
|---|---|---|
| JSONL corruption if process killed mid-line | High | Write to `.tmp`, rename atomically. Skip non-parseable lines on load with a log message. |
| Transcription job re-runs on restart but transcript already exists | Medium | In `TranscriptionService::run_local_cancellable`, detect existing transcript and return success without re-running Whisper. This is a read of the recording manifest, not an inference call. |
| Double-recap if chain fires and user also manually triggers recap | Low | Recap writes a processing fact via `record_processing_fact`. A second recap run overwrites the fact harmlessly. No duplicate storage. |
| `.candordict` archive bomb (high compression ratio) | High | Check uncompressed size limit before extracting each entry. Use `zip::ZipFile::size()` (compressed) and `zip::ZipFile::manip_size()` (decompressed) before writing bytes. |
| Recording-priority flag left set after capture fails to stop cleanly | High | In `capture_manager.stop()`, if finalization returns `Err`, still call `set_recording_active(false)`. Capture finalization failure does not mean capture is still active. |
| Inference gate poisoned by a panicking thread | Existing risk | Already handled: `unwrap_or_else(std::sync::PoisonError::into_inner)`. No new exposure. |
| Chain job submitted but `recording_active` gets re-set by a second capture starting instantly | Low | The `submit_descriptor` for the chain happens before `capture.stop` returns to the renderer. A second capture cannot start before the renderer has received the stop response and re-navigated. No race in practice. |
| Close dialog "Cancel tasks and quit" 5-second timeout leaves a job stuck in Running | Medium | Jobs that ignore cancellation flags (e.g., a sync filesystem write in `export`) cannot be interrupted. Accept this: the user chose to quit. The job thread will terminate when the process exits. No data corruption because durable writes already completed. |

---

## Suggested commit sequence

```
1. test(job-manager): add failing restart-recovery test (descriptor JSONL, chain, priority)
   — establishes the contract before implementation; all assertions fail

2. feat(job-manager): add TaskDescriptor, ServiceBundle, and file-backed pending log
   — Phase 1 core: submit_descriptor, recover_pending, compact

3. feat(job-manager): add recording-active priority gate
   — Phase 2: AtomicBool flag, set_recording_active, inference gate pre-check

4. feat(capture): auto-queue transcription and recap on stop
   — Phase 3: capture.stop enqueues chained descriptors, autoProcessingQueued response field

5. feat(close-guard): extend to active-jobs with wait/cancel/quit dialog
   — Phase 4: Electron layer, three-option dialog, cancelAllJobs with timeout

6. test(job-manager): fill remaining Phase 1-4 coverage (all tests now pass)

7. feat(terminology): add .candordict archive import with Ed25519 trust tiers
   — Phase 6: zip extraction, signature verification, community-unverified safeguard

8. feat(renderer): add Background Activity panel with retry and dismiss
   — Phase 5: React component, wires to existing jobs array in useRuntimeStatus
```

Each commit must leave `npm test`, `cargo test`, `typecheck-renderer`, and all existing checks passing before it is merged.

---

## Handoff requirements that should not be implemented literally

**1. "Exactly one selected local LLM"**
The handoff implies the LLM should be selected. `model-lock.json` correctly shows `selectionStatus: "blocked-conversion-quality-and-redistribution-review"` with `selectedModel: null`. Do not change this. The renderer should display a clear explanation that LLM features require an update rather than treating `selectedModel: null` as an error state. Declaring a selection before redistribution review is complete would be a false claim of readiness.

**2. "Pharmaceutical safeguards via term list"**
Do not implement a pharmaceutical term database as a code artifact. The maintenance, review, and versioning obligations are too high and the false-positive/negative risks are real. The safer alternative — `community-unverified` packs require approval on all entries — is already described in Q5 and provides the same user-protection outcome without the obligation.

**3. "Full large-v3 only in an optional signed Maximum Accuracy pack"**
The `complete-max` package profile in `model-lock.json` already captures this. The word "signed" in the handoff refers to a signed installer or distribution package — this is a release-engineering artifact, not a repository code change. No signing infrastructure should be added to the repository without the certificates, build pipeline, and notarization tooling to back it up. The code should treat the `complete-max` profile as a known gated tier and expose it in `bundledAiStatus` appropriately. The actual signed package is an external release blocker.
