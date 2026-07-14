All 8 verified candidates are CONFIRMED or PLAUSIBLE. Now I can produce the ranked final output.

```json
[
  {
    "file": "crates/candor-core/src/local_instruct_model.rs",
    "line": 611,
    "summary": "Meeting transcript prompt file is created in env::temp_dir() with default OS permissions and lives there for up to 45 seconds while the LLM child process runs.",
    "failure_scenario": "On Linux, env::temp_dir() returns /tmp (mode 1777, world-readable). fs::write at line 615 creates the file with the process umask, typically 0644. Any co-tenant process can stat /tmp for candor-local-instruct-* and read the full meeting transcript ΓÇö including speaker names, quoted text, and any sensitive content ΓÇö before fs::remove_file is called at line 586 of run_prompt_with_config. The window is bounded by LOCAL_LLM_TIMEOUT_MS = 45,000 ms. No existing test covers multi-user temp-dir access."
  },
  {
    "file": "crates/candor-core/src/model_manager.rs",
    "line": 306,
    "summary": "bundled_assets_status patches speech.ready=false on trust failure but leaves language.ready and language.state unchanged, so the response advertises language capability as ready inside a bundle flagged corrupt.",
    "failure_scenario": "If the bundled speech model passes BundledAiAssets::status() hash verification but fails the compiled trust anchor check in bundled_speech_trust_failure, bundled_assets_status writes speech.ready=false and root state=\"corrupt\" but never modifies the language sub-object. The renderer's parseBundledAiStatus at contracts.ts:504 checks false !== (false && true) = false !== false and does not throw. The returned BundledAiStatus has ready=false, speech.ready=false, language.ready=true. Any UI path gating on bundledAiStatus.language.ready (or any future code path doing so) would enable LLM-backed recap and ask operations on a bundle the system has explicitly flagged as corrupt and untrusted."
  },
  {
    "file": "crates/candor-core/src/model_manager.rs",
    "line": 395,
    "summary": "verify_local and verified_model_path give contradictory answers about bundled fallback availability for an installed-but-corrupt model.",
    "failure_scenario": "A user installs model base.en. The file is later partially overwritten, causing a SHA-256 mismatch. The renderer calls models.verifyLocal: verify_local at line 395 checks managed.bytes > 0 (true), returns immediately with {installed:true, verified:false, failureCode:\"MODEL_HASH_MISMATCH\"} ΓÇö no mention of any bundled fallback. The user is told to re-import the model. The user then clicks Transcribe: transcription_service.rs calls verified_model_path at line 725, which checks verification.verified=false and falls through to bundled_assets.speech_model(), finds the bundled asset, and succeeds. Transcription completes using the bundled model. The UI reports a broken model requiring user action while the runtime silently uses a different path; the corrupted file is never flagged for removal."
  },
  {
    "file": "v3/renderer/src/features/startup/useRuntimeStatus.ts",
    "line": 231,
    "summary": "refreshModelsAndAi swallows all bundledAiStatus parse errors with .catch(), unlike loadDiagnostics which re-throws so the failure appears in diagnosticFailures.",
    "failure_scenario": "After initial load, a partial Candor update corrupts the bundled manifest or an asset. The user navigates to Settings and triggers a refresh: refreshModelsAndAi runs, client.bundledAiStatus() throws ProtocolValidationError, the .catch returns UNAVAILABLE_BUNDLED_AI_STATUS, setBundledAiStatus sets state=\"unavailable\". diagnosticFailures is never updated ΓÇö it retains its value from loadDiagnostics at startup. The UI shows the AI panel as unavailable with failureCode: \"BUNDLED_AI_STATUS_UNAVAILABLE\" but no alert fires and no repair action (\"reinstall-candor\") is surfaced. The user has no actionable path to recover the feature."
  },
  {
    "file": "scripts/spec3-verify-ai-bundle.mjs",
    "line": 468,
    "summary": "verifySelectedAssetBindings ΓÇö the only function that cross-checks manifest sha256 values against model-lock.json expectedSha256 ΓÇö is gated on requireReady and never runs in non-strict mode.",
    "failure_scenario": "A developer publishes a source-interface bundle by running the script without --require-ready. model-lock.json has expectedSha256: \"aaa...\" for the speech model; manifest.json has sha256: \"bbb...\" for the same asset. verifyBundle checks the file on disk against the manifest sha256 (passes). verifyDecisionLocks checks that model-lock candidates have well-formed hashes (passes). verifySelectedAssetBindings is never called (inside if (requireReady) at line 468). The non-strict proof artifact is written as ok: true. The digest inconsistency between the operator's audited model-lock and the bundled manifest goes undetected until --require-ready is run at release time, potentially after the inconsistency has propagated."
  },
  {
    "file": "crates/candor-core/src/local_instruct_model.rs",
    "line": 165,
    "summary": "from_sources calls bundled_assets.status() and bundled_assets.language_config() sequentially, triggering two full inspect() passes ΓÇö manifest read, JSON parse, record validation, and asset fingerprinting ΓÇö on every request.",
    "failure_scenario": "Every call to LocalInstructModelService::status, recap, or ask calls self.config() at lines 244/326, which calls from_sources(), which calls bundled_assets.status() (ΓåÆ inspect()) at line 165 and bundled_assets.language_config() (ΓåÆ inspect() via verified_asset) at line 166. The digest_cache caches per-file SHA-256 values but does not cache the manifest parse or record validation. On a cold cache (first request, or after any cache miss), both calls read manifest.json, deserialize it, validate all records, and check each asset file's metadata. Across the two calls the bundle can be in different states ΓÇö if an asset is updated between the two inspections, status() sees the old hash and language_config() sees the new hash, producing a config whose binary_fingerprint_verified flag and binary_path come from inconsistent snapshots."
  },
  {
    "file": "crates/candor-core/src/bundled_ai_assets.rs",
    "line": 399,
    "summary": "inspect_asset checks for symlinks and containment via contained_regular_file at line 399, then hashes the returned canonical path at line 422 with no re-validation, leaving a TOCTOU window.",
    "failure_scenario": "contained_regular_file confirms the canonical path at line 399: symlink_metadata sees a regular file, canonicalize returns a path inside canonical_root. Between line 399 and the sha256_file call at line 456, an attacker with write access to the bundle directory (or the same user in a dev or staging environment where build/ai-bundle is writable) atomically replaces the regular file at the canonical path with attacker-controlled content. The subsequent cached_sha256 hashes the new content; if the attacker pre-computed content whose SHA-256 matches record.sha256, the VerifiedBundledAsset is produced with a path pointing to the attacker's content. This canonical path is later passed to Command::new in run_llama_command. Mitigated in production where process.resourcesPath/ai is read-only, but exploitable in dev builds."
  },
  {
    "file": "crates/candor-core/src/bundled_ai_assets.rs",
    "line": 650,
    "summary": "sha256_file is independently defined in three modules with different buffer sizes (1 MiB vs 64 KiB), divergent error types, and no shared implementation, creating a maintenance split-brain risk.",
    "failure_scenario": "bundled_ai_assets.rs uses a 1 MiB read buffer; model_manager.rs and local_instruct_model.rs use 64 KiB. A correctness patch applied to one copy ΓÇö for example, adding O_NOFOLLOW to guard against a symlink race between file open and read, or improving partial-read error handling ΓÇö is not applied to the others. The 64 KiB copies issue ~16├ù more read syscalls than the 1 MiB copy when hashing a 150 MB Whisper model, contributing to the double-inspect cost identified above. There is no test that verifies all three produce identical output for the same file."
  },
  {
    "file": "crates/candor-core/src/local_instruct_model.rs",
    "line": 862,
    "summary": "sensitive_path_kind checks whether the full absolute path string appears in the model output via substring match; a model echoing only the filename component (e.g. from GGUF metadata) evades the check.",
    "failure_scenario": "config.model_path is /home/alice/.local/share/candor/models/ggml-base.en.bin. sensitive_path_kind converts this to the string /home/alice/.local/share/candor/models/ggml-base.en.bin and calls text.contains(...). The model, when asked \"What model are you?\", outputs \"I am ggml-base.en.bin\" ΓÇö only the filename. contains() is false; the path guard does not fire. The filename, which encodes the model variant and reveals that the user has a specific Whisper model installed, reaches the renderer and is stored in meeting notes or citations. rawPathExposed: false is reported in the response despite partial filesystem structure disclosure."
  },
  {
    "file": "v3/renderer/src/features/local-ai/useLocalAiWorkspace.ts",
    "line": 199,
    "summary": "transcribe() forwards the explicitly-selected modelId to Rust without checking models[selectedModel].verified, so a renderer-confirmed integrity failure does not produce an immediate client-side rejection.",
    "failure_scenario": "User explicitly selects large-v3 (setting explicitModelSelection.current=true). A subsequent verifyModel call populates modelStatus with verified:false for large-v3. The user clicks Transcribe: explicitModelSelection.current is still true so modelId:\"large-v3\" is passed to api.transcript.start without consulting the verified field from the already-fetched modelStatus. validate-core-input.ts accepts the syntactically valid modelId. The IPC call reaches Rust, which runs verified_model_path, detects the hash mismatch, and rejects the job. The failure surfaces as a job-level error (model hash mismatch) rather than an immediate pre-submission rejection in the UI, which would be the expected defensive behavior at this boundary."
  }
]
```

