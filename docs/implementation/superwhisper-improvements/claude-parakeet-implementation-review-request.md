# Claude Implementation Review Request: Parakeet Availability

Date: 2026-07-21

## Role

Perform an adversarial implementation review only. Do not edit files. Codex
owns all changes and verification. Report only repository-grounded findings.
Each finding must include severity, exact file and line, evidence, impact, and
a concrete fix. Separate defects from optional suggestions.

## Objective

The prior product state said: "Parakeet appears as a candidate but remains
non-downloadable, non-selectable, and ineligible as a default." The implemented
change must make the pinned NVIDIA Parakeet TDT 0.6B V3 INT8 package:

1. explicitly downloadable from Candor's fixed local-model catalog;
2. installed only after exact archive and member verification;
3. selectable for final transcription after verification;
4. automatically recommended for transcription and new custom meeting profiles
   after verification, without changing existing profile selections;
5. dispatched through local sherpa-onnx CPU inference while live provisional
   text continues through an explicit verified Whisper fallback;
6. compatible with Candor's local-only, pathless, network-denied Rust core.

## Accepted Plan And Prior Reconciliation

- `docs/implementation/superwhisper-improvements/claude-parakeet-availability-plan-request.md`
- `docs/implementation/superwhisper-improvements/claude-parakeet-availability-plan-review.md`
- `docs/implementation/superwhisper-improvements/claude-parakeet-availability-reconciliation.md`
- `docs/implementation/superwhisper-improvements/implementation-plan.md`

## Scoped Files To Inspect

Implementation:

- `electron/models/model-catalog.ts`
- `electron/models/model-acquisition-service.ts`
- `electron/models/model-catalog.test.ts`
- `electron/models/model-acquisition-service.test.ts`
- `crates/candor-core/Cargo.toml`
- `crates/candor-core/Cargo.lock`
- `crates/candor-core/src/parakeet_package.rs`
- `crates/candor-core/src/model_manager.rs`
- `crates/candor-core/src/transcription_service.rs`
- `crates/candor-core/src/local_model_scheduler.rs`
- `crates/candor-core/src/meeting_profiles.rs`
- `crates/vendor/sherpa-onnx-sys/Cargo.toml`
- `crates/vendor/sherpa-onnx-sys/build.rs`
- `crates/vendor/sherpa-onnx-sys/src/**`
- `scripts/sherpa-onnx-build-archive.mjs`
- `scripts/cargo-with-local-perl.mjs`
- `scripts/build-release-core.mjs`
- `scripts/v3-release-sbom.mjs`
- `package.json`

Renderer and product behavior:

- `v3/renderer/src/features/models/model-library.ts`
- `v3/renderer/src/features/models/LocalModelLibrary.tsx`
- `v3/renderer/src/features/models/LocalModelLibrary.test.tsx`
- `v3/renderer/src/features/profiles/MeetingProfileManager.tsx`
- `v3/renderer/src/features/profiles/profiles.test.tsx`
- `v3/renderer/src/features/local-ai/useLocalAiWorkspace.ts`
- `v3/renderer/src/features/settings/SettingsView.tsx`
- `v3/renderer/src/candor-api.d.ts`

Licensing and supply chain:

- `THIRD_PARTY_NOTICES.md`
- `licenses/CC-BY-4.0.txt`
- `electron/models/model-catalog.ts`
- `scripts/v3-release-sbom.mjs`

## Pinned Artifacts And Real Proof

Model archive:

- bytes: `487170055`
- SHA-256:
  `5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf`
- actual archive member list matched the exact root, four required model files,
  `test_wavs/`, and four known WAVs.

Native runtime archive:

- bytes: `119847445`
- SHA-256:
  `d81bd1d25112540862d2387072e76b2b6843ef962918d6b5c7db5a19c6276b4c`
- the vendored `sherpa-onnx-sys` patch removes its `ureq` build dependency,
  requires the verified local archive, verifies it again in `build.rs`, and
  refuses Windows builds without `target-feature=+crt-static` for the pinned
  `/MT` artifact.

Real local inference passed using the official `test_wavs/en.wav` member:

```text
CANDOR_REAL_PARAKEET_TEXT=Ask not what your country can do for you, ask what you can do for your country.
```

The successful proof used the exact package installer, exact member hashes,
the statically linked sherpa runtime, CPU provider, `nemo_transducer`, greedy
search, and no helper process or plaintext meeting-audio file.

## Verification Completed

- `npm test`: 82 files, 483 tests passed.
- `npm run electron:v3:typecheck-renderer`: passed.
- `npm run electron:v3:build-main`: passed.
- `npm run core:v3:build`: passed with
  `sqlcipher-vault,local-whisper,local-parakeet` after a 16m25s cold build.
- Rust core suite with local Whisper: 397 tests passed.
- Combined `local-whisper,local-parakeet` native executable linked.
- Real ignored Parakeet package and inference proof: passed.
- `npm run m1:verify`: passed.
- `npm run m2:verify`: passed.
- `npm run m3:verify`: passed.
- `npm run test:electron`: 12 Playwright tests passed.
- `npm run audit:source`: 214 checks and 37 mutation tests passed.
- `node scripts/v3-release-sbom.mjs`: passed.
- `npm run v3:verify`: passed through M0-M5 and 483 Vitest tests.

## Review Questions

1. Can any renderer-controlled value alter a Parakeet URL, package path,
   archive member path, native library path, model path, or sherpa provider?
2. Does archive extraction reject Windows traversal, links, special entries,
   duplicate normalized paths, unexpected members, entry-count abuse, and
   decompression expansion before installation?
3. Are cancellation, failed extraction, failed replacement, and rollback paths
   safe and free of partially trusted final packages?
4. Can a package verification cache be forged or become stale in a way that
   bypasses member hashes?
5. Does final ASR always dispatch Parakeet profiles to sherpa, while live ASR
   uses only the explicit language-appropriate Whisper fallback?
6. Are Parakeet selection and recommended-default behavior actually reachable
   after verification without modifying existing profiles?
7. Does the `/MT` static runtime enforcement cover debug, release, packaging,
   and remapped release builds without breaking SQLCipher or Whisper?
8. Did the vendored sys patch preserve the official 1.13.4 FFI surface while
   removing only build-time networking?
9. Are CC BY 4.0 attribution, Apache/MIT runtime notices, and SPDX SBOM entries
   adequate and internally consistent?
10. Identify any Critical or High issue that invalidates the claim that
    Parakeet is downloadable, selectable, default-eligible, and usable locally.

Do not treat missing cloud, GPU, macOS/Linux Parakeet, live Parakeet, or model
uninstall as defects. Those items are explicitly out of scope.
