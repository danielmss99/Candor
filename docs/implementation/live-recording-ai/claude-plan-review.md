I now have everything I need. Here is the complete review.

---

## Review: Recording Timer Fix and Development AI Bundle Installation

### 1. Refined Implementation Plan

#### Bug 1 — Recording timer stuck at zero

**Root cause (confirmed by code).**
`CaptureManager::status()` serializes `startedAtMs` (`capture_service.rs:221`) but never computes or includes `durationMs`. The renderer reads `activeSession.durationMs` at `AppRouteOutlet.tsx:162`, finds `undefined`, and `asNumber` coerces that to `0`.

**Required change — Rust (`capture_service.rs:status`).**
Inside the `active` block, add one line before the `json!` macro:

```rust
let duration_ms = now_ms().saturating_sub(session.started_at_ms) as u64;
```

Then include `"durationMs": duration_ms` in the `activeSession` JSON object. `started_at_ms` is a `u128`; the subtraction can wrap on a clock jump, so `saturating_sub` is correct. The result should be `u64` to match how all other `durationMs` fields are typed (`integer` in the schema).

**Schema validation — Electron (`runtime-schema.ts`).**
The `capture-session-or-null` FieldRule only validates `recordingId`. The Electron schema passes `activeSession` as-is to the renderer. No change is required here for the timer to work, but if the operation registry ever tightens `capture-session-or-null` to list required fields, `durationMs` must be listed. Leave a comment or issue noting this gap.

**Renderer — no change needed.** `AppRouteOutlet.tsx:162` already reads `durationMs` and `asNumber` handles numbers correctly. The one-second polling via `capture.getStatus()` is already wired.

**Required Rust test.**
```rust
#[test]
fn active_session_status_includes_monotonic_duration_ms() {
    // Construct a CaptureSession with a started_at_ms 500ms in the past.
    // Call status(). Assert activeSession["durationMs"] >= 500.
    // Call status() again. Assert second duration >= first duration.
}
```
The existing tests construct `CaptureSession` directly (see line 1832), so the same pattern applies.

---

#### Bug 2 — AI bundle reports LLM not installed

**Root cause (confirmed by code).**
`BundledManifest.assets` is empty. `bundled_ai_assets.rs:347–366` returns `state: "no-default-selected"` when `release_ready: false` and assets are empty, which is correct sentinel behavior — but with no assets installed there is nothing for the verifier to find.

**Required: operator install script** (Node or PowerShell, outside the Electron/Rust process, never imported at runtime).

Step-by-step, in order:

1. **Acknowledge flag** — abort unless `--i-accept-dev-installation` is passed. Print a clear warning that this is not a release build.
2. **Download** each asset to a `.part` file in a temp directory under `build/ai-bundle/`. Use `https:` only. Support resumable downloads (check `Content-Length`, resume from offset if `.part` exists and is smaller). Log progress in bytes.
3. **Byte check** — verify `.part` file length matches the pinned exact byte count before SHA-256.
4. **SHA-256 check** — stream-hash the `.part` file; fail loudly if it does not match the pin.
5. **Atomic promotion** — `fs.rename(partPath, finalPath)` only after both checks pass. If the rename fails (e.g., cross-device), copy then delete.
6. **Llama.cpp archive** — download the pinned Windows CPU x64 zip. Verify bytes and SHA-256. Extract only `llama-cli.exe` and the required DLLs (at minimum `ggml.dll`, `llama.dll`; verify the exact list against the b9637 archive contents before hardcoding). Write them to `build/ai-bundle/runtime/`.
7. **License and model-card notices** — download upstream LICENSE and model card files for each asset. Store under `build/ai-bundle/notices/`. These are required for `BundledAssetRecord.license_file` and `.model_card` to pass `inspect_asset`.
8. **Manifest generation** — write `build/ai-bundle/manifest.json` with:
   - `manifestVersion: 1`
   - `releaseReady: false`
   - `fixture: false`
   - `selectionStatus: "dev-selected"` (a non-fixture, non-release sentinel that passes the `trim().is_empty()` check)
   - `repairPolicy: "signed-installer-only"`
   - All downloaded assets with exact `sha256`, `bytes`, `relativePath`, `licenseFile`, `modelCard`, `redistributionApproved: true`, `revision` (the git tag or commit), `sourceUrl` (the HTTPS download URL).
   - Use `large-v3-turbo` as the primary speech model (`modelId: "large-v3-turbo"`) and `small` as a second entry with a different `id` so the duplicate-selector check (`bundled_ai_assets.rs:393–397`) does not fire. Only one speech model can match a given `capability:kind:modelId` selector.
   - One language runtime (the llama.cpp exe) and one language model (Qwen3-4B Q4_K_M).
