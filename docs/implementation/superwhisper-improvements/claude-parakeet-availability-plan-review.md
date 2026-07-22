I've now read all the directly relevant source files. Here is the adversarial review.

---

## Review: Make Parakeet Usable

### 1. Required Changes vs. Optional Improvements

**Required — the plan does not work without these:**

**R1. `normalize_model_id` rejects Parakeet today (model_manager.rs:1027).** The function checks `MODEL_SPECS`, a whisper-only const array. `import_start` calls `model_spec(&model_id)`, which returns `MODEL_ID_INVALID`. The plan says to "extend core import finish" but never names that `import_start` also gates on `model_spec`. Both entry points need dispatch before any import can proceed.

**R2. `import_start` builds a wrong staging path for a package (model_manager.rs:1079–1085).** The staging file is named `ggml-{model_id}.bin.part` — a flat file name designed for Whisper `.bin` files. For Parakeet, the streamed blob is a `tar.bz2` archive. The staging path and manifest file-name convention need a separate package-aware naming scheme; otherwise import_chunk will write archive bytes into a path that looks like a Whisper model.

**R3. `import_finish` dispatches to a single verification path (model_manager.rs:706–785).** It calls `verify_model_path_value` on the `.part` file, which SHA-256-hashes it and compares to a Whisper spec. The plan says to extend this for "this one package kind," but the branching point and the result of the branch (a staged directory, not a file) need explicit design. The current rename target is `model_path_for_store(store, spec.id)`, a flat file path.

**R4. `validate_speech_model_id` hard-blocks Parakeet (meeting_profiles.rs:988–993).** It returns `PARAKEET_RELEASE_GATED` unconditionally. The plan says to permit Parakeet, but it also says Parakeet should only be selectable when "installed and verified." The replacement must be a runtime availability check at profile-upsert time, not merely gate removal. The plan does not specify what that check looks like.

**R5. Profile tier-consistency validation will still reject Parakeet (meeting_profiles.rs:864–893).** Even after R4, `validate_custom_profile_params` checks that the explicit `speech_model_id` matches `model_id_for_profile(capture_source, tier, language)`. Parakeet will never be the output of that function. The validation logic must allow Parakeet as an explicit override that is exempt from the tier-consistency check.

**R6. `prepare_live_whisper` will panic on a Parakeet profile (transcription_service.rs:557–588).** It calls `model_manager.cached_verified_model_path(store, &processing_profile.model_id)`. If the profile's `model_id` is Parakeet, that call hits the same `MODEL_ID_INVALID` path through `model_spec`. This will fail at capture start for any Parakeet profile with `live_transcription: true`. The plan says live transcription stays Whisper, but it does not specify what code resolves the fallback model in this case.

**R7. `bzip2` and `tar` Rust crates are absent from Cargo.toml.** The existing crate list has no tar or bzip2 decoder. `bzip2-sys` compiles libbz2 from C source on Windows, requiring a C compiler at build time. These must be added and tested on Windows x64 MSVC before step 3 is meaningful.

**R8. The execution dispatch branch does not exist (transcription_service.rs:769–829).** `execute_local_inner` unconditionally calls `run_whisper_track`. A model-ID branch must dispatch Parakeet to the sherpa-onnx adapter. The `LocalModelJobKind` enum (used by scheduler) also has no Parakeet variant.

---

**Optional — improvements the plan would benefit from but are not blockers per se:**

- `status()` in `transcription_service.rs` hardcodes `"engine": "whisper-rs"` and `downloadPolicy: "network-download-not-implemented-in-m2"`. These become misleading but do not prevent correctness.
- `with_transparency` in `model_manager.rs` skips unknowns via `model_spec` — Parakeet package entries won't receive hardware/latency metadata in the list_local response, which is cosmetically wrong but not a defect.

---

### 2. Assumptions and Unresolved Questions

**A1. `import_finish` extraction latency.** Decompressing and verifying a 487 MB bzip2 archive synchronously on the `import_finish` RPC path will occupy the candor-core thread for potentially 30–90 seconds on a typical CPU. The plan does not say whether this is a background job (see `background_jobs.rs`) or a blocking call. If blocking, the Electron IPC layer must not time out, and the UI must reflect the extraction state via a separate polling channel, not the existing "verification-queued" pattern from `importFinish.start`.

**A2. Decompressed byte ceiling is unnamed.** The plan requires "a fixed ceiling" but never states it. The 4 ONNX files in the Parakeet V3 archive decompress to roughly 1.1–1.4 GB. Without a stated ceiling the extraction guard cannot be tested. An attacker who replaces the archive (blocked by the outer SHA-256 but relevant for defense-in-depth in the extraction code) could exploit an unspecified ceiling.

**A3. Staging directory on the same volume as the model root.** The plan calls for an atomic rename of the staging directory into the final location. On Windows, `fs::rename` on directories is atomic only when source and destination are on the same volume and the destination does not already exist. The plan does not confirm that staging is under `models_root_for_core()`. If it isn't, `rename` will fail with a cross-device error.

