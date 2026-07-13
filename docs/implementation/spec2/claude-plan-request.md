# Candor SPEC-2 plan review request

## Objective

Review and refine the implementation plan for `SPEC-2-Candor-Post-Consolidation-Hardening` on branch `codex/post-consolidation-hardening`.

Candor is a local-first Electron, React, TypeScript, and Rust desktop meeting recorder. The trusted path is:

```text
React renderer -> sandboxed preload -> Electron main -> versioned JSONL RPC -> Rust core
```

Codex remains responsible for all repository edits and verification. Treat this request as an independent architecture and sequencing review. Do not edit files.

## Current repository evidence

- Baseline commit and `origin/main`: `1f9b87e19dc930faa5259e62ab9e4d6e7e23de1e`.
- `electron/main.ts` is already modular and below 250 lines.
- `v3/renderer/src/app/CandorApp.tsx` is already a small composition root.
- `electron/core/core-client.ts` has a shared `handshakePromise`, but its public `call()` sends ordinary requests directly. Callers can bypass `ensureHandshake()`.
- `electron/core/protocol.ts` validates the RPC envelope and handshake, but operation-specific parameter and result schemas do not exist.
- `electron/preload.cts` exposes a large low-level `core` API with names such as `vaultStatus`, `aiAskHeuristic`, `aiInstructStatus`, `aiSchedulerStatus`, and `transcriptionRunLocal`.
- `v3/renderer/src/candor-api.d.ts` mirrors that low-level API and returns generic `JsonValue`.
- Transcription, recap, Ask, model import, v2 import, and export are currently invoked as synchronous requests.
- Existing capture close guards and recovery behavior must not regress.
- Existing renderer sandboxing, blocked navigation, no generic IPC, local data access, and license-independent open/export/delete behavior are non-negotiable.
- Current package identity is inconsistent: package version is `2.0.0` while the description says Candor v3. User-facing generation labels must be removed without casually changing persisted data paths.
- Real signing, clean-machine upgrade, and hardware validation require external evidence and must never be marked complete from simulated tests.

## Required implementation phases

1. Baseline and reproducible gap ledger.
2. One authoritative operation registry with runtime parameter and result validation, operation timeout, handshake requirement, and request/job mode.
3. Shared valid and invalid protocol fixtures consumed by TypeScript and Rust tests.
4. Transport-only `rawCall()` plus handshake-gated `call()` for every ordinary operation.
5. Durable asynchronous jobs for transcription, recap, Ask, model and audio import, and export, including progress, cancellation, terminal results, and renderer-reload recovery.
6. Explicit `capture-connection-degraded` behavior that preserves last confirmed capture state, Stop, bounded reconnect, and recovery metadata without automatically killing the core.
7. Controllable test-core modes, especially hang during capture.
8. Product-domain preload API v2 with no generic command, filesystem, or process access.
9. Renderer migration away from implementation vocabulary in normal workflows, plus regrouped Advanced Settings.
10. CI screenshot matrix, stable product identity, and `verify-main-architecture.mjs`.
11. Release automation for checksums and SBOM, plus honest ledgers for signing and physical hardware gates.

## Constraints

- Do not weaken `contextIsolation`, sandboxing, navigation restrictions, or sender validation.
- Do not introduce `any` at a trust boundary or use type assertions instead of runtime validation.
- Do not fabricate IDs, states, durations, or successful privacy claims.
- Do not change storage formats or app IDs without migration and rollback evidence.
- Existing recordings must remain openable, exportable, and deletable regardless of licensing or network failures.
- Logs must not contain audio, transcript, notes, prompts, outputs, names, secrets, or complete paths.
- Keep commits small and buildable.

## Requested Claude response

Provide:

1. A refined implementation sequence with dependency ordering.
2. Required changes versus optional improvements.
3. Assumptions and unresolved questions.
4. Likely correctness, security, data-loss, and cross-platform failure modes.
5. Specific tests and acceptance checks for each phase.
6. Advice on how to introduce jobs and preload v2 incrementally without breaking the renderer.
7. A clear list of release claims that must remain blocked pending signing credentials or physical hardware evidence.

Be adversarial. Flag scope that cannot honestly be completed in a local development pass.

Answer only from the evidence in this prompt. Do not inspect the repository, invoke tools, or edit files. Keep the response below 1,500 words.
