I now have everything I need to write the complete adversarial review.

---

## Parakeet Availability Implementation Review

**Date:** 2026-07-21  
**Reviewer:** Adversarial static review (read-only, no edits)

---

### Verdict Summary

No Critical or High defect was found. All six implementation requirements are met. Two Low defects and two Informational observations follow.

---

## Q1 — Renderer-Controlled Values and Paths

**PASS. Zero renderer-controlled values reach any Parakeet URL, path, member path, native library path, model path, or sherpa provider.**

| Surface | Evidence |
|---|---|
| Download URL | `model-catalog.ts:151` hardcodes the URL. `model-acquisition-service.ts:41-52` `validateDownloadUrl()` rejects any initial URL that differs from `entry.download.url`, and validates every redirect against a frozen `allowedHosts` array. The renderer passes only a `modelId` string. |
| Package directory | `model_manager.rs:1238-1244` `model_file_name()` returns the constant `PARAKEET_PACKAGE_DIRECTORY` for Parakeet. |
| Archive member paths | `parakeet_package.rs:37-94` All member paths are in the static `MEMBER_SPECS` array. No renderer input reaches path construction. |
| Native library path | Linked at compile time via `sherpa-onnx-sys/build.rs`. No runtime path is accepted. |
| Model path at inference | `transcription_service.rs:1542` calls `model_manager.verified_parakeet_package(store)`, which derives the path internally from the store root. |
| Sherpa provider | `transcription_service.rs:1559` hardcodes `Some("cpu".to_string())`. |
| Model type | `transcription_service.rs:1558` hardcodes `Some("nemo_transducer".to_string())`. |

---

## Q2 — Archive Extraction Safety

**PASS. All seven required rejection categories are covered.**

