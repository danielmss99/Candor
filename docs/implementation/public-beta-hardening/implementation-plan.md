# Accepted Implementation Plan

## Scope

Implement the approved source-level hardening while preserving the current dirty redesign. External signing credentials, clean-machine evidence, physical audio certification, and publication remain fail-closed release gates.

## Accepted Claude Findings

- Resolve a verified local-AI binding at execution time and return a typed failure instead of the `managed-local-model` sentinel.
- Treat **Ask first** as `RequireLocalLlm` plus an explicit user action after failure. Do not block a core worker waiting for renderer input.
- Keep persisted `AiFallbackPolicy` wire values unchanged. Add a separate preference type so the job-store schema does not need migration.
- Verify pinned llama.cpp supports `--no-conversation` and exact JSON schemas. The local b9637 binary advertises both options.
- Put failed tasks first, aggregate terminal announcements, and align UI/core cancellable states.
- Keep public packaging fail-closed when Azure signing configuration or external evidence is unavailable.

## Reconciled Decisions

- `AiFallbackPreference` is `ask-first | automatic | never`, stored in a core-owned atomic settings file. The existing persisted job descriptor still stores only `allow-disclosed | require-local-llm`.
- Default jobs derive their internal policy from the preference. Strict retry and explicit heuristic work use high-level intents rather than renderer-selected execution flags.
- `ask-first` and `never` both require the local LLM. The renderer offers **Create quick fallback** only for `ask-first`; `never` does not permit explicit heuristic work.
- Exact local-LLM provenance includes model ID, model SHA-256, and runtime SHA-256. Heuristic provenance keeps `modelId`, `modelSha256`, and `runtimeSha256` null.
- The llama.cpp CLI receives a versioned exact JSON schema plus `--no-conversation`; Rust validation remains authoritative after generation.
- Failed and nonterminal tasks are never clipped. Only recent terminal history is capped.
- Azure Trusted Signing uses a separate release configuration with `forceCodeSigning: true`, `azureSignOptions`, and `.exe` signing coverage. Source-interface builds remain unsigned and clearly non-release.

## Deferred External Gates

- Azure account, certificate profile, and CI credentials.
- Signed and timestamped release candidate.
- Clean installation and upgrade evidence.
- Physical microphone, system-audio, duration, sleep/resume, and device-switch matrix.
- Real Whisper and Qwen quality certification on the declared hardware tiers.
- Public artifact hosting and publication.

No receipt is created until the corresponding real gate runs successfully.
