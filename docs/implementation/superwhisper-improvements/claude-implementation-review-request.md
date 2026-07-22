# Claude Implementation Review Request

Date: 2026-07-21

## Role

Act as an adversarial implementation reviewer. Do not edit files. Review only
the scoped Candor implementation listed below. Codex owns all edits and final
verification.

This request contains no credentials, private recordings, real transcripts,
vault data, environment files, or key material. Do not inspect `.env`, user
data, release recordings, vault directories, or unrelated working-tree files.

## Approved Product Contract

Candor remains meeting-first, local-first, account-optional, and network-denied
for meeting data. The approved handoff is:

1. A local speech model produces immutable evidentiary transcript text.
2. An optional local text model produces a separate AI-cleaned revision.
3. A local text model produces a grounded structured recap from the current
   valid cleaned revision, or explicitly falls back to evidentiary text.

AI-cleaned text must never replace the selected evidentiary transcript. Every
successful stage must preserve lineage without storing prompt or transcript
content in its processing receipt.

The renderer may request model acquisition only by a fixed catalog model ID.
It never supplies a URL, path, hash, process argument, or redirect host.
Parakeet is a visible candidate only. It is not downloadable, selectable, or a
default until all documented runtime, conversion, license, attribution,
accuracy, Windows hardware, resource, silence, timestamp, recovery, package,
and signing gates pass.

## Accepted Plan Review Dispositions

The prior plan review is in:

- `docs/implementation/superwhisper-improvements/claude-local-ai-handoff-plan-review.md`
- `docs/implementation/superwhisper-improvements/claude-local-ai-handoff-reconciliation.md`

Important accepted constraints:

- Transcript revision kinds are `raw-asr`, `normalized`, `ai-cleaned`, and
  `legacy`.
- `currentTranscriptRevisionId` and `currentCleanedRevisionId` are separate.
- A cleaned revision must point to the current evidentiary parent before it can
  be used or searched.
- Cleanup output is bounded schema-constrained JSON with a one-to-one segment
  mapping and immutable timestamp, channel, and speaker checks.
- The model catalog is immutable application code. Redirects are revalidated,
  size and SHA-256 are checked, writes are bounded and atomic, active recording
  blocks acquisition, and cancellation is supported.
- Existing profile speech selections survive migration. Explicit stage model
  IDs are persisted for speech, cleanup, and summary.
- Parakeet remains release-gated and has no packaged URL, hash, byte count,
  runtime, or model artifact.

## Implemented Scope To Inspect

Core handoff, lineage, receipts, search, and profiles:

- `crates/candor-core/src/recording_store.rs`
- `crates/candor-core/src/background_jobs.rs`
- `crates/candor-core/src/job_manager.rs`
- `crates/candor-core/src/local_instruct_model.rs`
- `crates/candor-core/src/local_ai_service.rs`
- `crates/candor-core/src/meeting_profiles.rs`
- `crates/candor-core/src/transcription_service.rs`
- `crates/candor-core/src/main.rs`

Electron catalog, download broker, boundary validation, and fixed IPC:

- `electron/models/model-catalog.ts`
- `electron/models/model-acquisition-service.ts`
- `electron/models/model-catalog.test.ts`
- `electron/models/model-acquisition-service.test.ts`
- `electron/core/operation-registry.ts`
- `electron/core/operation-registry.test.ts`
- `electron/security/validate-core-input.ts`
- `electron/security/validate-core-input.test.ts`
- `electron/ipc/models-ipc.ts`
- `electron/ipc/jobs-ipc.ts`
- `electron/preload.cts`

Renderer handoff, model library, profiles, and proof fixture:

- `v3/renderer/src/features/local-ai/useLocalAiWorkspace.ts`
- `v3/renderer/src/features/local-ai/useLocalAiWorkspace.test.ts`
- `v3/renderer/src/features/models/model-library.ts`
- `v3/renderer/src/features/models/LocalModelLibrary.tsx`
- `v3/renderer/src/features/models/LocalModelLibrary.test.tsx`
- `v3/renderer/src/features/profiles/ProfilesSettingsPanel.tsx`
- `v3/renderer/src/features/profiles/profile-types.ts`
- `v3/renderer/src/features/settings/SettingsView.tsx`
- `v3/renderer/src/styles.css`
- `tests/visual/VisualEvidenceApp.tsx`
- `tests/e2e/candor-electron.spec.ts`

Security policy and release evidence:

- `scripts/source-security-rules.mjs`
- `THIRD_PARTY_NOTICES.md`
- `docs/implementation/superwhisper-improvements/parakeet-release-gates.md`
- `docs/implementation/superwhisper-improvements/research-evidence.md`

## Implementation Summary

- Manifest schema 5 adds typed immutable transcript revisions, a separate
  cleaned pointer, typed processing receipts, parent/input lineage, prompt
  template hashes, validation results, fallback flags, and timings.
- Cleanup attempts write into an isolated attempt, validate exact segment
  correspondence and bounds, then publish the revision and receipt with one
  manifest replacement. Rejected output preserves the source revision and
  records a failed receipt.
