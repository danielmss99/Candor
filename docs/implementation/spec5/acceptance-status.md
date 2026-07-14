# SPEC-5 acceptance status

Date: 2026-07-14

This status separates implemented application behavior from release evidence that cannot be manufactured in source code. Candor Standard and Maximum Accuracy remain fail-closed until their real assets and external receipts exist.

## Standard package

- [ ] `large-v3-turbo` is bundled. The pinned candidate and required Standard profile are recorded, but the model file is absent.
- [ ] `small` and `small.en` are bundled. Both pinned candidates are recorded, but the model files are absent.
- [ ] Exactly one LLM is selected and bundled. The primary and fallback Qwen candidates remain under benchmark, conversion, and redistribution review.
- [ ] A general dictionary is bundled. The verified terminology asset contract and idempotent installer exist, but no production package or publisher key is present.
- [x] Full `large-v3` is excluded from Standard and required only by the Maximum Accuracy profile.
- [x] The source interface contains no baseline first-run download path. A publishable Standard installer still cannot be produced until its local assets are present.

## Persistent jobs

- [x] Transcription is queued only after verified durable capture finalization.
- [x] A fast recap is chained only after transcription completes successfully.
- [x] Jobs run in the Rust core independently of renderer navigation.
- [x] Job state is encrypted and persisted outside the renderer.
- [x] Descriptor-backed jobs recover after renderer reload or core restart.
- [x] Queued, running, paused, cancelling, completed, failed, and cancelled states are represented.
- [x] Progress, estimated time, cancellation, retry, completion notification, and acknowledgement controls exist.
- [x] Failure and cancellation preserve source recordings, transcripts, and completed results.
- [x] Close behavior explicitly offers keep open, pause and close, or cancel jobs and close. Candor does not silently hide to the tray.

## Scheduling and capture safety

- [x] Recording, finalization, and recovery preempt local inference.
- [x] A new recording may start while descriptor-backed jobs exist; restartable inference pauses and resumes.
- [x] Transcription has deterministic priority over recap, Ask, export, and dictionary work after recording priority is released.
- [x] Background queue failures do not fail or delay a verified durable stop result.
- [ ] No audio drops occur under realistic inference load. This requires the physical hardware and duration matrix.

## Dictionaries

- [x] Signed, data-only `.candordict` import works through the picker and pathless drag-and-drop IPC.
- [x] Exact-file, schema, traversal, nested path, duplicate, symlink, size, ratio, digest, signature, and minimum-version checks are covered.
- [x] Specialist and organization-specific terminology can use the same local data package format.
- [ ] Organization identity is shown as verified. This remains blocked until an organization trust policy and trusted public keys are configured.
- [x] Unknown self-signed packages are honestly labelled `Community pack - unverified`.
- [x] Scripts, executables, HTML, nested content, and unknown archive members are rejected.
- [x] Automatic Whisper context and LLM glossary retrieval use enabled dictionaries without user-authored prompts.
- [x] Corrections are proposals only. Pharmaceutical and numeric changes require approval.
- [x] Original transcript text and correction decisions are preserved.

## Release evidence

- [ ] Selected LLM provenance, conversion, licensing, and redistribution review are complete.
- [ ] Runtime and model hashes correspond to packaged production files.
- [ ] 8 GB, 16 GB, and 32 GB hardware benchmarks are complete.
- [ ] Clean offline install and upgrade pass.
- [ ] Physical microphone, system audio, and combined capture pass.
- [ ] 5, 30, 60, and 180 minute sessions pass under representative inference load.
- [ ] Sleep/resume and device switching pass.
- [ ] Installer signing and timestamping pass.
- [ ] Release checksums, SBOM, notices, model cards, and provenance are published.

## Fail-closed result

`package:standard` and `package:maximum-pack` intentionally fail before packaging because the release manifest is still the source-interface profile and the required production assets and evidence are absent. Do not set `releaseReady` or `release-selected` to bypass these checks.
