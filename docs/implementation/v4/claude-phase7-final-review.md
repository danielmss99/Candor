Now I have sufficient evidence for a thorough review. Let me compile the full adversarial report.

---

# Phase 7 Adversarial Review — Commits `13eda2c` → `cb0a504`

**Verdict: GO WITH REQUIRED FIXES**

No critical security vulnerability was introduced. The `CANDOR_E2E` production-app guard is structurally correct, the sandboxing preferences are unchanged, and the checksum chain's core provenance binding is sound. Two high findings must be fixed before this branch is pushed; three medium findings should be addressed in the same sprint.

---

## Findings — Critical

**None.**

The `isE2EMode = isDev && process.env.CANDOR_E2E === "1"` guard (`electron/main.ts:21`) uses `isDev = !app.isPackaged`. A packaged production installer always has `app.isPackaged === true`, so `isE2EMode` is permanently `false` in any production binary regardless of environment variables. The two effects of E2E mode — `userData` path override and scale-factor override — are the same pattern used for smoke mode and do not touch `webPreferences`. The sandbox, contextIsolation, nodeIntegration, and webSecurity values in `create-main-window.ts:22–28` are unconditional constants.

---

## Findings — High

### H1 — Cross-validation gap: total checksummed artifact count versus manifest artifact count

**Files:** `scripts/v3-release-checksums.mjs:75–91` and `scripts/v3-release-readiness-audit.mjs` `validateReleaseChecksums`

**Defect, not improvement.** `bindArtifactManifest` iterates `releaseArtifacts` from the manifest and verifies each has a matching computed hash. It does not check the reverse: that every file found in `release-v3/` is present in the manifest. The proof therefore records two distinct counts: `artifactCount` (files found on disk) and `sourceManifest.artifactCount` (entries in the manifest). `validateReleaseChecksums` never compares these two numbers.

**Failure mode.** If `release-v3/` contains a stale artifact left over from a prior build (e.g., a previous-version installer, a `.blockmap` from a different package, or a manually placed file) it will be hashed and written into `SHA256SUMS` without any manifest cross-reference. The readiness audit's existing checks all pass: `matchedArtifactNames.length === sourceManifest.artifactCount` (both use the manifest count), and `payload.artifactCount === payload.artifacts.length` (tautological self-check). The discrepancy `payload.artifactCount !== payload.sourceManifest.artifactCount` is never tested.

**Evidence.** At `v3-release-readiness-audit.mjs` within `validateReleaseChecksums`, no line reads `payload.artifactCount` and `payload.sourceManifest?.artifactCount` in the same comparison.

**Minimum fix.** In `validateReleaseChecksums`, add:
```js
if (
  Number.isInteger(payload?.artifactCount) &&
  Number.isInteger(payload?.sourceManifest?.artifactCount) &&
  payload.artifactCount !== payload.sourceManifest.artifactCount
) {
  failures.push(
    "release checksum total artifact count does not match manifest artifact count"
  );
}
```

**Test that proves the fix.** Add a unit test to `validateReleaseChecksums` that supplies a proof where `artifactCount = 3` and `sourceManifest.artifactCount = 2`; assert the validator returns a failure containing "total artifact count does not match manifest artifact count."

---

### H2 — Navigation-denial test uses a fixed sleep (`waitForTimeout`) instead of a deterministic assertion

**File:** `tests/e2e/candor-electron.spec.ts:101–104`

```ts
await session.page.evaluate(() => window.location.assign("https://example.com"));
await session.page.waitForTimeout(250);
expect(session.page.url()).toBe(initialUrl);
```

**Defect.** `waitForTimeout` is a fixed delay, not a retry loop. Playwright's documentation explicitly warns against it for state assertions. The test passes if the URL has not changed after 250 ms, but never retries if the process is slow. More critically, if Electron's `will-navigate` handler is somehow bypassed or deferred (e.g., under heavy CI load or a regression in navigation-policy registration), the race can resolve in the test's favor: the 250 ms elapses before the navigation completes, the URL happens to still equal the initial URL, and the test reports success while the navigation is still in progress.

