# NVIDIA Parakeet Availability and Release Proof

Date: 2026-07-21

Status: implemented for Windows x64. Parakeet is explicitly downloadable,
selectable for final transcription, and eligible to become the recommended
default after the core verifies the installed package.

Candor does not bundle the 487 MB model. The Local Models screen downloads the
fixed upstream archive only after a user action. The renderer supplies only the
packaged model ID. Electron owns the fixed URL and outer integrity check, while
the network-denied Rust core owns member verification, transactional install,
model paths, and inference.

## Pinned implementation

- Model: NVIDIA Parakeet TDT 0.6B V3 INT8 package converted for sherpa-onnx.
- Model archive URL:
  `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2`
- Model archive bytes: `487170055`.
- Model archive SHA-256:
  `5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf`.
- Runtime: sherpa-onnx 1.13.4 Windows x64 static `/MT` CPU archive.
- Runtime archive bytes: `119847445`.
- Runtime archive SHA-256:
  `d81bd1d25112540862d2387072e76b2b6843ef962918d6b5c7db5a19c6276b4c`.
- Runtime provider and model type are core-owned constants: `cpu` and
  `nemo_transducer`.
- Model license: CC BY 4.0. sherpa-onnx is Apache-2.0 and ONNX Runtime is MIT.

The core also pins the byte count and SHA-256 for encoder, decoder, joiner, and
tokens. Unknown archive members, unsafe paths, duplicate normalized paths,
links, special entries, excess entries, decompression expansion, and any member
integrity mismatch fail the install before the staging directory is committed.

## Product behavior

- Before installation, the model card offers a Download action.
- During acquisition, cancellation aborts the core-owned staging import.
- After full verification, Parakeet can be selected for final transcription.
- A verified Parakeet install is the recommended default for unpinned model UI
  state and for newly created custom profiles.
- Existing meeting profiles are not modified.
- Live provisional captions remain on language-appropriate Whisper Small.
  Parakeet produces the final transcript through local sherpa-onnx CPU
  inference.
- If Parakeet is missing, corrupt, or unavailable in the build, selection and
  inference fail closed rather than silently pretending it is ready.

## Completed proof

- Exact outer archive size and SHA-256 verification passed for both model and
  runtime archives.
- Exact archive-member enumeration, member-size verification, member SHA-256
  verification, staged install, rollback, verify cache, and cancellation tests
  passed.
- The pinned package was installed through the production package installer and
  transcribed the official English fixture with the native sherpa-onnx CPU
  runtime. It returned:
  `Ask not what your country can do for you, ask what you can do for your country.`
- The combined SQLCipher, Whisper, and Parakeet core build passed.
- Full Vitest, renderer typecheck, Electron main build, Rust tests, M1 through
  M3, Electron end-to-end tests, source audit, SBOM generation, and aggregate
  V3 verification passed.
- A real Claude implementation review found no Critical or High defect. Its two
  Low findings and two informational observations are reconciled in
  `claude-parakeet-review-reconciliation.md`.

## Remaining public-release proof

The feature is no longer blocked from download or selection in Candor. Public
release still needs the normal production-signing and installer-publication
gates. Broader language, timestamp, silence, long-audio, accuracy, peak-memory,
cold-start, and minimum-hardware benchmarks remain product-quality evidence to
collect. They do not turn the implemented model back into a non-downloadable
catalog placeholder.

Primary upstream evidence:

- https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3
- https://k2-fsa.github.io/sherpa/onnx/c-api/html/offline_asr.html
- https://k2-fsa.github.io/sherpa/onnx/install/windows.html