- Cleanup is reused when the current valid cleaned child already exists.
- Recap and ask choose cleaned input only when its parent matches the selected
  evidentiary revision. Results disclose input revision kind and whether the
  cleanup fallback was used. Recap receipts preserve input/model/prompt lineage
  without creating a transcript revision.
- Search labels original and cleaned rows separately. A cleaned row is omitted
  after the evidentiary parent selection changes.
- Profile schema 1 migrates atomically to schema 2 with explicit speech,
  cleanup, and summary model IDs plus a bounded migration record. Existing
  Whisper tier selection is retained. Parakeet selection returns
  `PARAKEET_RELEASE_GATED`.
- The fixed model catalog includes verified Whisper downloads, manual-only
  Qwen text setup, and release-gated Parakeet. The acquisition service uses
  Node HTTPS only in Electron main, revalidates every redirect against the
  entry allowlist, enforces response/size/chunk limits, verifies SHA-256, and
  hands installation to the existing model manager.
- The source audit grants network-module access only to the exact acquisition
  broker and adds a mutation proving raw TLS would be rejected.
- The renderer performs cleanup before local-LLM recap and explicitly reports
  cleaned input or original-text fallback.

## Verification Supplied To The Review

All data is synthetic or structural.

- `npm run v3:verify`: passed after fixing three compatibility assertions. The
  final run passed 31 Rust library tests, 351 Rust core tests, 481 Vitest tests,
  M0 through M5 verification, SQLCipher, durable capture/recovery, source
  security, typecheck, and builds.
- `npm test`: 82 files, 481 tests passed.
- Focused model/catalog/boundary/profile/local-AI Vitest: 7 files, 67 tests
  passed.
- `npm run audit:source`: 214 checks and 37 mutation tests passed.
- `npm run m1:verify`: passed.
- `npm run m3:verify`: passed.
- `cargo test ... meeting_profiles::tests`: 9 passed.
- `cargo test ... background_jobs::tests`: 6 passed.
- Focused cleanup tests: 14 passed.
- Focused stale-cleaned-search, legacy compatibility, read-only search, and
  automation compatibility tests passed.
- Targeted dark-theme accessibility proof passed after model-card contrast was
  corrected.
- `git diff --check`: passed with line-ending warnings only.

The full Electron matrix will be rerun after review fixes. Earlier in this
implementation it reached 11 of 12 passing, with the remaining dark-theme
contrast failure corrected and its targeted proof passing.

## Known Limitations And Honest Release State

- No Parakeet or sherpa-onnx runtime/model is bundled. No Parakeet WER,
  Windows-device, long-audio, silence, timestamp, memory, cold-start, crash, or
  package proof exists. The feature must remain gated.
- Real USB, Bluetooth, built-in, disconnected, privacy-blocked, sleep/resume,
  lock/unlock, and multi-device microphone testing requires supported physical
  hardware and is not claimed by this request.
- Local Qwen execution depends on installed verified assets. The schema,
  scheduling, validation, fallback, and fixture path are tested, but the
  current preflight reports `ready=false` on this machine.
- Signing and final installer redistribution proof are separate release gates.

## Required Review Questions

1. Can any path cause AI-cleaned text to become the evidentiary current
   transcript, survive a parent-selection change, or be published without its
   receipt atomically?
2. Can cleanup, recap, ask, retry, cancellation, restart, or fallback use stale
   lineage, hide a fallback, or lose the immutable source?
3. Are cleanup schema and output checks strict enough against prompt injection,
   reordered/duplicated/dropped segments, metadata mutation, oversized output,
   malformed JSON, IDs, numbers, and extra fields?
4. Can renderer input, redirects, HTTP behavior, cancellation races, file
   replacement, content length, chunking, or broker lifecycle create SSRF,
   arbitrary download, partial installation, overwrite, path exposure, or
   meeting-data egress?
5. Does the source-audit exception remain exact and mutation-tested, or can it
   normalize into broader Electron networking authority?
6. Is profile migration atomic, backward-compatible, bounded, and guaranteed
   to preserve existing Whisper choices? Can Parakeet be selected indirectly?
7. Do Trust History, receipt validation, and encrypted search distinguish
   original, cleaned, and summary lineage without indexing stale cleaned text?
8. Do preload, IPC, and operation schemas preserve fixed method/event
   allowlists, pathless responses, and no renderer key material?
9. Are any supplied tests tautological, missing an important concurrency or
   corruption case, or inconsistent with the documented release state?

## Output Format

List findings in severity order: Critical, High, Medium, Low. For each finding,
provide:

- severity and short title
- exact file and line number or tight line range
- concrete failure or exploit path
- why current tests do not prevent it
- smallest safe fix
- focused test that proves the fix

Separate confirmed findings from questions or defense-in-depth suggestions. Do
not call missing physical-hardware or Parakeet runtime proof a code defect when
the feature remains explicitly gated. If no Critical or High findings exist,
say so explicitly.
