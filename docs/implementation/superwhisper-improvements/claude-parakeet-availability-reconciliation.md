# Claude Parakeet Availability Review Reconciliation

Date: 2026-07-21

Review artifact: `claude-parakeet-availability-plan-review.md`

## Outcome

Claude's second bounded invocation completed successfully. The first invocation
timed out and produced no artifact, so it was not counted as a review.

The review does not require a product-scope expansion. It identifies concrete
implementation gaps and four release blockers. All required findings are
accepted below.

## Required Findings

- **R1, accepted:** add Parakeet to core model identity resolution so import
  start, status, verification, and inference can dispatch by package kind.
- **R2, accepted:** use a package archive staging name and a package directory
  target. Do not reuse the Whisper `.bin` target convention.
- **R3, accepted:** branch import finish before single-file verification. A
  verified Parakeet archive produces a staged directory and package manifest.
- **R4, accepted with repository adjustment:** core profile syntax validation
  permits the fixed Parakeet ID. The renderer offers it only when
  `models.listLocal` reports installed and verified. Capture and transcription
  recheck core-owned package availability before use. This keeps stored
  profiles loadable if a model is later removed while preventing unusable new
  selections through Candor's supported UI.
- **R5, accepted:** Parakeet is an explicit engine override and is exempt from
  Whisper tier consistency. The tier remains the live-Whisper fallback and
  resource preference.
- **R6, accepted:** Parakeet profiles with live transcription use a deterministic
  Whisper fallback: `small.en` for English and `small` for auto or other
  languages. Final transcription still uses Parakeet. Both model IDs are
  reported in processing metadata.
- **R7, accepted:** add direct `bzip2` and `tar` dependencies and prove the
  Windows MSVC build before treating the runtime as available.
- **R8, accepted:** dispatch final inference by model ID and add a Parakeet
  scheduler job label.

The two status/transparency observations marked optional by Claude are also
accepted because leaving Whisper-only labels would misrepresent the feature.

## Assumptions and Failure Modes

- **A1, resolved:** the Electron broker already calls
  `models.importFinish.start`, and the core runs `import_finish` through the
  existing background job manager. Package extraction will remain on that
  path. The synchronous compatibility RPC remains bounded by its existing
  120-second contract and is not used by the model library.
- **A2, resolved:** the four installed members total exactly 670,478,772 bytes.
  The archive may also contain the four pinned upstream test WAV files. The
  archive reader will permit only the fixed directory entries, four required
  model members, and four exact ignored test fixtures. Total decompressed file
  bytes are capped at 672,000,000 and entries at 16.
- **A3, accepted:** staging directories live directly under the private model
  root so final directory rename remains on one volume.
- **A4, accepted:** `cargo-with-local-perl.mjs` will prefetch the exact
  sherpa-onnx 1.13.4 static Windows archive, verify
  `d81bd1d25112540862d2387072e76b2b6843ef962918d6b5c7db5a19c6276b4c`,
  and set `SHERPA_ONNX_ARCHIVE_DIR`. A pre-staged, verified archive remains
  supported for offline CI.
- **A5, accepted:** the focused Windows build and full verification must pass
  with Whisper and Parakeet enabled together.
- **A6, accepted:** the catalog uses a valid combined SPDX expression. The
  Local Models card presents the model title, NVIDIA attribution, source,
  pinned revision, and license. Packaged third-party notices contain the full
  attribution and upstream links.

Windows archive checks additionally reject backslash traversal, UNC and device
paths, case-insensitive duplicates, links, special entries, and unexpected
members before committing a package.

## Blocker Dispositions

1. **License blocker, accepted:** implementation cannot be reported complete
   until catalog SPDX, visible attribution, notices, and SBOM proof pass.
2. **Live fallback blocker, accepted:** the deterministic Whisper fallback
   above is part of the implementation and tests.
3. **Extraction latency blocker, resolved:** use the existing background import
   job and expose verification progress state.
4. **Windows build blocker, accepted:** the combined feature build is a release
   gate. Failure keeps Parakeet unavailable and blocks completion.

## Deferred Suggestions

- GPU execution is deferred. The first supported runtime is Windows x64 CPU.
- Live Parakeet transcription is deferred because the pinned V3 package is
  offline-only.
- Uninstall UI is deferred. Package replacement remains atomic.
- Automatic modification of existing profile selections is rejected. Existing
  Whisper selections remain unchanged.

## Accepted Verification Additions

All archive attack, cache invalidation, selection, dispatch, live-fallback,
cancellation cleanup, silence, lineage, licensing, packaging, and real
inference checks from Claude's review are added to the verification target.
