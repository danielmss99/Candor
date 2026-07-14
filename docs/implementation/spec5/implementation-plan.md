# SPEC-5 accepted implementation plan

Date: 2026-07-14

## Governing objective

Advance Candor toward a genuinely release-ready, local-only desktop application while preserving capture safety, encrypted local data, typed process boundaries, and fail-closed release claims.

## Claude review disposition

Claude's authenticated review is recorded in `claude-plan-review.md`. The central recommendation to replace restartable closures with serializable Rust job descriptors is accepted.

The following recommendations are modified:

1. **Plain JSONL job descriptors are rejected.** Ask descriptors contain user questions and completed results may contain meeting content. Persisted job state will use an encrypted, atomic local snapshot derived from the OS-backed Candor key.
2. **Allowing active inference to finish after capture starts is rejected.** Descriptor-backed Whisper and LLM work will receive cooperative preemption, enter `cancelling`, settle as `paused`, and restart after recording priority ends. Non-restartable inference such as a benchmark may be cancelled and retried manually.
3. **Auto-applying corrections from signed dictionaries is rejected.** Signature validity establishes package integrity and publisher trust, not transcription certainty. All correction proposals remain reviewable, original text remains preserved, and medical or numeric mutations always require approval.
4. **The alternate archive layout is rejected.** `.candordict` follows the handoff: `manifest.json`, `terms.jsonl`, `LICENSE.txt`, and `signature.json` only.
5. **Only persisting three job types is too narrow.** The persistent descriptor contract will cover transcription, recap, Ask, export, dictionary import, and dictionary index. Existing maintenance jobs may remain non-restartable but must settle safely on shutdown.

## Phase 1: persistent and prioritized Rust jobs

- Add serializable descriptors for user-visible background job types.
- Add encrypted atomic job storage with corruption and interrupted-write tests.
- Add first-class queued, running, paused, cancelling, completed, failed, and cancelled states.
- Persist progress, retry count, safe stage, result/error, recording ID, and follow-up state.
- Recover interrupted descriptor jobs after core restart.
- Add retry, pause-all, cancel-all, and active-summary operations.
- Cooperatively preempt restartable inference when capture begins and resume it after capture ends.

## Phase 2: durable capture pipeline

- Set recording priority before any capture backend starts; release it on every failed start.
- After a successful durable stop, release recording priority and queue transcription.
- Queue a fast local recap only after transcription completes successfully.
- Never fail or delay the durable stop response because background work could not be queued.
- Return safe processing status fields with the stop result.

## Phase 3: background activity and close behavior

- Add typed renderer job contracts and app-level retry/cancel/acknowledge operations.
- Add a compact global `N jobs running` control and Background Activity panel.
- Show stage, progress, estimated time when measurable, cancel, retry, open meeting, and dismiss actions.
- Announce completion and failure without exposing meeting content.
- On close, protect capture first, then offer: keep Candor open, pause and close, or cancel jobs and close.
- Do not introduce silent tray behavior. Background tray processing remains opt-in future work.

## Phase 4: `.candordict` packages

- Add bounded ZIP parsing in the Rust core with exactly four root files.
- Reject traversal, nested paths, symlinks, encrypted entries, duplicate names, extra files, oversized compressed/uncompressed content, excessive ratios, malformed JSONL, and count limits.
- Verify the terms digest and Ed25519 signature using a domain-separated payload.
- Label known Candor keys, locally trusted organization keys, and unknown valid signers distinctly.
- Keep all corrections reviewable, with explicit high-risk handling for drug names, dosages, concentrations, units, numeric mutations, and medical conclusions.
- Add a small built-in general meeting dictionary whose integrity is tied to the packaged application; public signed pack distribution remains blocked until the production publisher key and installer signing exist.

## Phase 5: packaging and release controls

- Add unambiguous `package:standard`, `release:standard`, `package:maximum-pack`, and `release:maximum-pack` commands.
- Preserve `Candor Source Interface` identity for incomplete developer packages.
- Keep strict Standard and Maximum commands fail-closed while real model assets and legal evidence are absent.
- Record acceptance status without setting `releaseReady: true`.

## Verification

- Rust unit and RPC tests for persistence, restart, chaining, priority, retry, shutdown, encryption, archive safety, signatures, and correction provenance.
- Vitest tests for typed jobs, activity UI, notifications, and close decisions.
- Renderer typecheck and Electron integration checks.
- AI bundle verifier, architecture, source-security, and package-command audits.
- Claude implementation review after verification, followed by fixes and a focused rereview when findings are material.

## External blockers that remain explicit

- Actual Turbo, Small, and selected Qwen model files in the installer.
- Final LLM conversion provenance and redistribution approval.
- Production dictionary publisher key and public website library.
- 8/16/32 GB and acceleration benchmarks.
- Physical mic, system-audio, long-duration, sleep/resume, and device-switch evidence.
- Signed and timestamped installers plus clean-machine offline and upgrade receipts.
