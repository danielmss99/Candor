**GO WITH REQUIRED FIXES**

---

## Q1 — Two-way producer/validator package agreement

**Correct and complete.**

**Producer** (`v3-release-checksums.mjs` `bindArtifactManifest`):
- Line 70–72: strict count check — `releaseArtifacts.length !== artifacts.length` throws immediately.
- Lines 76–84: for every manifest entry, extracts `path.basename(entry.path)`, confirms it is in the current scan with an exact sha256 match, and rejects duplicates via a `seenNames` Set.
- Lines 86–89: reverse walk — every scanned artifact that is absent from `seenNames` throws. Combined with the count guard, this is full bijection.
- Line 64: manifest must match the current `gitHead` and `dirty === false`; stale manifests are rejected at source.
- Lines 107–109: `isUnsafeReleaseArtifactName` rejects path-separator and newline names before any hashing.
- `releaseArtifactPattern` (line 1 of `release-artifacts.mjs`) includes `.blockmap`; the fixture in the test file uses exactly `[".exe", ".exe.blockmap"]` — blockmaps are bound.

**Validator** (`release-checksum-validation.mjs`):
- Lines 31–32, 37–38, 40–41: three-way count equality: `artifactCount === artifacts.length === sourceManifest.artifactCount === matchedNames.length`.
- Lines 43–44, 58–59: uniqueness on both sides.
- Lines 49, 62–63: basename-only checks using `replaceAll("\\", "/").split("/").at(-1)` — path-shaped names fail.
- Lines 61–66: every manifest name must be present in the artifact list; with equal counts and uniqueness, this guarantees bijection in both directions.

---

## Q2 — Deterministic `will-navigate` proof

**Correct.**

Lines 116–136 of `candor-electron.spec.ts`:
1. A `will-navigate` listener is installed on the main-process `webContents` before any navigation is triggered.
2. Navigation is triggered with `window.location.assign()`.
3. `expect.poll()` waits for `__candorE2ENavigation` to be non-null — no fixed sleep.
4. The assertion requires `{ defaultPrevented: true, url: "https://example.com/" }` — the event must have fired **and** been prevented.
5. Only after that proof does the test read `session.page.url()` against `initialUrl`.

The `setImmediate` wrapper on the global assignment is safe: all synchronous `will-navigate` listeners (including production code calling `event.preventDefault()`) run before the microtask queue is drained, so `event.defaultPrevented` is final by the time `setImmediate` fires.

The `toHaveURL(initialUrl)` shortcut was correctly rejected — it can satisfy immediately before the navigation event resolves.

---

## Q3 — Session-fetch assertion: Electron hardening vs. renderer CSP

**Medium defect.**

**Severity:** Medium
**File/line:** `tests/e2e/candor-electron.spec.ts:98–107`

**Evidence:**
```ts
await window.webContents.session.fetch("https://example.invalid");
```

The call is in the right place: it runs in the main-process `evaluate` callback, not the renderer, so it bypasses renderer CSP. It does test the session layer.

The problem is the choice of `example.invalid`. `.invalid` is an IANA-reserved TLD that will always produce a DNS resolution failure regardless of whether any Electron session-level network policy is active. The assertion `sessionRequestBlocked === true` will pass even with the `webRequest` or custom-session block removed entirely, because DNS failure is indistinguishable from a session policy rejection here.

**Minimum fix:** Replace `https://example.invalid` with a domain that has valid public DNS but that the session policy is expected to block, e.g. `https://example.com`. A DNS-resolvable domain that fails only under the session policy provides the discriminatory power the test needs.

**Proving test:** Remove the session-level `webRequest`/network block from the production Electron session config; the current assertion remains `true` (DNS fails). After switching to `https://example.com`, the same removal should cause the test to fail (the request succeeds), proving the test is actually sensitive to session hardening.

---

## Q4 — New High or Critical defects introduced

None. The session-fetch ambiguity (Q3) is **Medium**: it is a test-coverage gap — the production session hardening code is unchanged and may be correct; only the test's ability to prove it is weakened. No correctness or security regression was introduced in the production paths by any of these fixes.

---

## `CANDOR_NETWORK_POLICY` removal

Confirmed clean. `defaultSpawnCore` in `core-client.ts:61–69` passes only `CANDOR_CORE_TRANSPORT: "stdio-json-lines"`. `launchEnvironment` in `candor-electron.ts:39–49` passes only `CANDOR_E2E`, `CANDOR_E2E_SCALE_FACTOR`, and `CANDOR_V3_DATA_DIR`. Neither file references `CANDOR_NETWORK_POLICY`.

---

## Summary

| Finding | Status |
|---|---|
| H1 — two-way count/hash/name/blockmap binding | Fixed correctly |
| H2 — deterministic navigation event proof | Fixed correctly |
| M1 — `CANDOR_NETWORK_POLICY` removal | Fixed correctly |
| M2 — session fetch uses non-resolvable TLD | **Medium defect — minimum fix required** |

**Another focused re-review is not required** if the session-fetch URL is changed to a DNS-resolvable external origin (e.g. `https://example.com`); that change is small and self-evident.
