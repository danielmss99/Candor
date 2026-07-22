# Independent Plan Review Request: Candor Superwhisper Improvements

NOT TRANSMITTED. This prepared plan-review request has not been sent to Claude and is not review evidence.

You are reviewing an implementation plan for Candor, a local-first Electron, React, and Rust desktop meeting workspace. Provide an adversarial, repository-grounded plan review. Do not edit files and do not assume the requested design is correct.

## Objective

Implement the user-approved plan in independently testable phases:

1. Persistent six-step onboarding: License, Microphone, Shortcut, System Audio, Storage, Local AI.
2. Native microphone device selection, live RMS and peak levels, five-second memory-only playback sample, access and disconnect states, and safe preferred-device fallback.
3. Opt-in `CommandOrControl+Shift+Space` global shortcut that restores Candor and opens the recorder without starting capture.
4. Immutable transcript revisions, processing receipts, reprocessing, and encrypted FTS5 search.
5. Meeting profiles, deterministic replacements, model cards, provisional live transcription, safe media import, and a benchmark-gated diarization foundation.
6. Read-only Rust CLI and MCP stdio companions with no network listener or raw path exposure.

## Non-negotiable constraints

- Meeting data remains local and denied network capability.
- No required sign-in or persistent account for normal app use.
- No browser `getUserMedia`; native audio remains in Rust.
- No invisible recording. The initial shortcut opens and focuses the recorder only.
- No tray, background persistence, cloud models, active-window context, clipboard capture, arbitrary paste, mobile sync, or push-to-talk hook.
- Renderer remains sandboxed and receives no Node, generic filesystem, arbitrary command, raw path, or key-material access.
- Existing recordings, transcripts, notes, exports, licensing, recovery, and smoke behavior must remain compatible.
- Microphone probe audio is bounded, memory-only, excluded from logs and diagnostics, and cleared on every exit path.
- Claude is review-only. Codex owns implementation, validation, and finding disposition.

## Proposed architecture

### Setup and microphone

- Refactor `ActivationFlow.tsx` into focused step components.
- Add a main-process desktop preferences service for setup schema version, completed/deferred steps, and last step.
- Add core-owned capture preferences for a preferred microphone fingerprint plus current ordinal ID.
- Add an ephemeral Rust `MicrophoneProbe` next to `CaptureManager`, mutually exclusive with real capture.
- Probe status exposes aggregate RMS, peak, clipping, signal, device and access state. A five-second 16 kHz mono ring buffer can be returned once as bounded WAV data for playback.
- Existing users get a non-blocking setup completion prompt. New users resume at the first incomplete step.

### Shortcut

- Add main-process accelerator validation, atomic settings store, and `globalShortcut` service.
- Add a single-instance application lock.
- Suggested accelerator is disabled until explicit enablement.
- Registration changes use register-new-before-unregister-old and rollback on persistence failure.
- Fixed activation event restores and focuses the main window, then opens the renderer recorder panel without starting capture.

### Meeting intelligence phases

- Add versioned transcript and processing records without overwriting original audio or raw transcript data.
- Add reprocessing as a serializable background job and FTS5 inside the encrypted vault.
- Add versioned meeting profiles and deterministic post-ASR replacement rules with protected-term review.
- Add provisional local transcription from captured chunks, reconciled into a final revision after stop.
- Add bounded, staged media import. Diarization may not ship until a redistributable local model passes licensing, quality, and hardware gates.
- Replace the direct-file MCP sketch with Rust stdio companions using core read APIs and explicit content scopes.

## Relevant repository surfaces

- `electron/main.ts`
- `electron/preload.cts`
- `electron/ipc/register-ipc.ts`
- `electron/core/operation-registry.ts`
- `v3/renderer/src/candor-api.d.ts`
- `v3/renderer/src/features/onboarding/ActivationFlow.tsx`
- `v3/renderer/src/features/onboarding/useOnboardingSettings.ts`
- `v3/renderer/src/features/settings/SettingsView.tsx`
- `v3/renderer/src/features/capture/useCaptureActions.ts`
- `crates/candor-core/src/capture_service.rs`
- `crates/candor-core/src/recording_store.rs`
- `crates/candor-core/src/job_manager.rs`
- `crates/candor-core/src/transcription_service.rs`
- `crates/candor-core/src/terminology_dictionary.rs`
- `docs/mcp-server.md`

The sanitized research evidence is in `docs/implementation/superwhisper-improvements/research-evidence.md`.

## Verification baseline

Focused tests must be followed by `npm test`, renderer typecheck, Electron main build, Rust core build, `m1:verify`, `m3:verify`, Electron E2E, source audit, and `v3:verify`. Hardware and release-only gates must be reported accurately when the current workstation or release model lock cannot prove them.

## Required review output

Return:

1. A refined implementation order with safe migration boundaries.
2. Required changes versus optional improvements.
3. Assumptions and unresolved questions.
4. Likely correctness, privacy, security, data-loss, lifecycle, and performance failure modes.
5. Specific tests and acceptance checks.
6. Any part of the design that should be rejected or deferred, with evidence.
7. A short list of repository files that must not be changed concurrently.

Label findings as Critical, High, Medium, or Low. Clearly distinguish observed repository risks from speculative suggestions. Do not expand product scope beyond the stated objective.