**A4. `SHERPA_ONNX_LIB_DIR` in production build scripts.** The plan says the crate downloads the prebuilt native library at build time when `SHERPA_ONNX_LIB_DIR` is absent. The production build scripts (`electron-builder.v3.yml`) must set this variable to a pre-staged, verified copy of the Windows x64 static-MT artifact (digest `d81bd1d2…`). If the scripts do not, every CI build fetches from GitHub Releases, introducing a supply-chain dependency. The plan mentions the artifact digest but does not specify where in the build pipeline the download and verification happen.

**A5. MSVC runtime compatibility.** The Windows static-MT artifact (`-MT`) links against the static MSVC runtime. If any other Candor Rust dependency uses `/MD` (dynamic runtime), mixing produces UB and often linker errors on Windows. The existing Whisper build uses `whisper-rs-sys` which also links a static C++ runtime on Windows — but that is GGML/ggml-metal and the interaction with sherpa-onnx's ONNX Runtime static link is untested.

**A6. CC-BY-4.0 attribution requirement.** The license expression in the catalog is unresolved (`"runtime review pending"`). CC-BY-4.0 requires that attribution be "reasonably calculated to reach" users of the distribution. The plan says to update `THIRD_PARTY_NOTICES.md`, but it does not say where the attribution string appears in the application UI. If the only attribution is in a notices file that users never see, the license is not satisfied.

---

### 3. Security, Privacy, Licensing, Packaging, and Migration Failure Modes

**Security:**

