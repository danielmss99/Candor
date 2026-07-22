# Completion Audit

Date: 2026-07-20

This matrix separates implemented product behavior from foundations that still
need a licensed runtime or physical proof. Exact commands, counts, artifact
hashes, and non-claims are in `verification.md`.

| Approved requirement | Status | Evidence boundary |
|---|---|---|
| Local-first, meeting-first, account-optional behavior | Implemented | Normal use does not require sign-in. Meeting IPC remains pathless and keyless. |
| Persistent six-step setup | Implemented | License, Microphone, Shortcut, System Audio, Storage, and Local AI persist completion, deferral, and last step. Slow final persistence has visible and screen-reader status. |
| Resume first incomplete step after restart | Implemented | Deferred steps remain incomplete on restart. Current-session deferral advances without startup routing pulling the wizard backward. |
| Existing-user non-blocking migration | Implemented with interactive Electron proof | A seeded existing meeting opens while setup remains incomplete, the one-time prompt persists, and Home and Settings warnings remain nonblocking. |
| Native microphone enumeration and preference | Implemented | Core owns CPAL enumeration, unique fingerprints, ordinals, default fallback, and reselection behavior. |
| Live levels and five-second playback test | Implemented with automated proof | RMS, peak, clipping, silence, denial, disconnect, memory-only PCM, bounded WAV, clearing, and Blob revocation are covered. Physical devices remain pending. |
| Probe and recording mutual exclusion | Implemented | Test memory is cleared before recording, on navigation and retry paths, on core loss, and on shutdown. |
| Opt-in global recorder shortcut | Implemented | Strict validation, conflict handling, atomic replacement, rollback, duplicate initialization, single-instance behavior, and quit cleanup are covered. A real secondary-process proof restores the primary and safely reaps only the tracked process. It never starts capture. |
| Shortcut control in Settings | Implemented | Enable, change, disable, reset, and press-to-test share the same service and renderer control. |
| `CandorApiV4` custody contract | Implemented | Every async preload response enforces no raw path and no renderer key material. Recursive nested-field checks, reviewed exact status reconstruction, forged-frame tests, and fixed typed events fail closed. |
| Phase A Trust History | Implemented | Immutable revisions, encrypted raw chunks, comparison, receipts, selection, encrypted FTS5, and reprocessing are present. |
| Phase B meeting profiles | Implemented | Built-in and custom versioned profiles control capture-time settings and immutable snapshots. |
| Phase C accuracy and model UX | Implemented | Deterministic replacements, vocabulary separation, protected-term review, model cards, verification, hardware, warm state, and measured latency are present. |
| Protected-term approval integrity | Implemented | Approval is tied to the current revision, capture-time rules, and a bounded core preview token, then creates a new revision and receipt. |
| Provisional local transcription | Implemented when a verified model is configured | Trusted partial events are bounded and reconcile only after final revision commit. No default model is bundled. |
| Combined live and final transcription | Implemented | Microphone and system lanes are aligned and mixed for live windows, final transcription, and reprocessing. |
| Safe media import | Implemented on Windows with one residual destination risk | WAV, MP3, supported M4A/MP4, and supported WebM use bounded local identity and staged digest checks. Source reads are bound to a native handle whose final path, attributes, and storage type are validated. The private staging destination retains the documented check-to-create or check-to-write race. Persistent cleanup latches and recovery gates block capture until rollback is safe, including after restart. Non-Windows production import fails closed. |
| Local diarization | Foundation complete, runtime not shipped | Preferences, encrypted user speaker names, verified-model, redistribution-license, engine, and benchmark gates exist. No engine or model is bundled. |
| Read-only CLI and MCP automation | Implemented | Packaged executables execute all six bounded read-only operations over both CLI and MCP stdio, deny mutation-shaped requests, recursively enforce custody, fail closed on process-enumeration failure, preserve `sourceTruncated` and `totalCountExact`, and preserve exact complete-tree hashes. Reads are not claimed to be transactional snapshots. |
| Required unit, integration, security, and Electron checks | Implemented and passing | The post-fix 13-stage aggregate, 79-file and 463-test Vitest suite, 213-check source audit with 36 mutations, 12-scenario Electron suite, 31-library and 339-binary normal Rust core suite, 28 tools tests, release build, package extraction, exact Source Interface bundle inventory, packaged runtime, 19-test companion harness, and 846-package SBOM passed. E2E cleanup revalidates exact process identities even after the root exits. |
| Physical microphone and shortcut matrix | Pending interactive proof | USB, Bluetooth, built-in, privacy denial, lock, sleep, resume, and real key injection require an operator session. |
| Real capture, Whisper, and traffic proof | Pending consent and hardware | No ambient audio was captured. Elevated firewall and live OS traffic observation remain pending. |
| Signed cross-platform release | Pending external release inputs | Windows is unsigned. macOS and Linux packages and signing evidence are absent. |
| External Claude review | Pending explicit approval | No repository material was transmitted and no Claude review is claimed. |

## Current conclusion

The approved implementation scope is present and automated verification passes.
The broader release mission remains incomplete because hardware, real-audio,
real Whisper, elevated live-network, external review, signing, clean provenance,
release checksums, bundled AI, clean-install, upgrade, long-duration, and
cross-platform gates cannot be inferred from automated Windows source and
package tests. Automated keyboard, axe, reduced-motion, focus-order, and 200
percent setup checks pass; interactive screen-reader observation remains
pending.