| Category | File:Line | Mechanism |
|---|---|---|
| Windows traversal | `parakeet_package.rs:415-433` | `validate_archive_path()` rejects `..`, `.`, `\`, `:`, `\0`, absolute paths |
| Windows device names | `parakeet_package.rs:435-447` | Checks `CON`, `PRN`, `AUX`, `NUL`, `COM1–COM9`, `LPT1–LPT9` after uppercasing stem |
| Links and symlinks | `parakeet_package.rs:352-358` | Entry type must be `Regular`; anything else is rejected before any write |
| Special entries | Same | Same check; non-file, non-known-directory entries are rejected |
| Duplicate normalized paths | `parakeet_package.rs:333-339` | `HashSet<String>` on lowercased, trailing-slash-stripped paths |
| Unexpected members | `parakeet_package.rs:365-373` | Every file entry must match a `MEMBER_SPECS` element; unexpected names are rejected |
| Entry-count abuse | `parakeet_package.rs:309-320` | `MAX_ARCHIVE_ENTRIES = 16`; any archive with more than 16 entries fails |
| Decompression expansion | `parakeet_package.rs:383-389` | `MAX_DECOMPRESSED_FILE_BYTES = 672_000_000`; total of header-declared sizes must not exceed limit |

**LOW-1 — Decompression bound uses header-declared sizes, not actual bytes extracted**

- `crates/candor-core/src/parakeet_package.rs:383`
- The running total uses `entry.header().size()` (what the archive header claims) rather than a counted byte output from `copy_and_hash`. The `tar` crate bounds reads to the header size, so in practice the limit is correctly enforced. However, this relies on an implicit library guarantee: if a pathological archive reported 0 in every header but contained gigabytes of compressed data, the decompression itself would decompress nothing per entry (reads are bounded by the header size), so no expansion vulnerability exists. The secondary defence (per-member SHA-256 at `parakeet_package.rs:392`) would catch any wrong content regardless.
- **Impact:** None in practice.
- **Fix (optional hardening):** After `copy_and_hash`, assert returned digest size against `spec.bytes` to make the byte bound explicit rather than implicit.

---

## Q3 — Cancellation, Rollback, and Partial-Installation Safety

**PASS. The final package directory is only committed after full verification; cancellation and failure clean up staging.**

The transaction in `model_manager.rs:830-920`:
1. Archive SHA-256 verified (`model_manager.rs:838-862`) before any extraction begins.
2. Extraction goes to `{import_id}.package-staging` (a temporary directory).
3. On extraction failure or cancellation: `fs::remove_dir_all(&staging)` at `model_manager.rs:869`.
4. On replace: old target renamed to `{import_id}.replace-backup` before staging moves to target.
5. If the final rename fails: backup is restored (`model_manager.rs:892-898`).
6. Backup is deleted only after the commit rename succeeds.

Cancellation inside extraction: `parakeet_package.rs:314` checks the `AtomicBool` flag at the start of each archive entry. A cancelled extraction is caught before the manifest is written, before `install_archive` returns success, and before `finish_parakeet_import` reaches the commit rename.

On the TypeScript side, `model-acquisition-service.ts:229-237` calls `models.importAbort` in the catch block, which calls `cleanup_import_files` in Rust and deletes the `.part` file and any staging directory.

**LOW-2 — `write_json_atomic` has a TOCTOU window on Windows**

- `crates/candor-core/src/parakeet_package.rs:766-773`
- Windows cannot rename over an existing file, so the code does `remove_file(&path)` then `rename(temporary, path)`. A process crash between these two operations leaves the install manifest or verify cache missing. The consequence is that the next `verify_package` call falls through to a full member re-hash, not a trust bypass.
- **Impact:** Recovery re-verification, no security effect.
- **Fix:** Not needed. The same pattern is used across other Candor write paths; it is a known Windows limitation.

**INFORMATIONAL-1 — No cancellation check between archive SHA-256 pass and `importFinish.start`**

- `electron/models/model-acquisition-service.ts:214-218`
- After `active.bytesReceived !== entry.bytes || digest.digest("hex") !== entry.expectedSha256` passes at line 214, there is no `if (active.cancelled)` check before line 218's `requireResult(this.core, "models.importFinish.start", ...)`. A cancel signal arriving in this window causes the import to enter the verification queue. The Rust `finish_parakeet_import` checks `archive_digest` and then calls `install_archive` which checks cancellation per entry, so the operation aborts cleanly.
- **Impact:** UX only. A cancelled download may briefly appear as `verification-queued` before the background job is cancelled.
- **Fix:** Add `if (active.cancelled) throw new Error("Model download was canceled.")` after line 214.

---

## Q4 — Verification Cache Integrity

**PASS. The cache cannot be forged to bypass member hashes without write access to both the model files and the cache file.**

The `VerifyCache` in `parakeet_package.rs:655-683` `valid_verify_cache()` requires:
- `archive_sha256.eq_ignore_ascii_case(PARAKEET_ARCHIVE_SHA256)` — compile-time constant
- Per-member: `cached.sha256.eq_ignore_ascii_case(spec.sha256)` — compile-time constant
- Per-member: `metadata.len() == cached.bytes` — current file size
- Per-member: `metadata.modified() == cached.modified_unix_ms` — current file mtime

A forged cache must claim member SHA-256 values that equal the compile-time constants. An attacker who forges both the cache and the model files to pass these checks has effectively installed the correct model files. No renderer-mediated path exists to write the cache.

The `quick_state` path (`parakeet_package.rs:215-247`) returns `verified: false` when the cache is absent, requiring a full re-hash before the model can be used for transcription.

**INFORMATIONAL-2 — `is_windows_device_name` does not cover `CLOCK$` or NTFS metadata names**

- `crates/candor-core/src/parakeet_package.rs:435-447`
- `CLOCK$`, `$Mft`, `$LogFile`, etc. are Windows reserved names not in the check. However, this gap is unreachable in practice: every archive member must match a `MEMBER_SPECS` entry (`parakeet_package.rs:365-373`) before any device-name check is relevant. No `MEMBER_SPECS` entry is a Windows device name.
- **Impact:** None.
- **Fix:** Not needed given the member allowlist as the primary defence.

---

## Q5 — ASR Dispatch Correctness

**PASS. Final transcription dispatches Parakeet to sherpa-onnx CPU inference. Live provisional text uses an explicit language-appropriate Whisper model.**

`transcription_service.rs:854-878`: `execute_local_inner()` checks `model_id == PARAKEET_MODEL_ID` and calls `run_parakeet_track_dispatch()`. All other model IDs go to `run_whisper_track_dispatch()`.

`transcription_service.rs:1479-1511`: `run_parakeet_track_dispatch()` is gated `#[cfg(all(windows, feature = "local-parakeet"))]`. On any other platform or build, it returns `PARAKEET_RUNTIME_UNAVAILABLE`.

`transcription_service.rs:1551-1564`: The sherpa-onnx recognizer is configured with:
- `provider = Some("cpu".to_string())` — hardcoded, not renderer-supplied
- `model_type = Some("nemo_transducer".to_string())` — hardcoded
- `decoding_method = Some("greedy_search".to_string())` — hardcoded

