# SPEC-6 acceptance status

Date: 2026-07-14

## Code-level acceptance

Status: complete locally, pending hosted pull-request checks.

- Local LLM is the default recap and Ask engine.
- Heuristic fallback is explicit or restricted to allowlisted Local AI failures.
- Cancellation, shutdown, and recording-priority preemption do not create heuristic fallback output.
- Recap and Ask results carry typed, pathless provenance.
- Fallback remains visibly disclosed and strict retry preserves the previous result on failure.
- `CandorApiV3` exposes typed background tasks and no generic command, filesystem, or executable surface.
- Electron validates every task state, kind, progress unit, ETA rule, terminal invariant, error, provenance field, and completed result before renderer state.
- Active workers remain in `cancelling` until they acknowledge cancellation; the UI never reports them terminal early.
- Dictionary packages are staged in Rust-owned ChaCha20-Poly1305 files. Persisted descriptors contain only token, digest, display name, and byte count.
- Schema-v1 Base64 descriptors migrate transactionally with backup, verification, rollback, and staging cleanup.
- Interrupted migration recovery validates and restores the encrypted rollback backup before migration is retried.
- Ask questions, terminal tasks, retryable imports, and orphan staging files have bounded retention.
- Acknowledging terminal dictionary work immediately releases its encrypted staging payload without exposing the staging token outside Rust.
- Cancellation and acknowledgement report success only after required encrypted staging deletion succeeds. Retryable deletion failures remain explicit and pathless.
- Dictionary scope and tie-breaking order is deterministic. Project scope remains reserved.
- Only the exact bundled Candor publisher key can produce `verified-candor`.
- Privacy receipts preserve measured AI provenance, and unknown signed dictionary trust states fail closed to community-unverified.
- Standard and Maximum Accuracy package profiles, acquisition checks, and the offline publication gate are implemented.
- The final publication gate requires the strict V3 signing, installation, upgrade, hardware, duration, benchmark, license, and network evidence audit before applying the GitHub asset-size policy.
- Strict bundle promotion independently checks candidate benchmark, redistribution, provenance, exact byte, digest, license, profile, and runtime-compatibility evidence rather than trusting a release-selection label alone.
- Electron parses every background-task event before renderer delivery, including recording-priority cancellation states that remain nonterminal until the worker acknowledges them.
- Runtime downloads, Ollama, localhost inference, web installers, renderer-selected executables, model weights, and private signing keys remain prohibited.
- Release acquisition is operator-only, resumable, digest-checked, byte-checked, and atomically promoted. Corrupt complete temporary fragments are removed before a clean retry.
- Four Claude checkpoints are recorded. The final review reported zero critical and zero high findings, and all remaining actionable findings were resolved before the final verification pass.

## Expected fail-closed gates

Both strict package profiles fail intentionally because production assets and receipts do not exist in this repository:

- no release-selected Whisper model;
- no release-selected Qwen model with final digest and benchmark approval;
- no packaged and tested llama.cpp runtime;
- no signed general dictionary;
- no production Candor publisher public key;
- no model, runtime, dictionary, licensing, benchmark, signing, or hardware receipt set.

`third_party/model-lock.json` records the official Qwen Q4_K_M candidate at 2,497,280,256 bytes. That single file exceeds GitHub Releases' 2 GiB per-asset limit. Publication therefore remains blocked until a non-GitHub distribution path or a separately approved packaging strategy is selected.

## External release gates

The following remain incomplete and must not be inferred from code-level success:

- Windows Authenticode signing and timestamping;
- clean-machine offline install and legacy upgrade;
- microphone, system-audio, and combined capture certification;
- 5, 30, 60, and 180-minute recording sessions;
- sleep/resume and audio-device switching;
- elevated Windows network-denial proof;
- real Whisper Turbo, Small, and Large-v3 hardware benchmarks;
- real Qwen/llama.cpp recap, Ask, cancellation, memory, and pharmaceutical-quality evaluation;
- production publisher-key custody and dictionary signature ceremony;
- hosted Windows, macOS, and Linux source checks;
- a distribution decision for release assets over GitHub's per-asset limit.

No receipt has been fabricated for any unavailable gate.
