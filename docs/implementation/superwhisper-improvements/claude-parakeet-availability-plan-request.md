# Claude Plan Review Request: Make Parakeet Usable

Date: 2026-07-21

## Objective

Review a focused extension that makes NVIDIA Parakeet TDT 0.6B V3 INT8 a
genuinely downloadable and selectable local speech model in Candor. The
current permanent `release-gated` placeholder is a product defect. Codex will
implement and verify the change. Claude must provide adversarial plan review
only and must not edit repository files.

## Required Outcome

- The Local Models screen downloads a pinned Parakeet model package when the
  user explicitly requests it.
- Electron accepts only the fixed catalog model ID. It never accepts a URL or
  filesystem path from the renderer.
- The Rust core verifies and installs the fixed multi-file package atomically.
- Meeting profiles can select Parakeet after the installed package verifies.
- Final transcription dispatches to Parakeet locally and retains the existing
  immutable raw, normalized, cleaned, and recap lineage.
- Existing profiles keep their Whisper selections.
- New built-in and custom profiles may prefer Parakeet only when it is both
  installed and verified. They must have an explicit Whisper fallback when it
  is not ready.
- Live provisional transcription remains Whisper-based because this Parakeet
  V3 artifact is an offline model.

## Pinned Primary Evidence

Official model archive:

- URL: `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2`
- Bytes: `487170055`
- GitHub asset digest:
  `5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf`
- Required members under the single package directory:
  `encoder.int8.onnx`, `decoder.int8.onnx`, `joiner.int8.onnx`, and
  `tokens.txt`.

Runtime:

- Official Rust crate: `sherpa-onnx = 1.13.4`, Apache-2.0.
- The official crate statically links by default and downloads the matching
  prebuilt native library at build time when `SHERPA_ONNX_LIB_DIR` is absent.
- Windows x64 build artifact:
  `sherpa-onnx-v1.13.4-win-x64-static-MT-Release-lib.tar.bz2`.
- Bytes: `119847445`.
- GitHub asset digest:
  `d81bd1d25112540862d2387072e76b2b6843ef962918d6b5c7db5a19c6276b4c`.
- The Rust API accepts normalized PCM samples in memory, so Candor does not
  need a plaintext temporary WAV or helper process.

Upstream C API configuration:

- transducer encoder, decoder, joiner, and tokens paths
- `model_type = "nemo_transducer"`
- offline recognition

## Repository Grounding

- `electron/models/model-catalog.ts` currently has a Parakeet entry with no
  download, no hash, no size, `releaseState: "release-gated"`, and
  `defaultEligible: false`.
- `electron/models/model-acquisition-service.ts` already enforces HTTPS host
  allowlists, exact Content-Length, exact byte count, SHA-256, bounded chunks,
  capture exclusion, and core-owned import. It currently assumes one final
  model file.
- `crates/candor-core/src/model_manager.rs` currently imports one verified
  Whisper `.bin`. Parakeet needs fixed-layout package extraction and directory
  verification.
- `crates/candor-core/src/transcription_service.rs` currently dispatches all
  final ASR through `whisper-rs`.
- `crates/candor-core/src/meeting_profiles.rs` explicitly rejects Parakeet with
  `PARAKEET_RELEASE_GATED`.
- The worktree contains a large, already verified implementation. Unrelated
  edits must be preserved.

## Proposed Implementation

1. Extend the trusted catalog with package metadata and the exact model archive
   digest and size. Keep the renderer response pathless and URL-free.
2. Preserve the current streamed archive download and outer SHA-256 check.
3. Extend core import finish for this one package kind. Use Rust `bzip2` and
   `tar` readers. Reject absolute paths, parent traversal, links, duplicate
   normalized names, unexpected files, unexpected nesting, device entries,
   more than a small fixed member count, and decompressed bytes above a fixed
   ceiling. Extract only the four required files into a private staging
   directory, flush them, write a core-owned package manifest, and atomically
   rename the directory into place.
4. Verify installed Parakeet packages using the outer archive digest recorded
   by import plus a deterministic aggregate digest of exact member names,
   sizes, and contents. Cache only when all member sizes and modification times
   still match.
5. Add `sherpa-onnx = 1.13.4` behind a `local-parakeet` feature and enable that
   feature in Candor's production build scripts.
6. Add a Parakeet engine adapter that accepts in-memory 16 kHz mono PCM and only
   core-resolved verified model paths. Configure the official offline
   transducer runtime with greedy search and `model_type = nemo_transducer`.
7. Dispatch final ASR by speech model ID. Apply deterministic replacement rules
   after the raw Parakeet result. Record engine, model package digest, runtime
   version, duration, language setting, and timing in the processing receipt.
8. Permit Parakeet in profile validation. Keep all existing profiles unchanged.
   New defaults should select Parakeet only when installed and verified, with
   Whisper as the explicit unavailable fallback.
9. Update Local Models and profile UI states so downloaded and verified
   Parakeet is selectable. Do not claim that uninstall, GPU execution, or live
   Parakeet transcription exists.
10. Add focused archive-attack, verification-cache, selection, dispatch,
    cancellation, silence, and lineage tests. Run a real local inference proof
    against the exact upstream archive when the artifact is available.
11. Update third-party notices, SBOM inputs, release gates, implementation plan,
    and verification evidence.

## Constraints

- Local-first and network-denied for meeting data.
- Model network access is explicit and isolated from meetings.
- No renderer URL, raw path, process command, or generic IPC.
- No plaintext temporary meeting audio.
- No change to existing profile selections.
- Do not weaken current Whisper verification or live transcription.
- No claim of a new default unless runtime and package verification actually
  pass.

## Requested Review

Return:

1. Required changes versus optional improvements.
2. Assumptions and unresolved questions.
3. Security, privacy, licensing, packaging, and migration failure modes.
4. Specific tests and acceptance checks.
5. Any scope concern that should block implementation.

Prioritize concrete repository-grounded findings. Distinguish observed defects
from suggestions. Do not propose cloud inference or renderer-controlled paths.
