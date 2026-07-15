I have all the information needed. Here is the review.

---

## Adversarial Architecture Review: Candor Windows Public Beta Hardening

---

### Change 1 — Remove `managed-local-model` provenance fallback

**Location:** `crates/candor-core/src/background_jobs.rs:389-396`

```rust
fn local_llm_model_id(&self) -> String {
    self.bundled_ai_assets
        .language_config().ok().flatten()
        .and_then(|config| config.model.model_id)
        .unwrap_or_else(|| "managed-local-model".to_string())  // ← target
}
```

**CRITICAL — C1: The fallback is already enforcement-bypassed by a different guard, so removing it in isolation creates a different lie.**

`local_llm_model_id()` is called only after `ensure_ready()` returns `Ok`. `ensure_ready` invokes `status_for_config`, which returns `ready: false` if the bundle assets are unavailable or fail hash check. If `language_config()` returns `None` (no bundled assets), the status is not `ready`, so `ensure_ready` blocks before `local_llm_model_id` is ever called. The path where `local_llm_model_id` would return `"managed-local-model"` is: bundle assets load (`language_config` returns `Some`), but the `BundledLanguageConfig::model.model_id` is `None`.

Looking at `bundled_ai_assets.rs:470-476`, `VerifiedBundledAsset.model_id` is populated from `record.model_id`. `record_is_valid` at line 622-631 requires `kind == "model"` to have a non-empty `model_id`, and `language_config()` calls `verified_asset("language", "model", None)` — so a valid language model asset always has `model_id: Some(...)`. **The fallback string is therefore unreachable today for production bundles.**

The risk is that it is reachable if `language_config` is replaced or this invariant shifts. The plan's goal is sound but the migration contract is:

- **Required:** Add a compile-time-safe guarantee: `local_llm_model_id()` must return `Result<String, JobFailure>` and fail explicitly rather than emitting a sentinel. The call sites at lines 252 and 343 must propagate the error before calling `with_ai_provenance`.
- **Required:** Confirm that `operation-registry.ts:117` would catch the sentinel anyway: `(engine === "local-llm" && (typeof modelId !== "string" || ...))` — a `null` model_id for local-llm already fails the Electron schema. So currently a missing model_id that somehow bypasses the Rust guard would immediately be caught at the Electron layer. Removing the fallback makes the failure happen sooner and with a better message.
- **Risk:** If the job descriptor is persisted and replayed after a bundle change that removes model_id, the replay fails at `ensure_ready`, not at provenance. That's the correct behavior.

**Exact acceptance check:** Add a `#[test]` that constructs a `BundledLanguageConfig` with `model.model_id = None` and verifies that `local_llm_model_id()` returns `Err` (after the signature change), not a fallback string.

---

**MEDIUM — C2: `BundledLanguageConfig` does not expose runtime `model_id` at the Electron layer.**

`local_instruct_model.rs:263-274` returns `BundledLanguageConfig` which includes `VerifiedBundledAsset.sha256` for both runtime and model. But the `ai.bundledAssetsStatus` operation (`operation-registry.ts:286`) only validates `speech`, `language`, `terminology` as opaque objects — it does not enforce that `language.modelId` is present and non-null for release bundles. Plan Change 1 mentions the Electron must also validate model SHA-256 and runtime SHA-256 from `BundledLanguageConfig`, but there is no current enforcement of this at the Electron schema layer.

---

### Change 2 — Fallback preference `ask-first | automatic | never`

**Location:** `crates/candor-core/src/job_manager.rs:110-124`, `crates/candor-core/src/background_jobs.rs:685-693`

**HIGH — C3: `ask-first` is an unimplemented UI protocol, not a preference change.**

`AiFallbackPolicy` is a two-value enum serialized into the encrypted job store via `serde`. Adding a third variant `AskFirst` (or `ask-first`) requires:

1. A new JSONL message type from core → renderer ("should I fall back?") and a response message type. The current protocol has no round-trip blocking messages from core to renderer; the JSONL stdio transport only carries requests from renderer and responses from core.
2. A timeout decision: if the renderer doesn't respond in N ms, does core fall back or fail? Both choices have privacy implications.
3. A UI surface that can interrupt a running background job to ask the user — this means the job must park itself, wait for a channel response, and resume.

