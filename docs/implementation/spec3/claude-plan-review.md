I now have enough to write the full review. Let me compile the findings.

---

# SPEC-3 Bundled Local AI — Implementation Plan Review

**Branch:** `codex/bundled-local-ai` at `adfe573`
**Role:** Independent architecture, supply-chain, security, and release reviewer

---

## 1. Current State vs. the Objective

The repository evidence and the objective are further apart than the branch name implies.

| Layer | Current state | Gap for zero-setup bundle |
|---|---|---|
| Whisper inference | `whisper-rs` FFI to whisper.cpp — correct, no subprocess | Model file still requires user import via `ModelManager` |
| Whisper model file | User streams via `import_start/Chunk/Finish` | Not in `electron-builder.v3.yml` extraResources |
| LLM runner binary | User imports via `LocalInstructAssetManager.import_from_path` | Not packaged |
| GGUF model | Same user-import path; no default selected | Not packaged; no default candidate |
| Bundle manifest | `instruct-assets.json` written by user import | No "bundled" source type exists |
| SBOM | npm + Cargo lock packages only | No bundled binary/model entries |
| UI settings | Some paths still assume manual import flow | Not converged |

The current branch has laid the correct architectural foundations (hash verification, path opacity, scheduler serialisation, RPC boundary, data-safety primitives) but has not yet wired them to a packaged-asset source. Everything below describes the remaining work.

---

## 2. Decisions — Refined

### D1: Whisper integration — `whisper-rs` only, model file bundled

**Verdict: Keep `whisper-rs` direct FFI.** Do not add a subprocess for Whisper. The `local-whisper` Cargo feature already gates the inference path correctly.

The model file is the only asset that needs packaging. The `CANDOR_SHA256_*` env vars at build time (`model_manager.rs:19–58`) already allow CI to bake real, known-good hashes once a verified model file is placed into the build tree. Nothing in `model_manager.rs` needs to change for the model-file side. Whisper runtime provenance derives from the locked Cargo source for `whisper-rs` and `whisper-sys`, which are already in `Cargo.lock` and will appear in the SBOM once bundled-asset entries are added.

**What is missing:** `electron-builder.v3.yml` has no `extraResources` entry for the Whisper model. A CI step to place `ggml-base.en.bin` (or whichever verified file is chosen) into the build tree and verify its hash before packaging does not exist.

### D2: Bundled-asset manifest and Rust resolver without exposing paths to the renderer

The current `LocalInstructModelConfig::from_sources()` (`local_instruct_model.rs:159–196`) merges a managed-local-assets manifest with environment variables. A third source, `bundled`, is needed.

The resolver hierarchy should be:

```
bundled-assets-root  (set by electron-main via env before spawning core)
  └── instruct-assets.json      ← bundled manifest (read-only, shipped in package)
  └── llama-cli[.exe]
  └── instruct-model.gguf
user-assets-root  (existing managed flow, remains as override/repair path)
  └── instruct-assets.json
  └── ...
environment variables  (dev/CI only, lowest trust)
```

The `bundled-assets-root` path is communicated from electron-main to core as a single env var set before `spawn()` — never through the renderer or through an RPC parameter. The renderer never sees the path; it sees only the opaque `bundledAssetsAvailable: bool` and `bundledAssetsVerified: bool` fields in the AI status response.

In `local_instruct_model.rs`, add a `BundledAssetSource` variant to the config source and extend `from_sources` to check for a bundled manifest first. In `local_instruct_assets.rs`, the existing `AssetManifest` structure should gain a `bundled: bool` field. A bundled manifest is considered valid only if `bundled == true` and the file fingerprints match. A user-written manifest cannot set `bundled: true` because the manifest is written only by `write_manifest`, which must only set `bundled: false` for user imports.

### D3: Dev fixtures versus production manifests

The current `SYNTHETIC_PROOF_BYTES` pattern in `model_manager.rs:16` correctly marks synthetic models. The same discipline is needed for bundled assets.

Required separation:

- **Dev fixtures:** `CANDOR_AI_BUNDLE_FIXTURE=1` env var causes the bundled-asset locator to look in a local `fixtures/ai-bundle/` tree. The fixture manifest has `"bundled": false` explicitly. Any RPC response that reports `"bundledAssetsReady": true` while this env var is set must also set `"fixtureMode": true`.
- **Production manifests:** Written by the build pipeline (not by the application at runtime). The production bundled manifest has `"bundled": true` and is included in `extraResources` under a path never written at runtime.
- **Guard:** In release builds (`cfg!(not(debug_assertions))` or a dedicated Cargo feature), the core must hard-fail startup if a bundled manifest claims `"bundled": true` but its hashes do not match the compile-time constants, rather than silently degrading to AI-disabled. The degradation path is only for missing files, not for corrupted ones.
- **CI gate:** A pre-package build step must verify that every bundled manifest entry has a matching SHA-256 constant in the Rust source before the installer is signed.

