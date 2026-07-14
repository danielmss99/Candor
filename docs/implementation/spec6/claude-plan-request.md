# Claude plan review request: SPEC-6

Act as an independent senior architecture, security, and migration reviewer. Do not edit the repository. Distinguish repository-controlled implementation from unavailable external release evidence.

## Objective

Implement Candor SPEC-6 so automatic recap uses the packaged local LLM by default, heuristic fallback is explicit and disclosed, background tasks are typed end to end, dictionary archives use private encrypted staging, dictionary conflicts resolve deterministically, trust labels are honest, and production bundle gates remain fail-closed.

## Repository and baseline

- Repository: `C:\Claude_Config\candor`
- Branch: `codex/spec6-ai-release-completion`
- Base: `9eaf4e220731127f7de601abf105bd0eab6342c1`
- Baseline: 155 Vitest tests, 150 Rust tests, renderer typecheck, 5 Electron/axe tests, bundle verifier self-test, architecture check, and identity check pass.
- Strict Standard bundle verification fails as intended because production assets and external receipts are absent.
- Detailed baseline: `docs/implementation/spec6/baseline.md`

## Required architecture

1. Replace recap quality ambiguity with `local-llm` and `heuristic-fallback`, plus an explicit fallback policy.
2. Automatic and normal manual recap/Ask use local LLM first. Heuristic fallback is allowed only for a disclosed allowed failure or an explicit user request.
3. Cancellation, shutdown, and recording-priority preemption must never produce heuristic output.
4. Add typed AI provenance and strict Retry with Local AI behavior.
5. Upgrade the preload contract to V3 and validate all background task results/events before renderer state changes.
6. Support queued, running, paused, cancelling, completed, failed, and cancelled accurately. ETA is legal only for running tasks.
7. Replace persisted dictionary Base64 with encrypted Rust-owned staging and migrate old encrypted job stores transactionally.
8. Resolve dictionary conflicts by meeting, project, organization, personal, specialist, general, then explicit preference, context, category, approved history, semantic version, and stable ID.
9. Only a package chained to the bundled Candor publisher public key may display `Verified by Candor`.
10. Standard targets Turbo, multilingual Small, official Qwen3-4B-GGUF Q4_K_M, pinned llama.cpp, a general dictionary, and a public verification key. Real assets remain unselected until evidence passes.

## Security and data constraints

- Preserve renderer sandboxing, exact preload allowlists, JSONL validation, no local HTTP server, and recording priority.
- Never log prompts, transcripts, notes, dictionary terms, participant names, model output, keys, or full sensitive paths.
- Never delete or block existing recordings when AI fails.
- Never persist full dictionary archives or unencrypted Ask questions.
- Never bundle a private publisher key or renderer-selectable executable path.
- Never fabricate licenses, benchmarks, signatures, hardware receipts, or release readiness.

## Questions for review

1. Is the proposed AI mode and fallback policy sufficient to prevent hidden heuristic output and fallback during cancellation or preemption?
2. What exact migration sequence safely stages legacy Base64 descriptors without losing retryable imports?
3. What lifecycle and cleanup rules prevent staged dictionary leaks, orphan growth, and time-of-check/time-of-use replacement?
4. Which fields belong in the typed task and AI provenance contracts, and which must remain private?
5. How should the Candor trust anchor differ from self-signed community packages?
6. Which release asset changes are safe to land while real models, publisher keys, signing, and hardware proof remain unavailable?

## Required response

Provide a phase-ordered plan, required versus optional changes, migration and rollback risks, concrete failure modes, tests and acceptance checks, and an adversarial assessment of any requirement that should be modified for safety. Include file paths where they materially clarify ownership.
