# SPEC-2 accepted implementation plan

## Inputs

- User handoff: `CANDOR_CODEX_POST_CONSOLIDATION_HANDOFF.md`
- Codex repository audit at `1f9b87e`
- Claude plan review: `claude-plan-review.md`

## Accepted sequence

1. Record the reproducible baseline and main-architecture state.
2. Add shared protocol fixtures and a small schema runtime.
3. Add one operation registry covering every renderer and private core operation.
4. Split transport-only `rawCall()` from handshake-gated, schema-validating `call()`.
5. Define durable Rust-owned jobs, then convert transcription, recap, Ask, imports, and exports.
6. Define degraded capture state and recovery metadata behavior.
7. Add deterministic test-core modes and integration coverage for a hung capture core.
8. Atomically replace preload v1 with the domain-oriented preload v2 surface and migrate all renderer callers in the same commit.
9. Remove implementation vocabulary from normal workflows and regroup Advanced Settings.
10. Add critical-state screenshot automation, stable identity checks, and remote-main architecture verification.
11. Add SBOM and release-evidence automation, then run all locally provable gates.
12. Ask Claude for an adversarial implementation review, apply validated findings, and rerun verification.

## Claude recommendations accepted

- Fixtures and validation contracts precede transport refactoring.
- Handshake state is scoped to one core process and reset on exit or restart.
- Renderer-reload job recovery is owned by the Rust core, not React state.
- Cancellation reaches a terminal state and never deletes source data.
- Signing, clean-machine upgrade, hardware, privacy traffic, and long-duration claims remain explicitly blocked without real evidence.
- Windows and POSIX path redaction receive direct tests.

## Claude recommendations adjusted or rejected

- A dual preload surface is rejected. Claude correctly identified the security risk of exposing v1 and v2 together, then suggested a temporary `window.candorV2` overlap. Candor will instead migrate the preload, declarations, IPC handlers, and renderer atomically so only one surface ships at each commit.
- The degraded capture contract is defined before its deterministic hang harness. The harness can then encode the intended behavior instead of becoming the accidental specification.
- Screenshot automation is required by the user handoff. It is treated as a regression and evidence gate, even though visual tests can be operationally flaky.
- The transport is stdio JSONL, not a socket. Core crash, renderer reload, and process restart remain separate lifecycle cases.

## Stop conditions

- Stop before any persisted schema or app-ID change that lacks migration and rollback evidence.
- Stop before claiming signed, clean-machine, upgrade, hardware, privacy-network, or long-duration completion without external artifacts.
- Stop if runtime validation would require weakening the sandbox or exposing a generic operation bridge.
- Stop if cancellation or recovery behavior can delete or lock an existing recording.