Live Whisper fallback — `transcription_service.rs:647-653` `prepare_live_whisper()`: When `processing_profile.model_id == PARAKEET_MODEL_ID`, the live model is resolved by `live_whisper_fallback_model_id(&profile.transcription_language)` at line 649. This function (`transcription_service.rs:95-101`) returns `"small.en"` for English (exact match or `en-` prefix) or `"small"` for all other languages. The Parakeet model ID is explicitly excluded from `cached_verified_model_path` (`model_manager.rs:1078-1083`), so Parakeet cannot accidentally become the live model.

`transcription_service.rs:103-129` `processing_profile_binding_value()` reports `liveSpeechModelFallbackApplied: true` and the fallback model ID in the capture-time profile snapshot, making the substitution auditable.

---

## Q6 — Selectability and Recommended-Default Reachability

**PASS. Parakeet becomes downloadable, selectable, and the sole recommended default once verified, without touching existing profiles.**

**Downloadable:** `model-acquisition-service.ts:162` gates download on `releaseState === "ready" && entry.download && entry.expectedSha256 && entry.bytes`. The Parakeet entry satisfies all four (`model-catalog.ts:147-158`).

**Recommended default:** `model-acquisition-service.ts:142-145` iterates the catalog and returns the first entry that is `capability === "speech" && defaultEligible && verified`. Parakeet is the only catalog entry with both `capability: "speech"` and `defaultEligible: true` (`model-catalog.ts:135-158`). When verified, it is therefore the sole recommended default. The `useLocalAiWorkspace.ts:294-297` effect propagates this to the selected model whenever `modelCatalog.recommendedDefaultModelId` changes and no explicit selection has been made.

**New custom profiles:** `MeetingProfileManager.tsx:105-118` `parakeetReady` checks `TransparentModel.availability === "installed" && verification === "verified"`. The `profile-parsers.ts:183-184` parser maps boolean `installed`/`verified` from the Rust response to these string fields (`"installed"` / `"verified"`). When Parakeet is ready, `beginCreate()` at line 129 initializes the draft with `speechModelId: "parakeet-tdt-0.6b-v3-int8"`.

**Existing profiles unaffected:** Nothing in the download, verification, or profile-selection paths modifies stored profiles. The Rust `meeting_profiles.rs` profile storage is only written on explicit upsert, delete, or select calls.

**Validation accepts Parakeet:** `meeting_profiles.rs:990-998` `validate_speech_model_id()` explicitly allows `PARAKEET_MODEL_ID`. `meeting_profiles.rs:894-906` `validate_profile()` allows Parakeet as an exception to the tier-model pairing constraint.

---

## Q7 — `/MT` Static Runtime Enforcement

**PASS. The `/MT` requirement is enforced at two independent layers, covering all build types that include `local-parakeet`.**

**Layer 1 — `cargo-with-local-perl.mjs:97-110`:** When `--features local-parakeet` is present on Windows, the script:
1. Checks that no `-crt-static` negation is in existing `CARGO_ENCODED_RUSTFLAGS` or `RUSTFLAGS`.
2. Injects `-Ctarget-feature=+crt-static` into `CARGO_ENCODED_RUSTFLAGS` (preferred) or `RUSTFLAGS`.
3. This covers the release build (`build-release-core.mjs:42-58`), test runs, and all other cargo invocations that go through this wrapper.

**Layer 2 — `sherpa-onnx-sys/build.rs:58-65`:** At compile time, the build script reads `CARGO_CFG_TARGET_FEATURE` (the effective target features, not just flags passed to cargo) and aborts if `crt-static` is absent. This catches any path that bypasses the script wrapper.

**Negation guard:** `cargo-with-local-perl.mjs:100-102` uses the regex `/target-feature=[^\s\u001f]*-crt-static/` to reject any existing flag that would disable static CRT linking.

SQLCipher and Whisper builds are unaffected: they compile before sherpa-onnx-sys runs and do not link against the `/MT` archive.

---

## Q8 — FFI Surface Preservation

**PASS. The vendored patch preserves the official 1.13.4 FFI surface and removes only build-time network access.**

`sherpa-onnx-sys/Cargo.toml` retains:
- `version = "1.13.4"`, `license = "Apache-2.0"`, `links = "sherpa-onnx"`, `repository` — all matching the upstream package
- All `src/` modules unchanged: `offline_asr.rs`, `online_asr.rs`, `audio_tagging.rs`, `kws.rs`, `vad.rs`, `tts.rs`, `resampler.rs`, `speaker_embedding.rs`, `speech_denoiser.rs`, `spoken_language_identification.rs`, `online_punctuation.rs`, `offline_punctuation.rs`, `offline_speaker_diarization.rs`, `wave.rs`, `lib.rs`
- `features`: only `static` (default) and `shared` — same semantics as upstream

