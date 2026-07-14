# Claude plan review request: SPEC-5

Act as an independent senior reviewer. Do not edit the repository. Produce a refined implementation plan that distinguishes repository-controlled work from external release evidence.

## Objective

Implement the repository-controlled requirements in `SPEC-5-Candor-Background-AI-and-Dictionary-Ecosystem` while preserving Candor's local-only Electron, typed preload, JSONL, and Rust security boundaries. The larger goal is a genuinely release-ready Candor desktop application, not a paper claim of completion.

## Base and baseline

- Repository: `C:\Claude_Config\candor`
- Branch: `codex/background-ai-and-dictionaries`
- Base: `223d1d6ef660c76a045acc56936a3b3ef0d15fb6`
- Baseline: 147 Vitest tests, 132 Rust tests, renderer typecheck, AI bundle verifier self-test, architecture check, and identity check all pass.
- Detailed baseline: `docs/implementation/spec5/baseline.md`

## Handoff requirements

The handoff freezes Standard as:

- `large-v3-turbo` for Balanced
- `small` or `small.en` for Fast
- exactly one selected local LLM
- one small general dictionary
- full `large-v3` only in an optional signed Maximum Accuracy pack

It also requires persistent Rust-owned jobs, durable-finalization-to-transcription-to-recap chaining, recording-priority scheduling, global activity UI, explicit close behavior, and signed data-only `.candordict` packages with pharmaceutical safeguards.

## Current evidence

1. `crates/candor-core/src/job_manager.rs`
   - In-memory `HashMap` only.
   - States are queued, running, completed, failed, cancelled.
   - Cancellation and progress work.
   - One `inference_gate` serializes inference.
   - No restart persistence, pause, retry, dependency chaining, recording-priority preemption, or safe checkpoints.
2. `crates/candor-core/src/main.rs`
   - `transcription.start` and `ai.recap.start` submit closures independently.
   - `capture.stop` finalizes durably but does not enqueue downstream work.
3. `crates/candor-core/src/terminology_dictionary.rs`
   - Encrypted local store with bounded CSV, JSON, and TXT imports.
   - Automatic bounded Whisper context and LLM glossary context.
   - Correction proposals require approval and preserve decisions.
   - No `.candordict` archive or Ed25519 signature verification.
4. `v3/renderer/src/core/jobs.ts` and `useRuntimeStatus.ts`
   - Events and polling support individual jobs.
   - No global activity panel or retry UX.
5. `electron/window/capture-close-guard.ts`
   - Protects active capture only.
   - No active-job close decision.
6. `third_party/model-lock.json`
   - Correct Whisper candidate matrix and package profiles already exist.
   - LLM selection remains blocked pending real evidence.
7. `build/ai-bundle/manifest.json`
   - Source-interface only, empty assets, `releaseReady: false`.

## Non-negotiable constraints

- Do not claim that real models are bundled or selected without the files, hashes, licenses, redistribution review, benchmarks, and offline receipts.
- Do not weaken the renderer sandbox, preload allowlist, runtime schemas, path controls, or no-local-HTTP policy.
- Never log transcript, prompt, dictionary terms, notes, participant names, model output, keys, or complete sensitive paths.
- Never block or delay durable capture finalization on AI.
- Recording, finalization, and recovery must outrank inference.
- Do not silently cancel jobs or silently correct uncertain pharmaceutical terms.
- Keep all user data accessible when AI fails.
- Keep each commit buildable and testable.

## Planning questions

1. What is the smallest safe architecture for persisted job metadata and restart recovery in this file-backed local application?
2. How should task descriptors replace non-serializable closures without widening the Electron trust boundary?
3. How should recording priority pause or checkpoint inference safely when the current inference runtimes expose cancellation flags but not arbitrary suspension?
4. Where should transcription and recap dependency chaining live so it is independent of the renderer?
5. What is a safe, bounded `.candordict` container and signature policy, including trust labels for Candor, organization, and unverified community packs?
6. What close behavior can be implemented without introducing silent tray persistence?
7. Which repository-controlled acceptance checks are required now, and which items must remain external release blockers?

## Required response

Provide:

1. A phase-ordered implementation plan with exact files and ownership boundaries.
2. Required changes versus optional improvements.
3. Assumptions and unresolved questions.
4. Likely failure modes and data-safety risks.
5. Tests and acceptance checks, including restart, failure, path, archive, signature, cancellation, and recording-priority cases.
6. A suggested commit sequence.
7. Any handoff requirement that should not be implemented literally, with a safer alternative and rationale.
