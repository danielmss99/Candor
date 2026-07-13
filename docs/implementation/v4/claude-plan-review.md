I now have the evidence base to write the full review. The `recording.durable.status` discrepancy is confirmed: it's in `main.ts:rendererCoreMethods` (line 104) and in the Rust core's dispatch table, but absent from `preload.cts:allowedMethods`. All smoke scripts call it directly over stdio — the renderer cannot reach it. This is a real defect.

---

# Candor V4 Plan Gate Review

Adversarial. Evidence from the actual source, not from the plan's claims about it. Baseline SHA `b290613`.

---

## Observed Defects (Not Speculative)

Before the questions, three defects already present that must be fixed during or before the relevant phase:

**D1. `recording.durable.status` is unreachable from the renderer.**
`electron/main.ts:104` lists it in `rendererCoreMethods`. `electron/preload.cts` `allowedMethods` (lines 11–54) does not. The Rust dispatch table at `crates/candor-core/src/main.rs:393` handles it. Every smoke script that calls it does so directly over stdio, bypassing the preload entirely. The renderer has no wrapper for it. Fix in Phase 2 or earlier; it silently blocks any renderer feature that would poll recording status.

**D2. `audit-source-security.ps1` will throw on `src-tauri/` deletion.**
Lines 28–69 of that script call `Get-Content -LiteralPath` on `src-tauri/build.rs`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`, and `src-tauri/src/calendar.rs`. With `$ErrorActionPreference = "Stop"`, deleting those files causes the script to throw, not silently skip. The `audit:source` npm command calls this script. Deleting Tauri source before rewriting this script breaks CI auditing immediately.

**D3. `v3-source-security-proof.mjs` reads the same four Tauri files.**
Line 78: `readSource(join("src-tauri", "build.rs"))`. Line 79: `readSource(join("src-tauri", "src", "calendar.rs"))`. `readSource` uses `existsSync` so it returns `""` rather than throwing, but then the downstream checks pass vacuously: no pattern in `""`. Deletion of `src-tauri/` makes the proof emit green for checks it can no longer actually perform. This is a security audit hole, not a build break.

---

## 1. Refined Implementation Plan

### Phase 1 (Electron Authoritative) — Mandatory sub-phase ordering

The plan groups Phase 1 as a single phase. That is not safe. The three steps below must be sequential commits, each passing `npm run v3:verify`:

**P1a — Make root commands Electron-authoritative.**
Change `dev`, `build`, `preview`, `build:all`, `build:store` to Electron/Vite v3 equivalents or to explicit error aliases. Remove `tauri`, `tauri:dev`, `tauri:release` scripts. Remove `@tauri-apps/api` from `dependencies` and `@tauri-apps/cli` from `devDependencies`. Verify `npm ci` installs without Tauri packages. This commit must pass the full verify suite.

**P1b — Rewrite audit scripts before source deletion.**
Replace `audit-source-security.ps1` with checks meaningful for Electron/Rust:
- Scan `electron/main.ts` and `electron/preload.cts` for hardcoded secrets or API keys
- Assert `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true` present in `createWindow()`
- Assert `candor-shell:openExternal` handler rejects requests (verifiable: `main.ts:1726–1728` already throws)
- Assert no `shell.openExternal` in the preload
- Drop the four `src-tauri/` path reads entirely; the calendar checks are vacuously satisfied by calendar being out of scope, but must be documented as intentionally removed, not silently deleted

Rewrite `v3-source-security-proof.mjs` to match. Do not delete any Tauri source in this commit. Run both `audit:source` and `v3:source-security-proof` against the current tree to confirm they still pass (they should, since the Tauri files still exist and the new Electron checks add rather than replace at this step).

**P1c — Tag and delete Tauri source.**
`git tag archive/tauri-v2 HEAD` (or the last Tauri-active commit). Then in one commit: delete `src-tauri/`, `src/` (root renderer), `scripts/tauri-dev.ps1`, `scripts/tauri-release.ps1`, `public/tauri.svg`, and disable `tauri-build.yml` (rename or gate on a `workflow_dispatch` with a comment). Run `audit:source` and `v3:source-security-proof` — both must still pass, now proving Electron coverage rather than vacuously skipping.

**P1d — README and ARCHITECTURE.md.**
Last, not first. Documentation that contradicts code destroys trust faster than missing documentation.

### Phase 2 (Main Process) — Smoke harness extraction is the critical risk

The smoke harness (`runM0Smoke`, lines 1194–1406, ~210 lines) is directly coupled to: `callCore`, `ensureCoreHandshake`, `requestCoreShutdown`, `supervisorSnapshot`, `networkGuardSnapshot`, `decodeLocalExportResult`, `createWindow`, `waitForRendererLoad`, `waitForRendererView`, `clickSmokeButton`, `captureSmokeView`, `captureSettledSmokePage`, `writeSmokeResult`, and `delay`. That is not an extractable unit unless those helpers move into named modules first.

Recommended extraction order:
1. Move `callCore`/`ensureCoreHandshake`/`requestCoreShutdown`/`rejectPending`/`supervisorSnapshot` into `electron/core-process.ts`
2. Move `installSessionHardening`/`networkGuardSnapshot` into `electron/session-policy.ts`
3. Move `decodeLocalExportResult` and the IPC export handler into `electron/export-handler.ts`
4. Move `createWindow` and security event wires into `electron/window-factory.ts`
5. Only then move the smoke helpers into `electron/smoke-harness.ts`
6. In `electron/main.ts`, load the smoke harness via dynamic import guarded by `isSmokeMode`, so it is tree-shaken from production bundles

The 250-line target for `main.ts` is achievable after this, but the target should be a consequence of named-module extraction, not the forcing function. Do not count lines to declare success.

### Phase 3 (Protocol Hardening) — Reject cryptographic IDs, use UUID4

See Section 7 for the specific rejection. The versioned envelope and duplicate rejection are real requirements; the "cryptographically strong" framing is the problem.

The smallest safe RPC increment that keeps old core and new shell in the same commit:
1. Add `requestId: string` as an optional field to both request and response
2. Main process generates `crypto.randomUUID()` alongside the existing numeric `id`
3. Core echoes back `requestId` if present; ignores if absent (backward-compatible)
4. Main process validates `requestId` if present in response; tolerates absence if core version predates Phase 3
5. Bump `expectedCoreProtocolVersion` to `"m0-jsonrpc-stdio-2"` only when `requestId` is made mandatory, not before
6. Duplicate rejection: `pending` Map keys are `requestId` strings, not numeric IDs, once all callers are migrated

### Phase 4 (Renderer Modules) — Extract startup first, not the largest feature

See Q8 below. The startup loader is the highest-risk extraction because:
- It holds the only startup `refresh()` with 17 parallel RPC calls and no per-call error isolation
- It's the only point where `requestCoordinator` does not guard stale updates
- It drives the initial library selection that all other features depend on

Extract the startup loader before extracting capture or AI features.

### Phase 5 (GUI) — Smoke harness DOM selectors are a dependency

The smoke harness at `main.ts:951–984` queries `.desktop-nav button`, `.library-row`, `.wordmark`, `[data-view]`, `.advanced-settings-toggle`, `.settings-layout nav button`, `.format-options button`, `[data-export-save]`. Phase 5 changes the nav structure and information architecture. This will break the smoke DOM selectors. The plan does not acknowledge this dependency.

Required: before any Phase 5 nav changes, audit which smoke selectors would break, update smoke first, verify smoke still passes, then change the DOM.

### Phase 6 (Data and Reliability) — Cannot start without migration tests

The 62 Rust tests do not currently include: migration backup proof, rollback, corrupt-record quarantine, or disk-full detection. These are required before Phase 6 runs, not deliverables of Phase 6. See Q9.

---

## 2. Required vs Optional

**Required (plan is unsafe or incomplete without these):**
- P1b audit script rewrite before P1c source deletion (D2, D3)
- Fix `recording.durable.status` preload gap (D1)
- Capture-aware restart guard before Phase 2 extraction ships (otherwise the restart proof in the smoke tests passes while real capture could still be killed mid-session)
- Startup partial-failure isolation in Phase 4 (currently one timeout kills the full startup state load)
- Migration backup/rollback tests before Phase 6 writes any migration code
- Smoke DOM selectors audited and updated before Phase 5 nav changes

**Optional (good engineering but not risk-blocking):**
- Sub-250-line targets as numerical goals (extract named modules with single responsibilities; the number follows)
- Playwright Electron tests — high value, but the existing packaged smoke already proves more than headless Playwright can for this app
- Advanced Settings information architecture reorganization — cosmetic, no safety implication
- UUID4 for request IDs vs. the current numeric counter — either is fine, do not add HMAC or signing

---

## 3. Assumptions and Unresolved Questions

**Unresolved:**
1. What does the Rust core do when `core.shutdown` arrives during an active durable recording? If it does not flush the current in-progress chunk before exiting, the `stopCoreForRestart()` path causes data loss. This must be verified in the Rust source before Phase 2's restart policy is written.

2. Is `@tauri-apps/api` in `dependencies` (not devDependencies) actually imported by any active renderer code? If so, removing it in P1a will break the renderer build. Grepping the active renderer path for the import is required before removal. (It is likely dead code from the legacy `src/` renderer, but this must be confirmed.)

3. Does the v2 importer read from paths that overlap with any SQLite database paths the Phase 6 migration would touch? If the importer writes into the same schema the migration rewrites, import + migration must be sequenced.

4. The `tauri-build.yml` CI workflow currently builds and smoke-tests a Tauri binary. Once Tauri is removed, this workflow either fails or must be disabled. The `v3-m0.yml` workflow already handles Electron. Plan does not explicitly say which commit disables `tauri-build.yml`. This must happen in P1c.

**Assumptions:**
- The Rust core `v2_importer` reads legacy Markdown and audio without modifying original files. The baseline document asserts this; the plan correctly treats it as invariant.
- `contextIsolation`, `sandbox`, `nodeIntegration: false` are not being touched in any phase. Confirmed from code; these should be locked in the audit replacement script so a future commit cannot accidentally revert them.

---

## 4. Failure Modes (ranked by severity)

**Critical — data loss or silent security regression:**

1. **Core restart during active capture with unknown Rust flush behavior.** `stopCoreForRestart()` at `main.ts:667` sends `core.shutdown` then waits 5 seconds, then SIGKILLs. If the Rust side does not flush the current WAV chunk before exiting, the in-progress recording is silently truncated. No guard currently prevents this during capture. Severity: data loss.

2. **Phase 1 deletion of `src-tauri/` before audit rewrite.** Makes `audit-source-security.ps1` throw and makes `v3-source-security-proof.mjs` pass vacuously. If CI is updated to tolerate the throw, security coverage drops to zero for those checks silently. Severity: silent security regression.

3. **Phase 6 migration running on live user data without a tested rollback path.** The baseline notes this explicitly. No migration tests exist yet in the Rust suite. Any Phase 6 migration commit that runs before those tests is a data-loss risk.

4. **Startup `refresh()` at `CandorApp.tsx:335` has no per-call error isolation.** It fires 17 parallel RPC calls; one 5-second timeout kills the entire startup state update. State remains at initialization defaults, user sees the error toast, and the app appears functional but is operating on empty state. No retry or partial-state indication. Severity: functional silent failure, especially if core is slow post-restart.

**High — security regression or functional break:**

5. **Smoke DOM selectors breaking silently after Phase 5 nav changes.** The smoke checks `ok: true` at the end, but many individual view tests use `navigation.clicked: false` as a soft signal rather than a hard failure. A Phase 5 change that renames `.library-row` to `.meeting-row` would produce `clicked: false, currentView: "library"` without the smoke run failing. The smoke would pass while the GUI workflow proof is invalid.

6. **WAV export default 5-second timeout.** `main.ts:rendererCoreTimeoutMs` has specific overrides for long methods but not for `export.create` when `format: "wav"`. The default is 5000ms. For a 30-minute recording, WAV export could exceed 5 seconds. The request times out, the export fails, and the user cannot retrieve audio. No method-specific timeout is set.

**Medium — functional or operational gaps:**

7. **Unbounded stderr from the Rust core.** `main.ts:266–268` routes all stderr to `console.error`. In a packaged app during a long recording, if the core emits verbose diagnostic output, there is no buffer cap. Long-duration recording stress testing (Phase 7) will surface this; Phase 2 should add a cap.

8. **`recording.durable.status` renderer gap** (D1 above). Any renderer feature that wants to poll whether a recording is in-progress or finalized cannot do so through the preload API. Currently unblocking because the renderer uses capture state instead, but Phase 4 modularization that adds a recording status component would hit this.

9. **`handshakePromise` stale state on rapid restart.** If `callCore()` is called between process creation and the exit event firing for the old process, `handshakePromise` may still hold the old process's in-flight handshake. The new process's `callCore()` would return `startCore()` → guard hits `if (core) return` → waits on the stale promise → gets rejected when old exit fires → leaves `handshakePromise = null` → next call then properly re-handshakes. Net effect is one wasted request cycle, not data loss, but the log message will be misleading.

**Low — quality and cleanup:**

10. Numeric request IDs (`nextRpcId`) overflow at `Number.MAX_SAFE_INTEGER` (9×10¹⁵). Practically unreachable; harmless to fix in Phase 3 as part of the UUID migration.
11. `tauri:dev`, `tauri:release`, `build:all`, `build:store` still appear as `npm run` commands pointing at Tauri scripts. A developer running `npm run build` gets a Tauri build attempt, not an Electron build. This is P1a work.
12. `probeUrl` at `main.ts:1093` is string-interpolated into `executeJavaScript` without `JSON.stringify()`. Not a security risk at a hardcoded string, but inconsistent with how other URLs are handled in the same function.

---

## 5. Tests and Acceptance Checks Per Phase

**Phase 1 acceptance (not a source claim — must be verified by running commands):**
- `npm run audit:source` exits 0 on the post-deletion tree
- `npm run v3:source-security-proof` exits 0 and the output JSON does not contain `"vacuouslyPassed": true` or equivalent
- `npm run v3:verify` passes
- `npm run electron:v3:build` produces output without Tauri packages in the bundle
- `git ls-files | grep tauri` returns empty
- `git ls-files | grep src-tauri` returns empty
- `tauri-build.yml` is absent or gated to `workflow_dispatch` with a documented reason
- `v3-m0.yml` CI passes on Windows and Linux

**Phase 2 required tests before merge:**
- `electron/main.ts` passes typecheck at ≤350 lines (conservative; 250 may require two extraction PRs)
- Smoke harness can be imported in isolation in a unit test without side effects
- Capture-aware restart guard: unit test that `stopCoreForRestart()` when `captureStatus.active === true` returns early with a logged warning rather than SIGKILLing
- Stderr buffer test: pipe 10 MB of stderr from a mock child, assert event loop is not blocked and output is capped

**Phase 3 required tests before merge:**
- IPC rejection: send a request with a duplicate `requestId` to `candor-core:call` handler; expect rejection, not processing
- IPC timeout: mock a slow core response for `ai.askInstruct`; assert client rejects after 60 s, not 5 s
- IPC method block: attempt to call a private method (`recording.durable.start`) from the renderer; expect rejection from preload before it reaches main
- Protocol version mismatch: mock core returning `protocolVersion: "bad"` on a response; assert UI shows a specific mismatch screen rather than a generic error

**Phase 4 required tests before merge:**
- `CandorApp.tsx` ≤ 250 lines, typecheck passes
- Every smoke selector still resolves: run the packaged smoke and assert all view screenshots captured (`captured: true`)
- Stale request guard: navigate away mid-`loadSelectedRecording`; assert prior response does not update current state
- License-independent recording access: deactivate license; assert `recording.durable.listPage` and `export.create` still succeed

**Phase 5 required tests before merge:**
- Record action is reachable in ≤ 2 clicks from initial app load
- At 1366×768, no primary control is clipped or scrolls off-screen (verify with smoke at that viewport)
- At 150% DPI, no text overlaps or truncates primary labels
- Keyboard-only: Tab through Record → active capture → stop → Meetings → open meeting → Review → Export without mouse

**Phase 6 required tests before merge:**
- Migration creates backup: run migration; assert backup file exists and byte-matches the pre-migration database
- Rollback restores original: corrupt the post-migration DB; run rollback; assert library loads and recording count matches
- Quarantine: insert a corrupt record; assert library loads remaining records, corrupt is flagged not silent
- Disk-full simulation: fill the temp write path; assert in-progress recording is marked incomplete, not silently 0-byte

**Phase 7 manual proof gates (not CI-automatable):**
- Real hardware capture: 5-, 30-, 60-minute recordings with transcript verification
- 180-minute recording: manual only, not a CI job
- Clean install on a fresh machine with no prior user data
- Upgrade from the last tagged release with real user data
- Signed prerelease artifact with verifiable signature chain
- Sleep/resume and audio device switch during recording

---

## 6. Claude Review Gate Dispositions

**Gate 1 (Plan gate, this response):** Covered. The main findings: P1 must be split into sub-phases with audit script rewrite first; Phase 5 creates a hidden DOM-selector dependency on the smoke harness; Phase 6 requires pre-existing migration tests, not just the migration implementation itself; and three observed defects are in the current baseline.

**Gate 2 (After Phase 1):** Independent file read, not acceptance of Codex's claim that Tauri is removed. Specific checks: (a) `git ls-files | grep src-tauri` returns empty; (b) `audit-source-security.ps1` contains no `src-tauri` path reads; (c) `v3-source-security-proof.mjs` contains no `src-tauri` path reads; (d) the new Electron-specific audit checks are present and substantive (not just comments); (e) `@tauri-apps/api` is absent from `package.json dependencies`; (f) `crates/candor-core/src/` still contains `v2_importer`; (g) runtime data paths in Rust source are unchanged. Do not accept a diff that moves Tauri to `legacy/` as equivalent to deletion.

**Gate 3 (After Phases 2+3):** Adversarial review of the IPC surface. Specifically: (a) attempt to call a private method from the renderer tier via a crafted IPC message; (b) verify that duplicate `requestId` rejection is tested and provably failing on duplicate; (c) read the new handshake/restart logic for the race window described in Failure Mode 9; (d) verify the stderr cap is present; (e) check that WAV export has a method-specific timeout.

**Gate 4 (After Phases 4+5):** State-machine review. Read the extracted startup loader for per-call error isolation. Verify that the smoke selectors still match the DOM after the Phase 5 nav restructure. Run compact-viewport smoke output manually. Check that the license-independent recording access test was not dropped in the modularization.

**Gate 5 (After Phase 6):** Data-loss review. Read the migration SQL and its rollback path. Verify the backup is created before any destructive SQL runs. Verify corrupt-record quarantine does not block the library. Verify disk-full is caught at the write call, not silently producing a 0-byte chunk. Verify the v2 importer data paths are not touched by the migration schema changes.

**Gate 6 (Before release):** Full deviation review. Compare the Phase 3 IPC allowed-method list against both the plan's constraints and the preload allowedMethods to confirm no drift. Verify the signed artifact can be verified by a clean machine without developer tooling installed. Run the proof audit in strict mode and read its output. Confirm no network endpoints are reachable by running the network-deny scripts on a fresh machine.

---

## 7. Rejected Recommendations (with evidence and safer replacements)

**Reject: "cryptographically strong request IDs."**

The plan says this at Phase 3. The phrase implies signing, HMAC, or a shared secret — a key-management problem that does not exist in this threat model.

Evidence: The IPC boundary is between a sandboxed renderer (contextIsolation, nodeIntegration disabled, sandbox) and a trusted main process. The preload validates method names against `allowedMethods` before any request crosses the boundary. A malicious renderer cannot forge a request that the preload would forward for a method not on the allowlist. What Phase 3 actually needs is: (1) collision-resistant IDs for log correlation and duplicate detection, and (2) non-guessable IDs so a compromised renderer cannot predict a pending request ID and craft a timing attack. `crypto.randomUUID()` satisfies both at zero key-management cost.

**Replacement:** Use `crypto.randomUUID()` for all new request IDs. Validate echo on response. Reject if `requestId` in response does not match the pending request. No signing, no shared secret, no HMAC.

**Reject: Moving Tauri to `legacy/tauri-v2/` as an intermediate archival step.**

Evidence: (1) `@tauri-apps/cli` in devDependencies would require a renamed path to still build, or `npm ci` would fail — either way the intermediate step does not eliminate the dependency surface. (2) The `v3-source-security-proof.mjs` uses `readSource()` with a relative path; a `legacy/` prefix would require updating the path, which defeats the purpose of an intermediate step. (3) The git history already has the full Tauri source at the archived SHA; a `legacy/` directory permanently adds binary-equivalent content to the working tree and all future clone sizes. (4) The claim that `legacy/` prevents accidental compilation is false — `npm run tauri:dev` with the `legacy/` prefix would need a path change, but the script is in `package.json` and still runnable.

**Replacement:** `git tag archive/tauri-v2 <last-tauri-active-sha>` before the deletion commit. Document the tag name in `ARCHITECTURE.md`. Nothing else is needed. Any developer who needs the Tauri source for reference can check it out by tag.

**Reject: Phase 5 "Move models, runner, hashes, vault internals, network policy, imports, and proof export under Advanced Settings" as an unconditional Phase 5 deliverable.**

This is not a GUI cleanup. Moving these items under Advanced Settings changes which users can reach them. If a user's workflow is: install model → transcribe → export, and "install model" is now under Advanced Settings, the workflow breaks for first-time setup. The plan does not address the onboarding flow that currently walks users through model setup.

**Replacement:** Before hiding any feature behind Advanced Settings, audit which smoke views currently navigate through the hidden item (e.g., `captureSmokeView` visits "settings" and then opens advanced settings — line 972–979). Confirm the onboarding path still reaches model setup via the onboarding wizard rather than via Advanced Settings. Only then move items.

---

## Answers to the Ten Specific Questions

**Q1 (Phase order safe?)** Yes, with the mandatory sub-phasing of Phase 1 described above. The only dependency that could force a broken intermediate commit is the smoke DOM selector coupling: Phase 5 nav changes must not precede a smoke selector audit in the same commit.

**Q2 (Tauri archival approach)** Tag then delete. `legacy/tauri-v2/` is worse than deletion on all three dimensions asked: repository size (adds content permanently), audit clarity (requires updated path reads or vacuous results), and accidental compilation (scripts still runnable with trivial path change). Evidence above.

**Q3 (Tauri security checks to replace)** Four checks in `audit-source-security.ps1` need replacement:
- `build.rs` secret export → scan `electron/main.ts` for hardcoded credential patterns; assert no `process.env` interpolation in the `spawn()` call beyond `CANDOR_CORE_TRANSPORT` and `CANDOR_NETWORK_POLICY`
- `tauri.conf.json` CSP wildcard → assert the four `createWindow()` security flags are true/false as required; lock them with a test that fails if any is changed
- `capabilities/default.json` opener → assert `candor-shell:openExternal` handler throws (currently true at `main.ts:1726–1728`; test this directly)
- `calendar.rs` plaintext fallback → drop with a comment: "calendar integration is out of scope per V4 constraints; checks removed intentionally"

**Q4 (Smoke harness extraction)** Extract the production helpers (callCore, session policy, window factory, export handler) into named modules first. Then move `runM0Smoke` and its helper functions (seedDesignSmokeMeeting, runRendererIsolationProbe, runNetworkBlockProbe, etc.) into `electron/smoke-harness.ts`. In `main.ts`, load it only when `isSmokeMode` via `const { runM0Smoke } = await import('./smoke-harness.js')`. This keeps smoke code out of the production bundle's parsed code path while preserving the proof harness. The harness references production functions via their module exports, not via globals.

**Q5 (Smallest safe RPC increment)** Add optional `requestId: string` (UUID4) to request and response. Core echoes if present, ignores if absent. Main process validates echo if present, tolerates absence for backwards compatibility. Dedup uses `requestId` when available. Bump protocol version only when `requestId` becomes required. This is a two-commit migration: commit 1 adds optional support, commit 2 (later) makes it required and bumps the version string.

**Q6 (Schema co-location)** Put canonical JSON Schema files in `crates/candor-core/schemas/`. Rust build tests (`cargo test`) assert that `serde_json::to_value(SampleResponse::default())` validates against the schema. A TypeScript test imports the same JSON Schema files and validates sample JSON fixtures against them. This is a read-the-file approach that fails loudly on drift without a fragile code generator. No generated code, no build pipeline dependency.

**Q7 (Unsafe restart behaviors)** Active capture (core killed mid-chunk), finalization (`recording.durable.finish` in-flight — recording left without a finish record), model import mid-chunk (the chunked `importChunk` protocol is unrecoverable without `importAbort`, which cannot be called after restart), and any export call exceeding 5 seconds (the in-flight WAV export times out and the user gets an error but the export did not fail — it was simply orphaned). Migration (Phase 6) is not yet relevant at Phase 2, but must be added to the list when it becomes implementable.

**Q8 (First renderer feature to reduce race risk)** Extract the startup loader. This is the `refresh()` function and its dependencies (`refreshLicense`, `loadSelectedRecording`, `requestCoordinator`, `startupLoaded`). Reason: it is the only async flow that has no per-call error isolation, no stale-request token, and whose failure leaves all 80+ state values at initialization defaults silently. Extracting capture second (to resolve the capture state machine vs. library state double-write race) is the correct second step.

**Q9 (Required tests before touching persistence)** Five Rust tests must exist before Phase 6 begins: (1) migration runs idempotently — run it twice, schema and data are identical; (2) migration creates a backup file that byte-matches the pre-migration database; (3) rollback from that backup restores the original schema version and all rows; (4) corrupt record in the database is quarantined and the rest of the library loads without error; (5) write failure mid-chunk during a recording produces a recoverable incomplete-recording state, not a silent 0-byte file. These are prerequisites, not Phase 6 deliverables.

**Q10 (Unprovable acceptance criteria)** Three acceptance criteria in Phase 7 are unprovable in CI as written: (a) "180-minute recording proof" — a 3-hour CI job is not feasible and real hardware capture is not available on CI runners; (b) "clean install on a fresh machine" — CI runners have pre-installed tooling that contaminates the test environment; (c) "signed prerelease" — code signing requires a certificate private key that must not be present in CI. These must be labeled as manual proof gates with documented human-run procedures, not as automated CI checks. Stating them as Phase 7 "tests" without this distinction misleads stakeholders about the automated coverage level.