9. **Verify before exit** — call the existing `BundledAiAssets::with_root(…).status()` logic (or a thin JS wrapper that reads the manifest and stat-checks the files) to confirm `state === "ready"` before reporting success.
10. **Atomicity on failure** — if any download or check fails, leave the previous verified bundle intact. Write to a staging directory and swap only after full verification.

---

### 2. Required vs Optional

| Item | Required |
|---|---|
| Add `durationMs` to `CaptureManager::status()` | Yes — the timer is broken without it |
| Rust test for monotonic `durationMs` | Yes — the proposal requires it |
| Operator install script with `--acknowledge` flag | Yes — the only safe way to populate the dev bundle |
| Byte-exact + SHA-256 checks before promotion | Yes — non-negotiable integrity constraint |
| Atomic promotion via `.part` → rename | Yes — partial files must never replace verified ones |
| Per-asset license and model-card notice files | Yes — `inspect_asset` fails `BUNDLED_AI_NOTICE_MISSING` without them |
| `selectionStatus: "dev-selected"` (not `"fixture-selected"`) | Yes — `fixture: false` is required; a fixture manifest would set `fixture: true`, which must not be `release_ready: true` |
| Verify bundle state at end of install script | Yes — proves the manifest is accepted by the same verifier the app uses |
| Two speech model entries (turbo + small) | Recommended but one is sufficient for dev; turbo alone satisfies `speech` capability |
| Resumable download | Recommended — large-v3-turbo is ~1.5 GB; a non-resumable download on a slow connection will frustrate developers |
| Progress logging | Recommended |
| Stage-and-swap atomicity for the whole bundle | Recommended — protects the previous verified bundle from a mid-install failure |
| `package_profile` field in manifest | Optional — can be `null`/omitted; the validator allows it |

---

### 3. Security and Data-Safety Failure Modes

**Failure modes in the timer fix.**

- **Clock skew at session start.** `now_ms()` uses `SystemTime::now()`. If the system clock steps backward during recording (NTP correction, DST), `saturating_sub` returns `0` rather than a negative or wrapped value. This is correct but will freeze the UI display until the clock catches up. Not a security issue; acceptable for a dev build.
- **u128 → u64 truncation.** A recording longer than ~585 million years truncates silently. Safe to ignore.
- **Race between `started_at_ms` capture and `status()` call.** `started_at_ms` is set after the `ready_rx.recv_timeout` (line 337). There is a tiny window where `active` is `Some` but `started_at_ms` was computed a few milliseconds before the session is exposed. `duration_ms` will be slightly higher than real elapsed time. Acceptable.

**Failure modes in the install script.**

- **TOCTOU on `.part` file.** Another process replacing the `.part` file between the SHA-256 check and the `rename` call would promote a bad file. Since this is a developer-only operator script run on a trusted machine, the risk is acceptable. Document it.
- **ZIP traversal in the llama.cpp archive.** Extracting a ZIP without checking that all entries are contained within the target directory can write files to arbitrary paths. The script must canonicalize each entry path and reject any entry whose canonical path does not start with the target directory. This is a concrete, exploitable risk.
- **HTTP downgrade.** The script must reject any HTTP redirect that downgrades to a plain `http://` URL. Node's `https.get` does not follow redirects by default; if the script adds redirect-following, it must re-verify the protocol on each hop.
- **Hash length extension / prefix collision.** SHA-256 is used, which is not vulnerable to length extension. Acceptable.
- **Manifest written before all assets are verified.** If the script writes the manifest first and then a subsequent asset check fails, the verifier will find a manifest pointing to a missing or corrupt file and report `state: "missing"` or `state: "corrupt"`. This is safe (it fails closed) but confusing. Write the manifest last, after all assets are promoted.
- **`redistributionApproved: true` in a developer manifest.** This field is a self-attestation in the manifest. The verifier trusts it (`record_is_valid` at line 593 checks `redistribution_approved`). The install script must only set it to `true` for assets whose actual upstream license permits redistribution. The Whisper models (MIT), llama.cpp (MIT), and Qwen3-4B (Qwen License 1.1 — check redistribution terms carefully; it permits research/non-commercial use but has restrictions on competing products) all need individual review before `redistributionApproved: true` is set.
- **Path containment on Windows.** `valid_relative_path` rejects backslashes (`bundled_ai_assets.rs:651`). The install script must write all `relativePath` fields with forward slashes, even on Windows.
- **`fixture: true` would bypass release verification but so does `fixture: false, releaseReady: false`.** The distinction matters: a fixture manifest is explicitly test-only and both the code and the tests treat it that way. A non-fixture, non-release-ready manifest is what the proposal requires and what the existing test `non_ready_empty_manifest_reports_no_default_without_paths` exercises. Codex must not set `fixture: true` on the dev manifest — it would be technically accepted but semantically incorrect and could confuse future reviewers.

