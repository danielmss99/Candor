# Claude review request: SPEC-6 AI and background-task boundary

Review the current worktree on `codex/spec6-ai-release-completion` as an independent senior Electron, TypeScript, and Rust reviewer. The base commit is `9eaf4e220731127f7de601abf105bd0eab6342c1`.

Limit this checkpoint to:

- `crates/candor-core/src/background_jobs.rs`
- `crates/candor-core/src/job_manager.rs`
- `crates/candor-core/src/recording_store.rs`
- `electron/core/background-task.ts`
- `electron/core/operation-registry.ts`
- `electron/core/core-client.ts`
- `electron/security/validate-private-core-input.ts`
- `electron/ipc/jobs-ipc.ts`
- `electron/preload.cts`
- `v3/renderer/src/features/local-ai/`
- `v3/renderer/src/features/jobs/`
- `v3/renderer/src/features/detail/MeetingDetailView.tsx`

Validate these invariants:

1. Local LLM is the default for recap and Ask.
2. Heuristic fallback is explicit or follows an allowlisted local-LLM failure.
3. Cancellation, shutdown, and recording-priority preemption never create heuristic output.
4. Strict retry requires the local LLM and preserves the previous result on failure.
5. Provenance is typed, safe, persistent, and visible whenever fallback is used.
6. All background task kinds, states, progress units, ETA rules, terminal semantics, and completed results are validated before renderer state.
7. Renderer-facing tasks cannot expose paths, keys, prompts, transcripts, or unvalidated extension fields.
8. CandorApiV3 exposes no generic command or executable path surface.

Run focused tests if useful. Report findings first, ordered by severity: critical, high, medium, low. For every finding include exact file and line references, impact, evidence, and a concrete fix. Explicitly say when no critical or high findings remain. Do not broaden into release signing, hardware certification, or model-license review in this checkpoint.