### D4: Protocol operations, preload methods, renderer states, packaging checks, SBOM records, and corruption tests required now

**Required RPC additions:**
- `ai.bundledAssetsStatus` — reports `bundledWhisperModel: { available, verified, modelId }` and `bundledInstructBundle: { available, verified }` without exposing paths. Distinct from `ai.instructAssetsStatus` which covers user imports.

**Required preload additions:**
- `window.ai.bundledAssetsStatus()` wrapping the above.
- No new path-exposing methods.

**Required renderer states (not path-exposing UI):**
- `whisper: bundled-ready | bundled-corrupt | user-model-required`
- `instruct: bundled-ready | bundled-corrupt | user-import-required | no-default-selected`

**Required packaging checks (build-time, not runtime):**
- Script that reads `electron-builder.v3.yml`, locates each file in `extraResources`, hashes it with SHA-256, and verifies against constants in the Rust source. Must run before `electron-builder` and fail the build if any hash mismatches.
- `electron-builder.v3.yml` must gain entries for the Whisper model under `extraResources`.
- macOS `binaries` list must include the LLM runner when it is added (required for hardened-runtime signing).

**Required SBOM additions to `v3-release-sbom.mjs`:**
- An explicit package entry for each bundled binary and model: name, version, download-location (upstream URL or `NOASSERTION`), SHA-256 checksum as an `externalRef`, and `licenseConcluded`/`licenseDeclared`.
- whisper.cpp / whisper-rs: MIT. Already partially covered by the Cargo lock inventory but must be called out as a bundled binary, not just a library dependency.
- For the LLM runner (llama.cpp): MIT. Must appear as a distinct `FILE` or `PACKAGE` entry with its upstream version and hash.
- For any GGUF model: the license depends on the redistribution grant of the model family — this entry must NOT be populated until redistribution rights are confirmed.

**Required corruption tests:**
- `bundled_whisper_model_corrupt_disables_transcription_not_recording` — verifies that a zero-length or wrong-hash model file causes transcription to return an error while recording continues.
- `bundled_instruct_assets_corrupt_disable_recap_not_recording` — same for LLM.
- `dev_fixture_manifest_cannot_set_bundled_true` — asserts that `write_manifest` with `bundled: true` panics/errors in test.
- `sbom_contains_bundled_asset_entries` — integration test on the SBOM output.

### D5: Gates that must stay blocked

The following are hard blockers; work can proceed around them but they cannot be unblocked by source changes alone:

| Gate | Blocker | Why source can't unblock it |
|---|---|---|
| Default LLM selection | Redistribution rights, quantization provenance, real hardware benchmarks, meeting-quality evidence | Cannot be resolved without a specific model candidate, legal review, and hardware tests |
| `bundled: true` in any manifest | Real binary/model files with confirmed hashes in CI | No fake hashes; placeholder files with wrong SHA-256 will cause runtime verification failures |
| macOS notarization | Clean-machine offline install test; Apple notarisation run | Build environment dependency |
| Linux AppImage LLM path | `set_asset_permissions` on Linux is implemented but untested in a signed AppImage | Requires real AppImage build |
| SBOM GGUF license entry | Redistribution grant confirmation | Legal/licensing decision |
| `bundledAssetsReady: true` in non-fixture mode | Real files in `extraResources` | Cannot be simulated |

### D6: Repair path without updater or network

The correct representation is already implied by the existing architecture: reinstall the application package. The UI must:
1. When bundled asset verification fails, show a user-facing message that names the affected AI feature (not paths, not hashes) and instructs the user to reinstall Candor.
2. Not offer a "Repair" button that makes a network call or downloads anything.
3. The existing `import_from_path` mechanism in `LocalInstructAssetManager` remains available as an advanced override path, unchanged.

No code changes are needed in the core for repair. The UI layer needs a `bundledCorrupt` state that maps to the reinstall instruction.

---

## 3. Required Changes vs. Optional Improvements

### Required

