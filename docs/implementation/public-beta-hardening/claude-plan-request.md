# Candor Windows Public Beta Hardening: Claude Architecture Review

## Objective

Review the approved hardening plan before Codex implements it. Candor is an Electron renderer and main process connected over versioned JSONL stdio to a Rust core. The current branch is `codex/quiet-workspace-redesign` at SPEC-6 commit `037f2d3`, with unrelated uncommitted redesign and live-recording changes that must be preserved.

## Required Changes

1. Remove the `managed-local-model` provenance fallback. Local LLM work must resolve an exact verified model ID, model SHA-256, and runtime SHA-256 from `BundledLanguageConfig`; missing identity must fail without heuristic fallback.
2. Change the product fallback preference to `ask-first | automatic | never`, default `ask-first`, stored by the Rust core. Cancellation, shutdown, and recording preemption must never fallback. Strict retry preserves the previous result.
3. Harden pinned llama.cpp output by adding `--no-conversation`, retaining reasoning-off flags, replacing the permissive `{}` schema with an exact versioned JSON schema, and keeping Rust post-validation.
4. In `BackgroundActivity.tsx`, show every failed task before active and recent work, aggregate simultaneous terminal announcements, and expose Cancel All only for `queued | running | paused` tasks.
5. Make Rust `cancel_all()` use the same cancellable states and return requested/skipped counts. Electron must validate that result.
6. Rename Whisper provenance from `official-source-pinned` to `canonical-whisper-cpp-artifact-pinned` and distinguish OpenAI upstream publishing from the pinned whisper.cpp distribution revision.
7. Add fail-closed Azure Trusted Signing configuration and release-evidence binding without fabricating credentials or receipts. External signing, clean-machine, physical capture, and publication remain incomplete until real evidence exists.

## Relevant Files

- `crates/candor-core/src/background_jobs.rs`
- `crates/candor-core/src/bundled_ai_assets.rs`
- `crates/candor-core/src/job_manager.rs`
- `crates/candor-core/src/local_instruct_model.rs`
- `crates/candor-core/src/main.rs`
- `v3/renderer/src/features/jobs/BackgroundActivity.tsx`
- `v3/renderer/src/features/local-ai/useLocalAiWorkspace.ts`
- `v3/renderer/src/features/settings/SettingsView.tsx`
- `electron/core/operation-registry.ts`
- `third_party/model-lock.json`
- `scripts/spec3-verify-ai-bundle.mjs`
- `electron-builder.v3.yml`

## Current Evidence

- The real Whisper Small proof passes.
- Turbo loads but exceeded a prior CPU proof timeout on this 16 GB development machine, so hardware-aware tier guards remain mandatory.
- The pinned Qwen and llama.cpp runtime load, but the real proof currently fails because the model does not return the required JSON object.
- The current source-interface installer and executables are unsigned, and no signing certificate is present locally.
- Qwen alone exceeds GitHub's 2 GiB release-asset limit, so distribution remains an external infrastructure decision.

## Review Request

Provide an adversarial architecture review with:

1. Required corrections versus optional improvements.
2. Migration and compatibility risks.
3. Security and privacy failure modes.
4. Exact tests and acceptance checks.
5. Findings labeled Critical, High, Medium, or Low with concrete file targets.

Do not edit the repository. Do not assume missing signing credentials, hardware evidence, or release receipts exist.
