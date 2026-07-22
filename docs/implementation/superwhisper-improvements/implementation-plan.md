# Accepted Implementation Plan

Date: 2026-07-19

## Approved extension, 2026-07-21

The user approved a second local-AI phase based on direct Superwhisper product
inspection and NVIDIA Parakeet research:

- Preserve immutable raw ASR text, a separately selected AI-cleaned transcript,
  and a separately generated structured recap.
- Present speech recognition and text processing as an explicit local handoff.
- Add a curated Local Models screen with explicit verified downloads and an
  advanced manual-import path.
- Keep model acquisition isolated from meeting data. The renderer supplies only
  a packaged catalog model ID, never a URL or path.
- Integrate a pinned Parakeet V3/sherpa-onnx path, but enable Parakeet as the new
  default only for new profiles and only after every Windows, accuracy,
  provenance, licensing, attribution, resource, silence, timestamp, and recovery
  gate passes.
- Preserve existing users' Whisper selections.

## Parakeet availability correction, 2026-07-21

The user rejected a permanently visible but non-downloadable Parakeet
candidate. The accepted correction makes the pinned Parakeet V3 INT8 package a
real verified download and final-transcription engine on Windows x64.

- Use the official `sherpa-onnx` 1.13.4 Rust API with static CPU inference.
- Download the fixed upstream model archive only after an explicit user action.
- Verify the outer archive and every installed model member before an atomic
  directory commit.
- Offer Parakeet in meeting profiles only when the package is installed and
  verified through the core-owned model list.
- Use Whisper Small as the provisional live-caption fallback and Parakeet for
  the final transcript.
- Preserve every existing profile selection.
- Prefer Parakeet for newly created profiles only when it is locally ready;
  otherwise retain the current Whisper default.

Claude's adversarial plan review completed successfully and is reconciled in
`claude-parakeet-availability-reconciliation.md`.

The independent extension review completed successfully on 2026-07-21. Its
findings and dispositions are recorded in
`claude-local-ai-handoff-reconciliation.md`.

## Review state

- User approval: the complete Superwhisper-inspired Candor plan was explicitly
  approved for implementation.
- Claude local-AI handoff plan review: completed through the real helper and
  reconciled in `claude-local-ai-handoff-reconciliation.md`.
- Claude implementation review: completed through the real helper with no
  Critical or High findings. One Medium and one Low finding were fixed.
- Claude final review: completed through the real helper and confirmed no
  remaining Critical, High, or Medium findings.
- Claude Parakeet availability implementation review: completed through the
  real helper and reconciled in `claude-parakeet-review-reconciliation.md`.
  It found no Critical or High defect. One Low hardening note and one
  informational cancellation note were fixed and retested.
- Automated implementation status: complete for the approved local-AI handoff,
  verified model library, profile schema, and Windows x64 Parakeet download and
  inference path. Real inference against the pinned official model and runtime
  passed. Production signing, installer publication, broader benchmarks, and
  clean-source release proof remain separate release gates.

## Accepted order

1. Persistent setup state, six focused onboarding screens, native microphone
   probe and playback, preferred-device persistence, single-instance handling,
   and opt-in global shortcut support.
2. Immutable transcript revisions, processing receipts, reprocessing jobs, and
   encrypted full-text search.
3. Meeting profiles, deterministic replacements, protected-term review, and
   model-card transparency.
4. Provisional local transcription, safe media import, and a local diarization
   foundation gated by model licensing and benchmark evidence.
5. Read-only Rust CLI and MCP stdio companions using core-owned read APIs.
6. Full automated and hardware-aware verification, external Claude
   implementation review if approved, finding reconciliation, and reruns.

## Locked product decisions

- The global shortcut opens and focuses the recorder. It does not start capture.
- Suggested accelerator is `CommandOrControl+Shift+Space`, disabled until the
  user opts in.
- Shortcut behavior is available only while Candor is running. Tray and
  background lifecycle changes are deferred.
- The microphone test uses native Rust audio, aggregate levels, and an optional
  five-second memory-only playback sample. It creates no meeting or file.
- Normal use remains account-optional and local-first.
- Cloud models, ambient application context, clipboard capture, arbitrary paste,
  and native push-to-talk hooks are excluded.

## Implementation boundaries

- Electron main owns setup progress, shortcut persistence and registration,
  single-instance lifecycle, and fixed OS-settings actions.
- Rust core owns microphone enumeration, preferred-device resolution, probe
  audio, durable recording, revisions, search, profiles, replacements, live
  transcript processing, import, and read APIs.
- Renderer receives narrow pathless payloads through the preload allowlist.
- No new generic IPC, filesystem, process, URI, network, or event channel is
  permitted.

## Stop and review conditions

- Stop before retrying an external Claude transmission until fresh informed
  approval exists.
- Stop a phase if it would overwrite original recording or transcript evidence.
- Stop a release claim when hardware, signing, model redistribution, or
  cross-platform proof is missing. Record it as unproven instead.
- Any material scope expansion requires renewed user approval.
