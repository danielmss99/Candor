# Claude implementation review request

## Role

Review the Candor Windows public beta hardening changes adversarially. Do not edit files. Prioritize correctness, security, privacy, regressions, missing tests, and deviations from the accepted plan. Every finding must include severity, file and line, evidence, and a concrete fix. Distinguish observed defects from optional improvements.

Use source-only inspection. Do not scan `build/`, `dist/`, `release-v3/`, `target/`, `node_modules/`, model weights, archives, or generated proof directories. Do not run builds or tests. Limit repository reads to the files below and their directly imported hardening helpers. Return the review once these specific questions are answered.

## Workspace caution

The worktree already contained unrelated user-owned visual redesign and live-capture changes. Review only the hardening files and related contract fixtures listed below. Do not recommend reverting unrelated changes.

## Accepted behavior

1. Local LLM results require an exact bundled model ID, model SHA-256, and runtime SHA-256. Heuristic results use null model identity fields.
2. The default fallback preference is Ask First. Automatic and Never are persistent alternatives. Cancellation, shutdown, and recording-priority preemption never trigger fallback.
3. Strict Retry with Local AI preserves the previous result on failure.
4. Background-task failures appear before active work, simultaneous terminal changes are aggregated for accessibility, and Cancel All targets only queued, running, and paused tasks.
5. Whisper provenance distinguishes OpenAI as upstream publisher from the pinned canonical whisper.cpp distribution artifact.
6. Public release packaging uses fail-closed Azure Trusted Signing configuration, signs application and sidecar executables, and never stores credentials.
7. Qwen execution uses the pinned llama-completion frontend, strict per-operation JSON schemas, thinking disabled, bounded output, source IDs, and private prompt-file transport. Legacy llama-cli must not report ready.
8. External signing, clean-machine, hardware, duration, sleep/resume, device-switching, and publication receipts remain incomplete until real evidence exists.

## Primary implementation files

- `crates/candor-core/src/ai_fallback_preference.rs`
- `crates/candor-core/src/background_jobs.rs`
- `crates/candor-core/src/bundled_ai_assets.rs`
- `crates/candor-core/src/job_manager.rs`
- `crates/candor-core/src/local_instruct_assets.rs`
- `crates/candor-core/src/local_instruct_model.rs`
- `crates/candor-core/src/main.rs`
- `electron/core/background-task.ts`
- `electron/core/operation-registry.ts`
- `electron/core/runtime-schema.ts`
- `electron/diagnostics/diagnostic-report.ts`
- `electron/preload.cts`
- `electron/security/validate-core-input.ts`
- `electron/security/validate-private-core-input.ts`
- `v3/renderer/src/core/contracts.ts`
- `v3/renderer/src/core/jobs.ts`
- `v3/renderer/src/features/jobs/BackgroundActivity.tsx`
- `v3/renderer/src/features/local-ai/useLocalAiWorkspace.ts`
- `v3/renderer/src/features/settings/SettingsView.tsx`
- `third_party/model-lock.json`
- `third_party/runtime-lock.json`
- `scripts/install-development-ai-bundle.mjs`
- `scripts/spec3-verify-ai-bundle.mjs`
- `scripts/windows-release-signing-config.cjs`
- `scripts/spec6-release-signing-config.mjs`
- `electron-builder.release.cjs`
- `package.json`

## Evidence already obtained

- Focused Rust local-instruct tests: 17 passed.
- Real packaged Qwen recap and Ask proof: passed in 48.6 seconds using the pinned Q4_K_M model and llama-completion runtime.
- Earlier implementation checks before the final runtime guard: 188 default Rust tests, 207 all-feature Rust tests, 174 Vitest tests, renderer type checking, Electron main build, and strict Clippy all passed.
- AI-bundle verifier self-test and non-strict source-interface verification passed.
- Release signing configuration self-test passed; loading release config without signing environment failed closed and named variables only.

The full suite will be rerun after this focused review.

## Questions

1. Can any LLM-ready or provenance path still use a sentinel, stale, or renderer-supplied model identity?
2. Can Ask First accidentally fall back without an explicit user action, or can strict retry overwrite a previous result?
3. Are runtime output schemas, source grounding, cancellation, prompt transport, and frontend selection fail-closed?
4. Do background task ordering, announcements, and cancellation match their typed states?
5. Can public packaging succeed unsigned, omit sidecar signing, or leak signing configuration secrets?
6. Do model-lock and verifier rules accurately describe Whisper provenance?
7. Which critical or high-severity issues must be fixed before the full verification run?