1. **`electron-builder.v3.yml`** — Add `extraResources` entries for the Whisper model file. (Cannot ship a zero-setup bundle without this.)
2. **`local_instruct_assets.rs`** — Add `bundled: bool` to `AssetManifest`; prevent `write_manifest` from setting `bundled: true`; add `load_bundled_runtime_config(bundled_root: &Path)` that reads a read-only bundled manifest.
3. **`local_instruct_model.rs`** — Extend `from_sources` to prefer bundled root before user-managed root; add `BundledAssetSource` config variant.
4. **`main.rs`** — Add `ai.bundledAssetsStatus` RPC method; expose bundled availability without paths.
5. **`v3-release-sbom.mjs`** — Add bundled-asset SBOM entries (whisper model, llama-cli when ready, GGUF when licensed).
6. **New build script** — Pre-package SHA-256 verification of each bundled file against Rust compile-time constants.
7. **`model_manager.rs`** — Document (in tests, not comments) the `CANDOR_SHA256_*` env-override path for CI; add a test that a missing env var keeps the default hash, not a zero/empty hash.
8. **UI convergence** — Settings paths that still assume manual import must branch on `bundledAssetsAvailable` and hide advanced-import UI when the bundle is verified.

### Optional (do not implement in this wave)

- Hardware-tier RAM detection for auto-selecting LLM context size.
- Multi-model bundle switching.
- Progress reporting for first-use verification (it is a background check).
- Streaming output from the LLM subprocess to the renderer.
- Any form of background model download.

---

## 4. Assumptions and Unresolved Questions

**Assumptions:**
- The Whisper model to bundle is `ggml-base.en.bin` (147 MB), consistent with `DEFAULT_MODEL_ID = "base.en"` in `model_manager.rs:15`. This has not been confirmed.
- The LLM runner will be a llama.cpp `llama-cli` build, consistent with existing subprocess flags in `local_instruct_model.rs:35`.
- The bundled-assets root path is communicated from electron-main to core via a single environment variable, consistent with the existing `BINARY_ENV` / `MODEL_ENV` pattern.
- No default GGUF model will be selected in this wave (as required by the handoff).

**Unresolved questions:**
1. Which specific Whisper model is being bundled? `base.en` is the default but `small.en` would improve quality at 3× the size. This affects the `extraResources` entry size and the user experience on slow storage.
2. What is the install size budget? A bundled `base.en` (147 MB) + future LLM GGUF (minimum 2 GB for a useful model) will significantly increase installer size and may affect distribution platform constraints.
3. Does the `models_root_for_core()` path (user data directory) or a resources-adjacent directory hold the bundled whisper model? If it is user data, it survives uninstall, which has implications for repair; if it is resources-adjacent, it is overwritten on reinstall, which is cleaner for repair.
4. How should the bundled-asset root env var be named consistently with `BINARY_ENV` / `MODEL_ENV` — `CANDOR_AI_BUNDLE_ROOT`?
5. For macOS, the `binaries` array in `electron-builder.v3.yml` must include the LLM runner for hardened-runtime signing. Where does this path live relative to the resources directory?

---

## 5. Failure Modes

### Correctness
- **Fingerprint-only LLM verification.** `asset_state()` in `local_instruct_assets.rs:422` checks size + mtime, not a live SHA-256 re-hash. APFS preserves mtime across file copies, so a corrupted-but-same-size file can pass the fingerprint check. For bundled assets, first-use verification should always re-hash.
- **`extract_llama_generated_output` boundary fragility.** `LLAMA_OUTPUT_BOUNDARY` (`local_instruct_model.rs:38`) uses `rfind`, which is correct for repeated markers; however, if a future llama.cpp version changes its output format, the boundary may not appear and the entire raw output (including internal llama.cpp banners that contain paths) would be returned. The path-exposure check would catch this but would silently discard the entire generation, returning an error rather than an empty response. This is the safe failure mode, but it is silent to diagnostics.
- **`ground_model_output` token threshold.** A claim requires ≥2 grounding tokens at `local_instruct_model.rs:1289`. Very short transcript segments (single-word speaker labels, timestamps) will never ground any claim, silently removing content. With a bundled default model that may produce shorter outputs on low-end hardware, this threshold may need tuning.

### Security
- **`sensitive_path_kind` false negative on partial paths.** The check (`local_instruct_model.rs:809`) uses `text.contains(path.to_string_lossy())`. On macOS, the bundled resources path (`/Applications/Candor.app/Contents/Resources/`) shares a prefix with many system paths. If the model generates text about "applications" or "resources", there is no risk; but if a future LLM were to hallucinate a path that is a suffix of the real path, the check would not catch it. This is currently acceptable for the user-import flow; for a bundled path, the risk surface is smaller but the same logic applies.
- **`import_from_path` still accepts renderer-originated `source_path`.** While the current code normalises and canonicalises the path, a renderer-compromised flow could still point this at an arbitrary filesystem location. This is the user-import flow and should not be extended to the bundled flow.