- **Path traversal coverage on Windows.** The plan correctly calls out rejecting absolute paths and `../`. On Windows, the tar extraction code must also reject members with `..\\` (backslash traversal), device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9` with or without extension), and UNC-style prefixes (`\\?\`, `\\server\`). A naive path-safety check that only blocks `/` separators will pass Windows-specific traversal names through.

- **Duplicate-normalized-name race.** If two tar members normalize to the same destination file name (e.g. one is `encoder.int8.onnx` and another is `ENCODER.INT8.ONNX` on a case-insensitive FS), the second write silently wins. The plan says to reject duplicates, but the check must happen on the normalized final path, not the raw member name, before any write begins.

- **Extraction interleaved with verification.** The plan says to extract to a staging directory, then write a package manifest, then atomically rename. But between extraction and rename, the staging directory is live. A TOCTOU window exists on Windows if the directory is located in a temp path accessible to other processes. Using `models_root_for_core()` directly as the staging parent (with a uuid-suffixed staging name) eliminates this.

- **`sherpa-onnx` build-time artifact.** If `SHERPA_ONNX_LIB_DIR` is not set, `sherpa-onnx-sys` fetches the native library from GitHub Releases at build time. That fetch is unauthenticated and subject to substitution. The build pipeline must verify the SHA-256 of the fetched artifact against the pinned value (`d81bd1d2…`) before linking.

**Privacy:**

- Confirm `SherpaOnnxOfflineRecognizer` (the C API) does not write internal temporary files. The sherpa-onnx C API documentation does not guarantee in-memory-only operation for all platforms. On Windows, ONNX Runtime's EP providers (CPU) should not write temp files, but this has not been tested against the specific INT8 model format. Require an explicit test that verifies no audio-bearing files appear in temp directories during inference.

**Licensing:**

- The Parakeet model weights are under CC-BY-4.0 with NVIDIA as licensor. CC-BY-4.0 allows commercial use and redistribution but requires Attribution. The Attribution must include the title of the work (if supplied), the licensor's name, a copyright notice, a license notice, a disclaimer notice, and a URI if practicable. Candor's THIRD_PARTY_NOTICES must contain all these elements verbatim or by reference, and the application must display them in a location users can reach.
- `sherpa-onnx` transitively links ONNX Runtime (MIT), Kaldi libraries (Apache-2.0), and possibly LAPACK/BLAS on some platforms. The full transitive dependency list for the Windows MT static build must be audited, because static linking means all those licenses apply to the distributed binary.
- `licenseExpression` in the catalog must be a valid SPDX expression after resolution, not prose. `"CC-BY-4.0"` (for the weights) is correct SPDX; the runtime is `"Apache-2.0"`. The catalog field should become `"CC-BY-4.0 AND Apache-2.0"` once resolved.

**Packaging:**

- The Windows x64 MT static artifact is 119 MB. Cargo links it into `candor-core`. The packaged binary will grow substantially. The `electron-builder.v3.yml` build probably has a size limit or code-signing scope that covers the binary — verify neither is broken.
- The `local-parakeet` feature must be disabled in all non-Windows targets unless the plan intends macOS/Linux support, which is not mentioned and the artifact is Windows-only.

**Migration failure modes:**

- Existing stored profiles have `speech_model_id` as a Whisper ID (or empty string, which defaults to `base.en`). These are unaffected. No migration required.
- A profile created with Parakeet after this change, then opened on a build that does not have `local-parakeet` compiled in, must not crash. The profile snapshot's `validate()` method would hit `validate_speech_model_id` with Parakeet ID. If the gate is just removed (returning Ok for Parakeet), that validation passes, and then `execute_local_inner` will fail with `MODEL_ID_INVALID` at model resolution time. That error must produce a user-visible message, not a panic or silent failure.
- If Parakeet is installed and then deleted manually from the model store, a profile referencing it must produce a clear `MODEL_NOT_INSTALLED` error at capture start rather than a silent fall-through to no output.

---

### 4. Specific Tests and Acceptance Checks

**Archive extraction (required, unit):**
- Member with `../escape.txt` → rejected before any write.
- Member with `..\\escape.txt` (Windows backslash) → rejected.
- Member with device name `NUL.txt` → rejected.
- Member with absolute path `/etc/passwd` → rejected.
- Archive with 5 members (one extra beyond the required 4) → rejected.
- Archive whose first member decompresses to exactly the ceiling byte count → accepted; one byte over → rejected.
- Archive with two members that normalize to the same destination name → rejected.
- Symlink member → rejected.
- Hard link member → rejected.

**Verification cache (required, unit):**
- Install Parakeet, verify once (populates cache). Modify one member's content byte. Verify again → cache miss, full re-hash, failure detected.
- Modify one member's size attribute but not mtime → cache miss (size check triggers re-hash).
- All members unchanged → cache hit (no re-hash).

**Profile selection (required, integration):**
- Attempt to set `speech_model_id = "parakeet-tdt-0.6b-v3-int8"` on a profile when Parakeet is not installed → error, not panic.
- Same attempt when Parakeet is installed and verified → succeeds, profile saved.
- Profile with Parakeet ID survives round-trip serialization and `validate()`.

**Transcription dispatch (required, integration):**
- `transcription.runLocal` with a Parakeet profile → `engine` in receipt is `"sherpa-onnx"`, not `"whisper-rs"`.
- `transcription.runLocal` with a Whisper profile on the same recording → `engine` in receipt is `"whisper-rs"`.
- Receipt contains `modelPackageDigest` (the outer archive SHA-256 recorded at import).

**Live transcription guard (required, integration):**
- Profile with `speech_model_id = Parakeet` and `live_transcription = true` → `prepare_live_whisper` either selects the configured Whisper fallback or returns a clear error; it must not attempt to load Parakeet as a Whisper context.

**Cancellation (required, integration):**
- Cancel signal during archive extraction → staging directory is cleaned up, no partial files left in the model root.

**Silence (required, unit):**
- All-zero 16 kHz PCM → Parakeet adapter returns empty text, no panic, no timeout.

**Lineage (required, integration):**
- Raw, normalized, cleaned, and recap fields on a Parakeet-sourced transcript all contain distinct non-null values consistent with the processing chain.

**Proof of real inference (required when artifact available in CI):**
- Download the pinned archive, verify outer SHA-256, extract, run inference on a 5-second clip of known speech, confirm output is non-empty and parseable.

---

### 5. Scope Concerns That Should Block Implementation

**Block 1: License not formally resolved (R3, A6).** The catalog entry still says `"runtime review pending"` for CC-BY-4.0. Shipping a Parakeet download with an unresolved license expression violates the project's own release gate. The implementation cannot be merged until: (a) the attribution text is fixed and (b) the `licenseExpression` field is a valid SPDX string. This is not an implementation concern but a pre-condition for the entire change.

**Block 2: `prepare_live_whisper` fallback is unspecified (R6).** The plan states "live provisional transcription remains Whisper-based" but provides no design for what Whisper model is used when the active profile's `model_id` is Parakeet. Without a specified fallback model ID in the profile or a platform-resolved default, every Parakeet profile with live transcription enabled will fail at capture start. This must be designed and tested before shipping, because capture start failure is a user-visible regression.

**Block 3: `import_finish` extraction is synchronous and latency is unspecified (A1).** If the 487 MB extraction blocks the core RPC thread for 60 seconds, the IPC layer may time out and the user will see an unexplained failure. This needs either: (a) extraction moved to a background job with polling, or (b) a documented timeout extension and a UI state that explains "verifying large package" during the wait. The current code has `background_jobs.rs` and the existing import already uses `models.importFinish.start` implying a queued model — this should be confirmed or corrected before implementation proceeds.

**Block 4: Missing `bzip2`/`tar` crates unverified on Windows MSVC (R7, A5).** The `bzip2` crate on Windows requires that `bzip2-sys` compile libbz2 from C source using the build's C compiler (MSVC cl.exe or MinGW). If Candor's CI uses a build container that does not have cl.exe on PATH, the build will fail. This is an infrastructure prerequisite that must be confirmed before the Cargo.toml additions land.