**Realistic failure mode.** A regression that moves `installSessionHardening` to after `createWindow` could leave a window without a `will-navigate` listener for a short window. The 250 ms sleep would pass while the navigation is in flight. The URL check would then read the initial file URL because Electron hasn't loaded the remote page yet — not because navigation was denied.

**Evidence.** `tests/e2e/candor-electron.spec.ts:101–104` compared with Playwright docs: "Avoid using `waitForTimeout` in test assertions."

**Minimum fix.**
```ts
await session.page.evaluate(() => window.location.assign("https://example.com"));
await expect(session.page).toHaveURL(initialUrl);
```

`toHaveURL` polls until the assertion holds or the 10-second expect timeout fires. It also fails immediately on mismatch after the retry window, rather than silently passing on a race.

**Test that proves the fix.** Remove the navigation handler from a fork of the test fixture and confirm that `toHaveURL(initialUrl)` fails (times out with a clear error) where `waitForTimeout(250)` would have passed.

---

## Findings — Medium

### M1 — `CANDOR_NETWORK_POLICY` env var is passed by the test fixture but not read by `electron/main.ts`

**File:** `tests/e2e/candor-electron.ts:48`

```ts
CANDOR_NETWORK_POLICY: "disabled-by-default",
```

`applyChromiumNetworkPolicy` (`electron/security/network-policy.ts:64`) does not read this env var; it receives a `smokeMode: boolean` from the call site. `installSessionHardening` does not read it either. The actual Electron-side network enforcement comes from the `webRequest.onBeforeRequest` handler installed in `hardenSession()`, which is called unconditionally in non-smoke mode (`electron/main.ts:151`).

If this env var is consumed by the Rust sidecar to suppress model downloads during testing, it is correctly placed at the sidecar process environment level and is not a bug — but it is undocumented. If it is not consumed by anything, it is dead configuration that gives the false impression that network policy is configured by the test, rather than by the Electron session hardening code.

**Minimum fix.** Search the Rust codebase for `CANDOR_NETWORK_POLICY`. If it is consumed, add a comment at `candor-electron.ts:48` citing the sidecar documentation. If it is not consumed, remove it and add a comment near `hardenSession()` explaining that E2E tests rely on the same session hardening as production.

**Test that proves the fix.** Not required; this is a clarity issue. If the env var is removed, confirm all four E2E tests still pass.

---

### M2 — E2E tests do not verify that `webRequest.onBeforeRequest` session hardening is active

**File:** `tests/e2e/candor-electron.spec.ts`

The security test verifies `webPreferences` (sandbox, contextIsolation, nodeIntegration, webSecurity), popup denial, and navigation denial via `will-navigate`. It does not verify that the `session.defaultSession.webRequest.onBeforeRequest` handler is blocking actual HTTP/HTTPS fetch or XHR requests from the renderer. If `hardenSession()` were accidentally moved inside the smoke branch or called after `createWindow`, the `webPreferences` checks and popup/navigation tests would all still pass while request-level blocking was absent.

**Minimum fix.** Add a test step that attempts a real `fetch("https://example.com")` inside the renderer via `page.evaluate()` and verifies it throws or resolves with a network error:
```ts
const blocked = await session.page.evaluate(async () => {
  try {
    await fetch("https://example.com");
    return false;
  } catch {
    return true;
  }
});
expect(blocked).toBe(true);
```

**Test that proves the fix.** Remove the `hardenSession()` call in a branch and confirm this new assertion fails.

---

### M3 — axe `.setLegacyMode()` is undocumented; may suppress violations in strict cross-document contexts

**File:** `tests/e2e/candor-electron.spec.ts:30`