### Packaging
- **`electron-builder.v3.yml` `binaries` on macOS.** The current `binaries` list includes only `candor-core`. The LLM runner must be added here for hardened-runtime signing or it will be rejected by Gatekeeper on macOS 13+. If it is not in `binaries`, it cannot be `execve()`'d.
- **Missing extraResources for whisper model.** The model file is not in `extraResources`, so it is not packaged. The `from_sources` flow will find no managed manifest and no env var, and will report the AI feature as unavailable rather than as bundled-ready.
- **SBOM bundled entries.** Until bundled binary and model entries are added, supply-chain reviewers cannot verify what is being shipped.

### Data Safety
- **Repair does not delete recordings.** The existing architecture fully separates the `recording_store` root from the `models_root_for_core` and the `instruct_assets_root`. A corrupted AI bundle cannot cause recording data loss through the current code paths. This invariant must be preserved when adding the bundled-asset root.
- **`startup_recovery` on corrupted manifest.** If the bundled manifest is corrupt, `read_manifest` returns an `InstructAssetError` and `load_runtime_config` returns a default config with all paths as `None`. This means AI features degrade gracefully. Recording continues. This is the correct behaviour.

---

## 6. Focused Tests and Acceptance Checks

These tests define the acceptance boundary for the source implementation wave. None of them require real model files.

```
bundled_manifest_bundled_flag_cannot_be_set_by_write_manifest
bundled_asset_locator_resolves_resources_relative_path_without_env_leak
bundled_whisper_model_missing_degrades_to_ai_disabled_not_recording_error
bundled_instruct_assets_corrupted_fingerprint_triggers_reverification
dev_fixture_manifest_reports_fixture_mode_true_in_rpc_response
sbom_includes_bundled_asset_package_entry_for_whisper_model
packaging_script_fails_if_bundled_file_hash_does_not_match_rust_constant
rpc_bundled_assets_status_contains_no_raw_paths
repair_path_is_reinstall_not_download
model_manager_default_hash_is_not_zero_when_env_var_is_unset
```

Acceptance checks that require real files (deferred to next wave):
```
clean_machine_offline_install_whisper_transcribes_without_network
bundled_whisper_model_hash_matches_cargo_constant_on_signed_installer
llm_runner_passes_macos_gatekeeper_with_hardened_runtime
180_minute_session_transcription_quality_meets_baseline
```

---

## 7. Conservative Completion Boundary for This Source Wave

The following is achievable in the current wave without real binary files, hardware testing, or licensing decisions:

**In scope:**
- `AssetManifest.bundled` field + guard against `write_manifest` setting it `true`
- `load_bundled_runtime_config()` resolver and `BundledAssetSource` in `from_sources()`
- `CANDOR_AI_BUNDLE_ROOT` env var wiring in electron-main → core spawn
- `ai.bundledAssetsStatus` RPC method (returns `available`/`verified`, no paths)
- `window.ai.bundledAssetsStatus()` preload method
- `electron-builder.v3.yml` `extraResources` stubs (pointing to a build-time location; can be empty until CI places files)
- Pre-package SHA-256 verification build script (validates that the file at the extraResources source path matches the Rust constant; fails build if file is absent or hash mismatches)
- SBOM structure for bundled assets (with `downloadLocation: NOASSERTION` and `licenseConcluded: NOASSERTION` until real files and licenses are confirmed)
- Fixture-mode guard and `fixtureMode: true` RPC field
- UI state bifurcation: `bundled-available` vs `user-import-required` (without surfacing paths, GGUF terminology, or runner terminology)
- All required tests listed above

**Out of scope (explicitly blocked):**
- Selecting, licensing, or packaging a default GGUF model
- Selecting, signing, or packaging the LLM runner binary for any platform
- macOS notarization pass
- Clean-machine offline install test
- Hardware-tier benchmarks
- Any network path or updater

---

## Plan Verdict

**The source-level architecture is sound and the foundations are real.** The hash-verification discipline, path-opacity protocol, scheduler serialisation, and data-safety separation are all correctly implemented. The branch name describes the goal, not the current state: no bundled assets are packaged yet, the bundled-asset manifest source type does not exist, and the SBOM is missing bundled entries.

**The plan is viable in one focused implementation wave** if scoped as above. The critical path is: add the bundled-source resolver in Rust → wire the bundled root env var in electron-main → add extraResources stubs to the build config → add the pre-package verification script → add SBOM structure. All of this can be done and tested against fixture files before any real binary or model files exist.

**Do not** claim release readiness, select a default LLM, insert placeholder hashes, or mark bundled assets as verified until the gates in section 5 are independently cleared with real files on clean machines.