This is not a preference field — it is a new asynchronous capability that needs its own SPEC. If the intent is simply to default to "don't fall back silently without telling the user", then the existing `RequireLocalLlm` is already that policy and the plan should say so.

**Required correction:** Clarify whether `ask-first` means "pause the job and present a renderer dialog" (requires protocol work) or "fail the job with a retryable error and let the user restart with explicit fallback" (achievable without protocol changes). The second interpretation maps to `RequireLocalLlm` + a new job error code `LOCAL_LLM_FALLBACK_REQUIRES_USER_CONSENT` that the renderer can handle by showing a choice dialog on retry.

**HIGH — C4: Enum rename breaks the encrypted job store for in-flight jobs.**

`AiFallbackPolicy` is persisted inside `JobDescriptor` in `background-jobs.bin`. Current values on disk are `allow-disclosed` and `require-local-llm`. If the new enum variant names are `ask-first`, `automatic`, `never`, existing stored jobs either fail to deserialize (causing a `Failed` state on recovery) or silently use the new `Default`. The `JOB_STORE_SCHEMA_VERSION` (currently 2) must be bumped to 3 with a migration path. **No migration is described in the plan.**

**Required:** Either (a) add `#[serde(alias = "allow-disclosed")] Automatic` and `#[serde(alias = "require-local-llm")] Never` to preserve existing disk values, or (b) bump `JOB_STORE_SCHEMA_VERSION` and handle the v2 → v3 migration in `upgrade_store` (wherever that lives).

**Acceptance check:** Write a test that loads a v2 job store JSON with `"fallbackPolicy": "allow-disclosed"` and verifies the recovery path maps it to the intended new default behavior without panicking.

---

**MEDIUM — C5: Cancellation, shutdown, and preemption non-fallback guards are already correct.**

`disclosed_fallback_reason` at `background_jobs.rs:685-693` already returns `None` (→ fail without fallback) when `cancelled` is true or `is_non_fallback_error(code)` matches. The cancellation codes `LOCAL_LLM_COMMAND_CANCELLED`, `JOB_CANCELLED`, `APP_SHUTTING_DOWN`, `RECORDING_PRIORITY`, `LOCAL_MODEL_JOB_ACTIVE` are already guarded. The plan's requirement that "cancellation, shutdown, and recording preemption must never fallback" is already implemented. **This portion of Change 2 requires no code change — only a test confirming the invariant.**

---

### Change 3 — Hardened llama.cpp output

**Locations:** `crates/candor-core/src/local_instruct_model.rs:56-66` (`LLAMA_CLI_SUBPROCESS_FLAGS`)

**HIGH — C6: `--json-schema {}` is permissive but replacement schema must be verified against b9637.**

The current flags:
```rust
const LLAMA_CLI_SUBPROCESS_FLAGS: [&str; 9] = [
    "--single-turn", "--simple-io", "--log-disable",
    "--reasoning", "off", "--reasoning-budget", "0",
    "--json-schema", "{}",
];
```

`{}` as a JSON Schema is "accept any JSON value" — it does not constrain to object, does not require any fields. Replacing with an exact schema is correct in principle, but:

- **Known failure:** The evidence says "the real proof currently fails because the model does not return the required JSON object." Adding a strict `--json-schema` at the inference layer constrains generation at the sampling level, which may help token selection but cannot guarantee the model produces all required fields. Small models (Qwen3-4B) frequently truncate JSON mid-object under token budget pressure.
- **Flag compatibility:** `--json-schema` was added to llama.cpp relatively recently. The locked runtime is b9637 (`runtime-lock.json:78`). Verify that b9637 supports `--json-schema` with a complex schema and not just `{}`. An unsupported flag causes a non-zero exit code → `LOCAL_LLM_COMMAND_FAILED`.
- **Schema size:** A fully specified JSON Schema for the grounded output format (with `summary`, `decisions`, `actions`, `risks`, `questions`, `answer` arrays with nested `text`, `sourceIds`, `confidence`) will be several hundred bytes. llama.cpp passes this as a command-line argument. Windows has an 8,191-character command-line limit. This is unlikely to be exceeded but must be verified.

