# External Public Beta Gates

Status date: 2026-07-15

Code completion does not claim public release readiness. Every item below must
be backed by a real receipt from the stated environment. Missing access or
evidence remains a blocked gate; it is never represented by a fixture.

## Windows Signing

Status: **Blocked**

- Azure Trusted Signing configuration is implemented and fails closed.
- No Azure tenant, client credential, signing account, certificate profile, or
  publisher identity was available during this run.
- No signed and RFC 3161-timestamped installer was produced.
- Required receipt: valid Authenticode signatures for the Electron executable,
  Rust sidecar, and offline NSIS installer, including timestamp and certificate
  chain validation on a clean Windows machine.

## Clean Installation And Upgrade

Status: **Blocked**

- Install on a clean supported Windows x64 machine.
- Verify no developer tools, model downloads, Ollama, localhost inference
  service, or manual path selection are needed.
- Upgrade from the last supported Candor identity and schema.
- Prove existing recordings remain openable, exportable, and deletable.
- Prove rollback and failed-upgrade behavior do not corrupt local data.

## Physical Capture Matrix

Status: **Blocked**

- Physical microphone capture.
- Physical system-audio capture.
- Combined microphone and system-audio capture.
- Permission denial and recovery.
- Device removal and replacement during capture.
- Verify active recording always preempts or pauses inference without audio
  drops.

## Duration And Resource Matrix

Status: **Blocked**

- Run 5, 30, 60, and 180-minute sessions on declared 8 GB, 16 GB, and 32 GB
  Windows hardware tiers.
- Measure dropped frames/chunks, finalization duration, peak memory, thermal
  behavior, disk pressure, and background inference recovery.
- Repeat with transcription and recap tasks queued before the next recording.

## Sleep, Resume, And Device Switching

Status: **Blocked**

- Sleep and resume during idle, recording, transcription, and recap states.
- Switch default microphone and system-audio devices during recording.
- Verify recovery messaging, persisted task state, and durable audio safety.

## AI Quality Certification

Status: **Partially complete**

- Real Qwen3 4B Q4_K_M recap and Ask passed on the current development machine.
- Strict JSON output, transcript source grounding, model/runtime hashes,
  cancellation boundary, and private prompt deletion are proven locally.
- Real Small Whisper proof has passed in the existing local evidence set.
- Turbo could be loaded, but a full CPU quality/performance certification was
  not completed within the available run window on this 16 GB development
  machine.
- Required: representative accents, noisy meetings, overlapping speech,
  pharmaceutical terminology, names, numbers, dosages, owners, dates, and
  hallucination regression sets across the declared hardware tiers.

## Network Isolation

Status: **Blocked**

- Source and local process-boundary tests pass.
- Elevated Windows network-denial evidence for the signed package is still
  required.
- Cross-platform packaged network-exit evidence remains incomplete.

## Release Materials And Publication

Status: **Blocked**

- Source SPDX SBOM generation and verification pass.
- Final artifact checksums cannot be certified until the worktree is clean and
  signed release artifacts are rebuilt from the release commit.
- Publish final SBOM, SHA-256 checksums, third-party notices, licenses, model
  cards, model/runtime provenance, benchmark receipts, and signing receipts.
- The selected Qwen GGUF is larger than GitHub's 2 GiB single-asset limit.
  GitHub publication must remain blocked until approved external artifact
  hosting or another release-distribution design is in place.
- Keep the offline installer requirement. Do not replace it with an NSIS web
  installer or a first-run model download.

## Merge And Publication Rule

Source changes may proceed only after code-level acceptance and final review.
Public artifact publication requires every external gate above to pass. A pull
request or release description must list any remaining gate as incomplete and
must not substitute local development proofs for clean-machine or hardware
receipts.