---

### 4. Missing Tests and Acceptance Checks

**Missing Rust tests.**
- `active_session_status_includes_monotonic_duration_ms` (described above) — required by the proposal.
- A test that `status()` returns `durationMs: 0` when there is no active session (i.e., `activeSession` is null) so that the renderer's `asNumber(null)` path is exercised.

**Missing TypeScript/Electron tests.**
- `runtime-schema.ts` has no test that a `capture-session-or-null` containing `durationMs: 0` passes validation. The FieldRule only checks `recordingId`. If `durationMs` is ever added to the rule, this needs a regression test.
- An Electron-layer integration test that polls `capture.status` during a synthetic capture and asserts `activeSession.durationMs` increases each poll. The existing `candor-electron.spec.ts` and `product-surface.test.tsx` are good places.

**Missing install-script acceptance checks.**
The proposal's acceptance checks are behaviorally correct but do not spell out how to verify them in CI. Add:
- A post-install dry-run that loads the manifest and calls the same JSON schema validation logic used by `BundledAiAssets` without actually running inference. This is the "development bundle verifier accepts installed files in non-release mode" check.
- An assertion that `bundledAiStatus.releaseReady === false` after install — Codex should ensure this appears in the product-surface smoke or a dedicated test.
- An assertion that strict release verification (`releaseReady: true`) still fails on the dev bundle. A test that constructs a `BundledManifest` with `releaseReady: true` and the dev manifest's `fixture: false, selectionStatus: "dev-selected"` and verifies `status.ready === false, status.terminology.ready === false` (because the dev manifest does not include terminology assets, which are required for release). This already flows from the existing logic but should be an explicit test.

**Missing end-to-end checks.**
- A smoke test that Whisper transcribes a short reference WAV (e.g., the existing proof recording) and produces a non-empty segment list. Without this, "Whisper can transcribe a local test recording" is untested.
- A smoke test that llama.cpp produces at least one token of output from Qwen3-4B on a trivial prompt. Without this, "Qwen can produce one local recap" is untested.

---

### 5. Concern: Non-Release Development Manifest with Verified Files

The design is sound, and the existing `bundled_ai_assets.rs` already handles this case correctly. Specifically:

- `release_ready: false` means `terminology` assets are not required for `status.ready`.
- The `no-default-selected` sentinel (empty assets) is distinct from `dev-selected` (populated assets). The `repairRequired` flag (`bundled_ai_assets.rs:201–204`) is `false` when `selection_status == "no-default-selected"`, so a fresh install without the dev bundle will not prompt for repair.
- A non-release manifest whose files all pass byte and SHA-256 verification will report `state: "ready", ready: true` — exactly what the development workflow needs.

**The residual concern** is divergence drift: the dev manifest pins specific file sizes and hashes. If upstream releases a new llama.cpp tag or the model files change, the pinned hashes become stale. The install script should print a clear warning that the hashes are pinned and link to the source of truth (the proposal document or a lock file in the repo). When the dev manifest is regenerated, all previously computed hashes must be re-verified from scratch.

**One concrete risk:** the install script generates the manifest. If it writes `releaseReady: false` but a future developer edits the manifest by hand and sets `releaseReady: true`, the verifier will demand terminology assets and fail. This is fail-closed, which is correct. However, the manifest should include a human-readable comment (or a top-level `"_warning"` field, which `deny_unknown_fields` would reject — so do not use that). Instead, document this risk in the install script's header and in the repo's development setup guide.

**One strictly important invariant** to verify before Codex writes the manifest: the `selectors` deduplication check in `inspect()` at `bundled_ai_assets.rs:393–396` will reject a manifest that lists both `large-v3-turbo` and `small` under the same `capability:kind:modelId` key. Since `modelId` is part of the selector for `kind == "model"`, two speech models with different `modelId` values produce distinct selectors (`speech:model:large-v3-turbo` and `speech:model:whisper-small`). They will coexist. But only the first one found by `verified_asset("speech", "model", model_id)` will be used, because that method finds the first match. The transcription service must pass the correct `model_id` string when requesting the asset, or it will not find the file. Codex should confirm that the `model_id` strings in the manifest exactly match what `TranscriptionService` or `transcription_quality.rs` passes to `speech_model(model_id)`.

---

**Summary.** Both fixes are architecturally correct and safe. The timer fix is a one-line Rust addition with no security surface. The dev bundle installer is the more complex piece: the ZIP traversal check and the ordering of manifest write vs asset promotion are the two places most likely to introduce a subtle bug. All other concerns are documentation and test gaps rather than design flaws.