---

**Separate from the JSON ΓÇö review items that are NOT observed defects:**

These are the intentional design decisions or deferred states that the review prompt explicitly asks not to treat as defects:

- **Intentional strict-verifier failure**: `spec3-verify-ai-bundle.mjs --require-ready` fails because no real speech/language models are staged in `build/ai-bundle`. The source manifest has `releaseReady: false` and empty assets. This is correct.
- **Unsigned artifacts and absent real models**: The `manifest.json` is a source-interface non-ready manifest. `bundledDefaultModel` falls back to `DEFAULT_MODEL_ID = "base.en"` (manual install path). Correct.
- **Compile-time hash constants**: The nine `HASH_*` constants in `model_manager.rs` are the expected Whisper model digests. These are the compiled trust anchors. The `None => "..."` fallback values are the actual OpenAI Whisper GGML release hashes. This is the intended design.
- **No tests for the real-asset path**: Tests use fixtures and synthetic proofs. The absence of tests against real model binaries is documented as intentional.

**Residual risks not covered by the 10 findings above:**

1. **`binary_fingerprint_verified=true` elides live re-hash before spawn**: The bundled LLM binary is hashed once (during `language_config()`) and the result is cached in `LocalInstructModelConfig`. The same `config` snapshot is used for both the `ensure_ready` gate and the `Command::new` spawn. A race between the hash check and spawn requires attacker write access to the canonical binary path ΓÇö low risk given the production bundle root is read-only, but inherent to any filesystem-based execution model.

2. **LLM binary/model lack compiled-in trust anchors**: Only the Whisper speech model has a compiled-in digest (`HASH_*` constants checked by `bundled_model_is_trusted`). The LLM binary and GGUF model are verified against manifest digests only. If the bundle root is writable, an attacker could substitute a different LLM binary and update the manifest. This is an architectural decision (spec calls out "compiled trust anchor for the selected speech model" only), not an oversight.

3. **Cross-OS physical testing not performed**: The Windows-specific `.exe` extension check in `runtime_is_executable` and the NTFS junction gap in `spec3-verify-ai-bundle.mjs` (the canonical backstop via `realpathSync.native` is the last line of defense) have not been physically exercised. Low risk for the source-interface state.
