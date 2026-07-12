# Candor v3 Foundation Baseline

## Purpose

Pull request 3 establishes a foundation baseline rather than a normal feature
change. It spans the hardened Electron shell, Rust protocol, durable capture,
encrypted storage, transcription, local AI, renderer, packaging, and proof tools.
That breadth is recorded explicitly so the merge is not represented as a routine
line-by-line feature review.

## Frozen Boundaries

- Electron owns windowing and product interaction.
- The preload exposes a typed allowlist only.
- Rust owns recording, storage, model integrity, transcription, local AI, export,
  privacy receipts, and network capability facts.
- Transport remains newline-delimited JSON-RPC over stdio.
- The renderer does not receive keys, unrestricted paths, process execution, or
  unrestricted networking.
- Product data and inference remain local. Optional licensing and future update
  checks require an explicit user action and a separately reviewed capability.

## Review Slices

The baseline is reviewed and verified in these ownership slices:

1. Electron shell and hardened IPC.
2. Versioned Rust protocol and encrypted storage.
3. Durable capture and crash recovery.
4. Model management and transcription.
5. Local recap and Ask.
6. Renderer workflow and accessibility.
7. Packaging, signing, network denial, and release proofs.

Future work should use one slice per pull request whenever practical. Shared
contract changes must include fixtures or tests on both sides of the boundary.

## Renderer Ownership

`CandorApp.tsx` is the coordinator. Product UI is owned by feature modules under
`v3/renderer/src/features`, including capture, local AI, onboarding, home,
library, live meeting, detail, review, export, privacy, and settings. Typed core
access lives in `core/candor-client.ts`; response schemas live in
`core/contracts.ts`; state transitions and stale-request coordination live under
`state`.

## Merge Gate

The baseline may merge only when:

- renderer tests and strict TypeScript pass;
- Rust tests pass;
- staged milestone verification passes;
- packaged smoke and artifact audit pass on the current platform;
- CI is green on Windows, macOS, and Linux;
- unresolved physical capture, signing, notarization, or clean-machine checks are
  identified as release gates and are not described as complete.

Stop the merge if a renderer can escape the allowlist, a malformed payload can
silently become a reassuring value, a recording failure can commit invalid
metadata, or an unrequested network capability is introduced.