**Required:** Test `--json-schema <exact-schema>` against b9637 on the development machine before the plan is committed to. If b9637 does not support complex schemas, the plan must use a narrower schema (e.g., `{"type":"object"}`) and rely on Rust post-validation, which is already implemented.

**LOW — C7: `--no-conversation` and `--single-turn` interaction.**

`--single-turn` is already present. `--no-conversation` may be redundant with it on b9637, or may not exist as a flag on that build. Check the b9637 `--help` output before adding it. If it conflicts with `--single-turn`, the process exits non-zero silently.

---

### Change 4 — BackgroundActivity.tsx UI ordering

**Location:** `v3/renderer/src/features/jobs/BackgroundActivity.tsx:66-70, 114`

**HIGH — C8: `visible` ordering puts active work before failed tasks.**

```tsx
const visible = [...active, ...failed, ...recentCompleted, ...recentCancelled].slice(0, 8);
```

The slice cuts after 8 items. If there are 8+ active tasks, no failed tasks appear in the panel. Failed tasks need user attention and should always be visible. Required ordering: `[...failed, ...active, ...recentCompleted, ...recentCancelled]`.

**MEDIUM — C9: Cancel All condition includes `cancelling` and `paused` tasks.**

```tsx
{active.length > 1 ? <button ... onClick={onCancelAll}>Cancel all</button> : null}
```

`active` is defined as `jobs.filter((job) => !job.terminal)` which includes `cancelling` (not terminal per `job_manager.rs:98-100`). Cancel All appearing when there are 2 already-cancelling tasks is misleading. The plan correctly specifies the button should only appear for `queued | running | paused` — which is the set of tasks that actually respond to a new cancel signal.

Required fix:
```tsx
const cancellableCount = active.filter(
  (job) => job.state === "queued" || job.state === "running" || job.state === "paused"
).length;
// Replace: active.length > 1
// With: cancellableCount > 1
```

**MEDIUM — C10: Announcement aggregation for simultaneous terminal transitions.**

The current `useEffect` at line 89-101 announces only the first `changed` terminal job per render cycle:
```tsx
const changed = jobs.find((job) => {
  return job.terminal && previous.get(job.jobId) !== job.state;
});
if (!changed) return;
setAnnouncement(terminalTaskAnnouncement(changed));
```

If two jobs complete in the same state update, only one announcement fires. The plan requires aggregating simultaneous terminal announcements. This requires changing `jobs.find` to `jobs.filter`, counting the terminal transitions, and building a combined announcement string (e.g., "2 tasks completed."). The aria `role="status"` element will re-announce on content change, but the 6-second timer resets on the first change only.

**Required:** Change to `filter`, collect all newly-terminal jobs, and produce a compound announcement. The timer should reset from the last announcement.

---

### Change 5 — `cancel_all()` return value and Electron validation

**Location:** `crates/candor-core/src/job_manager.rs:925-962`

**HIGH — C11: `cancel_all()` acts on `cancelling` tasks unnecessarily and its result is not validated in Electron.**

Current filter at line 934:
```rust
for entry in jobs.values_mut().filter(|entry| !entry.state.terminal()) {
```

This includes `Cancelling` tasks, which already have `cancellation.store(true)` set. Calling `cancel_all` on them resets `preempt_requested = false` and `shutdown_pause_requested = false` but otherwise has no additional effect. The plan wants to distinguish between "newly requested" (was queued/running/paused) and "skipped" (was already cancelling).

Required change to return value:
```json
{ "requestedCount": N, "skippedCount": M, "rawPathExposed": false }
```