Legacy mode disables strict cross-origin iframe scanning. Candor has no iframes, so in practice the limitation is harmless. However, there is no comment explaining why legacy mode is required (likely Electron's Chromium version or sandbox boundary). If strict mode becomes available in a future `@axe-core/playwright` version, the silent suppression of violations would be missed.

**Minimum fix.** Add a one-line comment: `// Legacy mode required for Electron's sandboxed renderer; no iframes present.`

**Test that proves the fix.** Swap to strict mode in a local run and confirm the test either passes identically or reveals the specific reason legacy mode is needed.

---

## Findings — Low

### L1 — `test:electron` does not rebuild `dist-v3` and has no stale-build guard

**File:** `package.json:19`

Running `npm run test:electron` locally without a prior `npm run electron:v3:build-main` silently tests the previous compiled output. The `test:electron:build` alias exists but is not what CI invokes. In CI the risk is low (build steps precede tests in the workflow). Locally a developer iterating on `electron/main.ts` could run the E2E tests and see stale results without warning.

**Fix.** Add a note to the script description or to `MANUAL_RELEASE_PROOF_RUNBOOK.md`. Alternatively, the local dev workflow documented in the Phase 7 verification doc should prescribe `test:electron:build`, not `test:electron`, for iterative runs.

---

### L2 — `devTools` preference is not asserted in the security test

**File:** `tests/e2e/candor-electron.spec.ts:58–66`

`create-main-window.ts:29` sets `devTools: options.navigation.useDevRenderer`. In E2E mode without `CANDOR_V3_RENDERER_URL`, `useDevRenderer` is `false`, so DevTools are disabled. The test does not assert this. Adding `devTools: false` to the expected preference object would guard against a regression that enables DevTools in non-dev sessions.

**Fix.** Add `devTools: false` to the `preferences` comparison at `candor-electron.spec.ts:66`.

---

## Required Fixes Before Push or PR

| Priority | Finding | File | Action |
|---|---|---|---|
| H1 | Cross-validate `artifactCount` vs `sourceManifest.artifactCount` | `v3-release-readiness-audit.mjs` | Add missing equality check in `validateReleaseChecksums` |
| H2 | Replace `waitForTimeout(250)` with `toHaveURL(initialUrl)` | `tests/e2e/candor-electron.spec.ts:101–104` | One-line replacement |

Both H1 and H2 are small, self-contained changes. After applying them, rerun `npm run test:electron` and `npm run v3:release-readiness-audit` to confirm.

---

## Optional Backlog Suggestions

- **M1 resolution:** Audit the Rust sidecar for `CANDOR_NETWORK_POLICY` consumption and add inline documentation either way.
- **M2:** Add a renderer `fetch()` block test to the existing security test; piggybacks on the existing session setup.
- **M3:** Add a one-line legacy-mode comment.
- **L2:** Add `devTools: false` to preference assertions.
- **Future:** When the `@axe-core/playwright` strict mode is confirmed compatible with this Electron Chromium version, remove `.setLegacyMode()`.
- **Future:** Consider a `bindArtifactManifest` reverse check (assert `artifacts.length === releaseArtifacts.length`) for defense in depth beyond the validator fix.

---

## Assumptions and Files Not Fully Inspected

- The Rust sidecar source (`crates/candor-core/`) was not inspected. The `CANDOR_NETWORK_POLICY` finding depends on whether the Rust sidecar reads that env var.
- `electron/window/navigation-policy.ts` was not read in full; the analysis of `isNavigationAllowed` relies on behavior observed through the test (navigation is blocked) rather than static inspection of the policy function.
- `scripts/m0-artifact-manifest.mjs` was not read; the assumption that it records `dirty: false` and the current HEAD was inferred from the manifest binding check in `v3-release-checksums.mjs:68`.
- The pre-Phase 7 contents of `electron/main.ts` were not diffed line-for-line for the `applyChromiumNetworkPolicy` call site; the review used the current file and the Phase 7 diff.

---

## Re-Review Required?

**Yes, focused.** After H1 and H2 are fixed, request a targeted re-review of:
1. The added `validateReleaseChecksums` cross-count check.
2. The replaced `toHaveURL` assertion.

No full re-review of the Phase 7 scope is required if only those two changes are made. The external blockers (signed releases, physical capture, clean-machine, network-deny under elevated authority, macOS/Linux artifacts) remain open release gates unaffected by this review.