Build dependencies (`bzip2`, `sha2`, `tar`) replace the upstream `ureq`-based HTTP download. The vendored `build.rs` verifies the local archive at `SHERPA_ONNX_ARCHIVE_DIR` against a pinned SHA-256 (`d81bd1d25112540862d2387072e76b2b6843ef962918d6b5c7db5a19c6276b4c`), then unpacks and links. No network access occurs at build time.

---

## Q9 — License Attribution and SBOM

**PASS. Attribution is adequate and internally consistent across all surfaces.**

| Surface | Content |
|---|---|
| `THIRD_PARTY_NOTICES.md` | "NVIDIA Parakeet TDT 0.6B V3 by NVIDIA, licensed under CC BY 4.0"; download URL, original model card URL, note that weights are unmodified; sherpa-onnx Apache-2.0; ONNX Runtime MIT |
| `licenses/CC-BY-4.0.txt` | Bundled license text (file confirmed present) |
| `licenses/MPL-2.0.txt` | Bundled (Symphonia) |
| `model-catalog.ts:144` | `licenseExpression: "CC-BY-4.0 AND Apache-2.0 AND MIT"` — correct SPDX composite |
| `LocalModelLibrary.tsx:105-109` | Parakeet card shows: "NVIDIA Parakeet TDT 0.6B V3 by NVIDIA, converted for sherpa-onnx and provided under CC BY 4.0. Runtime notices are included with Candor." |
| `v3-release-sbom.mjs` | Reads `Cargo.lock` and `package-lock.json`; generates SPDX JSON incorporating the Cargo dependency tree |

The SPDX SBOM includes sherpa-onnx-sys (Apache-2.0) via the `crates/candor-core/Cargo.lock` parse path. The model itself (`parakeet-tdt-0.6b-v3-int8`) is not a Cargo package and is handled separately via the `THIRD_PARTY_NOTICES.md` and the `CC-BY-4.0.txt` bundle. This is the correct approach for a user-downloaded artifact.

---

## Q10 — Critical or High Issues Invalidating Claims

**NONE FOUND.**

| Claim | Status |
|---|---|
| Explicitly downloadable from Candor's fixed local-model catalog | CONFIRMED — `releaseState: "ready"` with hardcoded URL, enforced download gate |
| Installed only after exact archive and member verification | CONFIRMED — two-layer hash (outer archive + per-member) in `finish_parakeet_import` |
| Selectable for final transcription | CONFIRMED — `validate_speech_model_id` allows Parakeet; UI gate `parakeetReady` correctly mapped |
| Auto-recommended default without modifying existing profiles | CONFIRMED — sole `defaultEligible` speech model; `recommendedDefaultModelId` propagates only to un-pinned UI state and new profile drafts |
| Dispatched through local sherpa-onnx CPU inference with verified Whisper live fallback | CONFIRMED — explicit dispatch in `execute_local_inner`; CPU provider hardcoded; Parakeet excluded from `cached_verified_model_path` for live path |
| Compatible with local-only, pathless, network-denied Rust core | CONFIRMED — no raw path exposure; `rawPathExposed: false` + `keyMaterialExposedToRenderer: false` on all responses; no network contact from Rust |

---

## Consolidated Finding List

| # | Severity | File | Lines | Issue |
|---|---|---|---|---|
| DEF-1 | Low | `crates/candor-core/src/parakeet_package.rs` | 383–389 | Decompression expansion bound uses header-declared sizes rather than actual extracted byte count; effective due to implicit tar-layer truncation, but not an explicit guarantee |
| DEF-2 | Low | `crates/candor-core/src/parakeet_package.rs` | 766–773 | `write_json_atomic` has a remove-then-rename TOCTOU on Windows; consequence is lost manifest/cache (triggers re-hash), not a security bypass |
| OBS-1 | Informational | `electron/models/model-acquisition-service.ts` | 214–218 | No cancellation check between archive SHA-256 pass and `importFinish.start`; a cancel at this instant causes a brief appearance in `verification-queued` before the job cancels itself in Rust |
| OBS-2 | Informational | `crates/candor-core/src/parakeet_package.rs` | 435–447 | `is_windows_device_name` omits `CLOCK$` and NTFS metadata filenames; cannot be exploited because the member allowlist (`MEMBER_SPECS`) precedes device-name validation |
