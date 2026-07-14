# Claude Plan Request: SPEC-4 Whisper and Local LLM

Act as an independent senior reviewer. Do not agree by default. Refine a safe, incremental implementation plan for Candor SPEC-4 and identify any requirement that cannot be honestly completed from the current inputs.

## Objective

Extend Candor's verified bundled-AI boundary into a user-facing local transcription and meeting-intelligence system:

- Fast maps to Whisper `small.en` or `small`.
- Balanced maps to `large-v3-turbo` and is the preferred default when hardware permits.
- Maximum accuracy maps to `large-v3` and must be guarded.
- The local language model target is Qwen3-4B-Instruct-2507 Q4_K_M through a pinned llama.cpp executable.
- Users see product tiers, not raw model filenames.
- All inference stays local and evidence-grounded.

## Current repository evidence

Base commit: `f9d797047e322161c605017c66ef164162646b75`

Relevant files:

- `build/ai-bundle/manifest.json`
- `third_party/model-lock.json`
- `third_party/runtime-lock.json`
- `scripts/spec3-verify-ai-bundle.mjs`
- `crates/candor-core/src/bundled_ai_assets.rs`
- `crates/candor-core/src/model_manager.rs`
- `crates/candor-core/src/transcription_service.rs`
- `crates/candor-core/src/local_instruct_model.rs`
- `crates/candor-core/src/local_model_scheduler.rs`
- `crates/candor-core/src/job_manager.rs`
- `crates/candor-core/src/main.rs`
- `electron/core/operation-registry.ts`
- `electron/security/validate-core-input.ts`
- `electron/preload.cts`
- `v3/renderer/src/features/local-ai/useLocalAiWorkspace.ts`
- `v3/renderer/src/features/settings/SettingsView.tsx`

The baseline passes `npm run v3:verify`, 99 Rust tests, and 137 renderer tests. Existing code already provides trusted Whisper digests, bundled package resolution, manual override integrity checks, a no-shell llama.cpp process boundary, single-model scheduling, job cancellation, and transcript citations.

## Handoff facts

The supplied archive contains specifications only. Its model lock uses `REPLACE` placeholders. It contains no model weights, runtime executables, licenses, signatures, benchmark results, or signing credentials.

## Proposed source-controlled scope

1. Add a persistent core-owned transcription-quality policy with `fast`, `balanced`, and `maximum` only.
2. Add a local hardware capability snapshot, deterministic recommendation, guard reasons, and benchmark result schema. Do not invent measured throughput.
3. Resolve a transcription request through the persisted tier and bundled language variant unless an explicit advanced override is used.
4. Add a bounded terminology dictionary store with validation, assignment, relevant-term selection, correction proposals, and approval history.
5. Add high-risk term safeguards for drug names, dosages, concentrations, owners, and dates.
6. Strengthen recap and Ask output validation so supported claims require transcript source IDs.
7. Add typed Electron operations and a normal Settings UI for quality selection, recommendation, readiness, and estimates. Keep raw names and hashes in Advanced Diagnostics.
8. Extend the bundle manifest, model/runtime locks, SBOM, package variants, and verifier without claiming release readiness while assets are absent.
9. Add synthetic pharmaceutical fixtures and mutation tests for unsafe correction and unsupported structured output.

## Non-negotiable constraints

- No cloud AI, HTTP listener, shell, arbitrary executable, unrestricted path, or generic IPC.
- No user content, prompts, answers, dictionary terms, names, or full paths in logs.
- No model picker before recording.
- No unsupported owner, date, dosage, drug, or conclusion inference.
- No fabricated performance, hardware, signing, licensing, or clean-install claims.
- Existing recording, recovery, migration, security, and packaging behavior must remain intact.
- Large assets must not be committed to Git without a reviewed distribution design.
- Strict release mode must fail closed until selected assets, notices, provenance, and evidence are complete.

## Questions to resolve

1. What is the smallest safe architecture for persistent quality policy and benchmark evidence without expanding `main.rs` further?
2. Which benchmark decisions can be deterministic capability guards now, and which must remain pending until measured on real hardware?
3. How should English and multilingual Fast mappings work without silently changing a user's language?
4. What correction rules are safe for pharmaceutical terminology, numbers, concentrations, and dosage units?
5. Is the current Markdown citation post-processor sufficient, or should SPEC-4 introduce a strict internal JSON result schema first?
6. How should the package represent Complete and Complete Max while model binaries are absent from this handoff?
7. Which acceptance criteria must remain blocked after source implementation?

## Required response

Provide:

1. A refined phase-by-phase implementation plan.
2. Required changes versus optional improvements.
3. Assumptions and unresolved questions.
4. Likely failure modes, security concerns, and data-loss risks.
5. Focused tests and acceptance checks.
6. Any proposed scope reduction or sequencing correction, with reasons.

Do not edit the repository. Do not claim that missing models, licenses, signatures, hardware tests, or clean-install evidence exist.