The Electron `operation-registry.ts` does not appear to validate the `jobs.cancelAll` result schema (it's not in the `rendererConfigs` array visible in the read). This needs an explicit result schema:
```ts
{ method: "jobs.cancelAll", result: {
    requestedCount: "integer",
    skippedCount: "integer",
    rawPathExposed: "boolean"
}}
```

Validate `requestedCount >= 0`, `skippedCount >= 0`, `rawPathExposed === false`.

**Acceptance check:** The existing test `cancel_all_reports_cancelling_until_an_active_worker_stops` at `job_manager.rs:2967` tests the basic case. Add a test that pre-populates one queued and one already-cancelling task, calls `cancel_all`, and asserts `requestedCount === 1` and `skippedCount === 1`.

---

### Change 6 — Whisper provenance rename

**Location:** `scripts/spec3-verify-ai-bundle.mjs:627, 795`

**MEDIUM — C12: Two rename sites exist; only one is the check, the other is a fixture.**

```js
// Line 627 — enforcement
if (candidate.provenanceStatus !== "official-source-pinned") {
    failures.push(`speech model ${modelId} lacks pinned official provenance`);
}
// Line 795 — test fixture
provenanceStatus: "official-source-pinned",
```

The rename to `canonical-whisper-cpp-artifact-pinned` must update both. If the fixture is updated but the check is not (or vice versa), the script passes in tests and fails in production validation, or vice versa.

**LOW — C13: The semantic distinction between OpenAI upstream and the whisper.cpp distribution revision is not enforced by any schema field.**

The plan says to "distinguish OpenAI upstream publishing from the pinned whisper.cpp distribution revision." Currently `provenanceStatus` is a single string. If the intent is to add a second field (e.g., `upstreamSource: "openai-whisper"` vs `distributionSource: "ggml-org-whisper-cpp"`), the bundle manifest schema and `BundledAssetRecord` both need new optional fields, and `spec3-verify-ai-bundle.mjs` needs to check the distribution source explicitly. The plan does not specify whether this is a new field or a richer string value. **Define the field before implementation.**

---

### Change 7 — Azure Trusted Signing

**Location:** `electron-builder.v3.yml`

**CRITICAL — C14: No signing configuration exists. Current Windows builds are unsigned and electron-builder does not fail — it silently skips signing when no provider is configured.**

```yaml
win:
  icon: assets/platform/candor.ico
  target:
    - nsis
# No signingHashAlgorithms, no sign, no azureSignTool, no certificateFile
```

A "fail-closed" configuration means the Windows build must fail if the signing tool is not configured or fails to sign. The correct pattern for Azure Trusted Signing without fabricating credentials is:

```yaml
win:
  signingHashAlgorithms: [sha256]
  sign: scripts/azure-sign.js   # Fails if env vars absent
```

The signing script must exit non-zero if `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TRUSTED_SIGNING_ACCOUNT`, and `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE` are absent. This causes electron-builder to fail the build rather than produce an unsigned package.

**Required:** Write `scripts/azure-sign.js` that: (1) checks for all required env vars and exits 1 if any are missing, (2) shells out to `azuresigntool.exe` only if all vars are present, (3) returns its exit code verbatim. **Do not put real credentials in the script or in the repo.** The script is correct and complete even with no credentials present — it just fails fast with a clear message.

**HIGH — C15: The Rust binary `candor-core.exe` is listed as an extra resource but is not in the signing scope.**

```yaml
extraResources:
  - from: build/core-bin
    to: bin
    filter: [candor-core, candor-core.exe]
```

By default, electron-builder signs the NSIS installer and the Electron executable, but does not sign resources placed in `extraResources`. `candor-core.exe` will be unsigned inside the signed installer. Windows SmartScreen and enterprise AV policies may flag unsigned executables extracted from signed installers. The Azure Trusted Signing configuration must explicitly include `candor-core.exe` in the signing pass before packaging, as a pre-build step, not post-install.

**Required:** Add a CI step that signs `build/core-bin/candor-core.exe` using the same Azure Trusted Signing account before `electron-builder` runs. This is a release-process change, not a YAML change, but must be documented.

---

### Cross-cutting findings not covered by the seven change areas

**HIGH — C16: `configuration_source: "mixed"` is accepted silently.**

`LocalInstructModelConfig::from_sources` at `local_instruct_model.rs:235-241` produces `"mixed"` if binary and model come from different sources (e.g., bundled binary + env model). This is never an error condition in the current code. For a release build, `"mixed"` provenance is ambiguous — the bundle SHA is verified but the env model SHA depends on the environment variable chain. `ensure_ready` should reject `"mixed"` configuration for release bundles (`release_ready: true`).

**MEDIUM — C17: Digest cache invalidation is mtime-only on Windows.**

`bundled_ai_assets.rs:491-509` caches SHA-256 by `(bytes, modified_unix_ms)`. On Windows, NTFS mtime has 100-nanosecond resolution but can be backdated by file copy operations (e.g., robocopy `/COPY:DT`). An installer that copies bundle assets and preserves timestamps would cause the cache to return the old digest for a replaced file. For the source-interface installer (dev use), this is low risk. For a signed release installer, the bundle root is installer-written and should never be user-modified — still low risk. Note it and move on.

**MEDIUM — C18: `BackgroundActivity` `visible` slice discards excess failed tasks silently.**

With the corrected ordering (failed first), if there are more than 8 failed tasks, only the first 8 are shown and active work is invisible. Consider a separate count display for overflowed tasks rather than a hard cap that can hide everything running.

---

### Summary table

| # | Severity | Change | Finding | File |
|---|----------|--------|---------|------|
| C1 | Critical | 1 | `local_llm_model_id` must return `Result`, not a sentinel string | `background_jobs.rs:389` |
| C2 | Medium | 1 | Electron schema does not enforce non-null `modelId` for release bundles | `operation-registry.ts:286` |
| C3 | High | 2 | `ask-first` requires a new JSONL protocol capability, not just an enum value | `job_manager.rs:118-124` |
| C4 | High | 2 | Enum rename breaks persisted job store without a migration path | `job_manager.rs:110-124` |
| C5 | Medium | 2 | Cancellation/shutdown non-fallback guards are already correct — verify only | `background_jobs.rs:674-693` |
| C6 | High | 3 | Verify `--json-schema` complex schema support in b9637 before committing | `local_instruct_model.rs:56-66` |
| C7 | Low | 3 | `--no-conversation` may conflict with or duplicate `--single-turn` on b9637 | `local_instruct_model.rs:67` |
| C8 | High | 4 | Failed tasks appear after active work in `visible` slice — can be cut off | `BackgroundActivity.tsx:70` |
| C9 | Medium | 4 | Cancel All condition includes `cancelling` tasks — misleads users | `BackgroundActivity.tsx:114` |
| C10 | Medium | 4 | Announcement only fires for the first terminal transition per render cycle | `BackgroundActivity.tsx:94` |
| C11 | High | 5 | `cancel_all()` acts on `cancelling` entries and result not validated in Electron | `job_manager.rs:925-962` |
| C12 | Medium | 6 | Two rename sites: check string and fixture string must both be updated | `spec3-verify-ai-bundle.mjs:627, 795` |
| C13 | Low | 6 | Semantic distinction needs a defined schema field before implementation | `spec3-verify-ai-bundle.mjs` |
| C14 | Critical | 7 | No Windows signing config; electron-builder silently skips signing today | `electron-builder.v3.yml:23-27` |
| C15 | High | 7 | `candor-core.exe` not in signing scope; must be signed as a pre-build step | `electron-builder.v3.yml:11-19` |
| C16 | High | — | `"mixed"` configuration source is accepted without error in release mode | `local_instruct_model.rs:235-241` |
| C17 | Medium | — | Digest cache uses mtime which can be preserved by Windows file copy | `bundled_ai_assets.rs:491-509` |
| C18 | Medium | — | `visible.slice(0, 8)` with failed-first can hide all active work silently | `BackgroundActivity.tsx:70` |

---

### Required corrections before implementation (blocking)

1. **C1** — Change `local_llm_model_id()` signature to `Result<String, JobFailure>`; propagate at call sites.
2. **C3** — Remove `ask-first` from the plan or replace it with `RequireLocalLlm` + a renderer-handled retry flow. Do not add it as an enum value until the JSONL protocol supports round-trip blocking.
3. **C4** — Add `#[serde(alias)]` on the new enum variants or bump `JOB_STORE_SCHEMA_VERSION` with a migration handler before renaming anything in `AiFallbackPolicy`.
4. **C6** — Test `--json-schema <exact-schema>` against the b9637 binary on the development machine. If it fails or is unsupported, use `{"type":"object"}` and document that field enforcement is Rust-only.
5. **C8** — Reorder `visible` to put `failed` first.
6. **C14** — Add `scripts/azure-sign.js` with fail-closed env-var checks. Add `sign:` to `electron-builder.v3.yml` pointing to it. No real credentials go in either file.
7. **C15** — Document that `candor-core.exe` must be signed in a CI step before `electron-builder` runs, not during packaging.
