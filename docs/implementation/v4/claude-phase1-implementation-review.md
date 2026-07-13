Now I have enough to write the complete adversarial review.

---

# Phase 1 Adversarial Review — Candor V4 Electron Consolidation

Revision range: `b29061334cff9` (baseline) → `3c4004f` (review). Read-only review; no files edited.

---

## Findings — Ordered by Severity

---

### [High] `will-navigate` allows any `file:` URL in production, not just the renderer

**File:** `electron/main.ts:605-612`

```typescript
mainWindow.webContents.on("will-navigate", (event, targetUrl) => {
  const allowed = useDevRenderer ? isRendererDevNavigation(targetUrl) : targetUrl.startsWith("file:");
```

**Evidence:** In production (`!useDevRenderer`) any `file:` URL is allowed through. The packaged renderer loads from `file://…/dist-v3/renderer/index.html`. A sandboxed renderer that has been compromised via XSS (e.g., via a future injection in a third-party font or React component) could navigate to `file:///C:/Windows/System32/drivers/etc/hosts` or any other local file and render its contents in the window. Context isolation and sandbox prevent Node.js execution but do not prevent the *navigation itself* from succeeding.

**Concrete impact:** Defense-in-depth gap. If the renderer is ever compromised, local file contents become visible. It also violates the spirit of "navigation blocked" in the `ARCHITECTURE.md:175` security invariants list, which says navigation is blocked — but the check allows all `file:` URLs.

**Minimal fix:**

```typescript
const expectedRendererUrl = mainWindow?.webContents.getURL();
const allowed = useDevRenderer
  ? isRendererDevNavigation(targetUrl)
  : typeof expectedRendererUrl === "string" && targetUrl === expectedRendererUrl;
```

Since a loaded SPA only needs to navigate to its own origin for HMR in dev and nowhere in production, this is a zero-friction fix.

**Test:** Add a unit or smoke assertion that, after initial load, a `will-navigate` event with `file:///C:/Windows/win.ini` is blocked and `event.preventDefault()` is called.

---

### [High] Unbounded stderr from `candor-core` — memory and disk exhaustion risk

**File:** `electron/main.ts:313-315`

```typescript
child.stderr.on("data", (chunk: Buffer) => {
  console.error(`[candor-core] ${chunk.toString("utf8").trim()}`);
});
```

**Evidence:** There is no byte-count limit on stderr accumulation. Node.js buffers incoming `data` events; a panicking Rust process with a stack-overflow backtrace, or one caught in a crash-restart loop, will emit unbounded data. Each `data` event is synchronously logged to `console.error`, which on Windows routes to the Electron main-process event loop. On CI runners (60 min timeout) or in long recordings this will eventually OOM the main process or fill the log sink.

**Concrete impact:** Electron main process could be killed by OOM, taking down the app mid-recording without a graceful capture close. This is a pre-existing issue, confirmed as Phase 2 work in the plan (`bounded stderr and maximum JSONL line handling`).

**Minimal fix (Phase 2 scope but worth landing early):**

```typescript
let stderrBytes = 0;
const STDERR_BYTE_CAP = 1 * 1024 * 1024; // 1 MB
child.stderr.on("data", (chunk: Buffer) => {
  stderrBytes += chunk.length;
  if (stderrBytes > STDERR_BYTE_CAP) return;
  console.error(`[candor-core] ${chunk.toString("utf8").trim()}`);
  if (stderrBytes > STDERR_BYTE_CAP) {
    console.error("[candor-core] stderr limit reached; further output suppressed");
  }
});
```

**Test:** Spawn a substitute core binary that writes 2 MB to stderr before exiting. Assert the Electron process survives and the supervisor state transitions to `exited`, not `failed` with OOM.

---

### [Medium] Supervisor status exposes absolute core binary path to the renderer

**File:** `electron/main.ts:265-275` (`supervisorSnapshot`), `electron/main.ts:1772`

```typescript
ipcMain.handle("candor-shell:supervisorStatus", async () => supervisorSnapshot());
// supervisorSnapshot includes: coreSupervisor.executable (the full abs path)
```

**Evidence:** `coreSupervisor.executable` is set at line 259 to `corePath()`. In dev mode `corePath()` returns `path.resolve(__dirname, "..", "..", "build", "core-bin", ...)`, which expands to the full checkout path (e.g., `C:\Claude_Config\candor-v3-m0\build\core-bin\candor-core.exe`). The renderer can call `window.candor.shell.supervisorStatus()` and receive that path. In packaged mode it returns `process.resourcesPath + "/bin/candor-core"`, which is the absolute installation path.

**Concrete impact:** The checkout path leaks into any renderer that calls `supervisorStatus()`. This contradicts ARCHITECTURE.md line 81: "The core must not return… complete sensitive paths" (though that refers to the core, not the main process). In dev mode specifically it exposes the full developer checkout path to the sandboxed renderer. The `rawPathExposed: false` claim on the proof output is about *user recording paths*, but the distinction is not documented.

**Minimal fix:** Expose only diagnostically necessary fields (state, restartCount, pid) without the full executable path, or relativize the path before sending.

**Test:** In the renderer isolation probe already in `runRendererIsolationProbe`, assert that `supervisorStatus()` does not return a string containing the user's home directory or an absolute path that begins with a drive letter or `/home/`.

---

### [Medium] Secret scan covers only 5 source areas; active scripts are excluded

**File:** `scripts/source-security-rules.mjs:44-52`, `238-257`

```javascript
const trackedActivePaths = runGit(normalizedRoot, [
  "ls-files", "--",
  "electron",
  "v3/renderer/src",
  "crates/candor-core/src",
  "scripts/build-release-core.mjs",
  "scripts/electron-dev.mjs",
]).filter(isActiveSource);
```

**Evidence:** The secret pattern scan at line 241 iterates `trackedActivePaths`, which excludes the entire `scripts/` directory except two files. A hardcoded credential in `scripts/m0-packaged-smoke.mjs`, `scripts/m0-network-deny-windows.ps1`, or any other active script would not be detected. There are approximately 55 other active scripts.

**Concrete impact:** The source audit's `active-source:no-hardcoded-secrets` check can pass while secrets are present in the wider active codebase. The mutation self-test only injects a secret into `electron/main.ts`, so it does not prove the scan covers the full repo.

**Minimal fix:** Extend `trackedActivePaths` to include all tracked files in `scripts/`:

```javascript
const trackedActivePaths = runGit(normalizedRoot, [
  "ls-files", "--",
  "electron", "v3/renderer/src", "crates/candor-core/src", "scripts/",
]).filter(isActiveSource);
```

Update `isActiveSource` to return `true` for `scripts/**` files.

**Test:** Add a self-test case that injects a hardcoded secret into `scripts/m0-packaged-smoke.mjs` and asserts the audit fails.

---

### [Medium] `rawPathExposed: false` in smoke output is self-declared, not measured

**File:** `electron/main.ts:1418, 1229, 878`

```typescript
// In provePackagedDocumentExports, writeSmokeResult, etc.:
rawPathExposed: false,
keyMaterialExposedToRenderer: false,
```

**Evidence:** These fields are hardcoded into the smoke output by the code that generates it, not measured by scanning the actual response payloads. If `candor-core` returned a user recording path inside an export response (e.g., a filename embedded in the document metadata), the smoke proof would still report `rawPathExposed: false`.

**Concrete impact:** The proof provides false assurance. A core regression that leaks a user data path into an export field would not be caught by the current smoke.

**Note:** This is a pre-existing proof limitation that becomes more visible as the export and transcript path handling grows in Phases 4–6. The path binary scan (verifying the *compiled binary* doesn't contain paths) is a different and correctly implemented concern.

**Minimal fix for Phase 2:** After receiving export and recording payloads from core, scan response JSON for string fields matching absolute path patterns (`/^[A-Za-z]:\\/`, `/^\/home\/`). Fail if any are found before returning the proof.

**Test:** Modify the smoke fixture to inject a mock recording path into the response and assert the scan catches it.

---

### [Low] `core.shutdown` consumes an RPC ID with no pending entry

**File:** `electron/main.ts:685`

```typescript
core.stdin.write(JSON.stringify({ id: nextRpcId++, method: "core.shutdown", params: null }) + "\n");
```

**Evidence:** `nextRpcId` is incremented but no entry is pushed into `pending`. If the Rust core echoes back an `id`-bearing shutdown acknowledgment, `pending.get(response.id)` returns `undefined` and the response is silently dropped. This is intentional but fragile: a future Rust change that sends acknowledgment and expects the main process to act on it would silently break.

**Concrete impact:** None today. Fragility risk in future Rust protocol changes.

**Minimal fix:** Document the gap with a comment at line 685, or log the dropped shutdown acknowledgment explicitly.

---

### [Low] `sandbox: true` count check is anchored to a smoke-only BrowserWindow

**File:** `scripts/source-security-rules.mjs:128-134`

```javascript
const count = [...sourceText(input, main).matchAll(pattern)].length;
add(
  `electron-main:${id}`,
  count >= 2,
  main,
  `both BrowserWindow configurations require ${id}; observed ${count}`,
);
```

**Evidence:** The count of 2 for `sandbox: true` comes from:
1. The main window in `createWindow()` (line 589)
2. The smoke-only session probe window (line 1177) — created only during `runNetworkBlockProbe`

The audit comment says "both BrowserWindow configurations" but one is smoke infrastructure, not a production window. Removing the smoke probe window during Phase 2/3 refactoring would drop the count to 1 and fail the audit, forcing an explicit update — which is acceptable behavior but the description is misleading and could lead a developer to add `sandbox: true` in the wrong place to satisfy it.

**Minimal fix:** Rename the check to say "all BrowserWindow configurations" and document that the probe window is counted. Or switch to a check that rejects any `sandbox: false`.

---

### [Low] `build/core-bin/` binary is not hash-verified before spawn in `--start` mode

**File:** `electron/main.ts:231-236`, `scripts/electron-dev.mjs:123-129`

**Evidence:** `electron-dev.mjs` in `--start` mode checks that the file exists (line 127) but does not verify its hash. If `npm run build` fails mid-way through the core build step, the old binary from a previous run remains at `build/core-bin/candor-core.exe` and the `--start` path will launch it silently.

**Concrete impact:** Development-mode only. The release path (`app.isPackaged = true`) is not affected. CI always runs the full build-before-start sequence.

**Minimal fix:** In the electron-dev.mjs `--start` path, compare the file's mtime against `dist-v3/electron/main.js` and warn if the staged core is older than the current main build.

---

## Separate Observations (Not Defects)

**CSP: `style-src 'unsafe-inline'` is not audited.** `index.html:7` contains `style-src 'self' 'unsafe-inline'`. The audit checks `default-src 'self'` and `script-src 'self'` but not the style directive. CSS injection risk is lower than script injection but this is a missing coverage gap. The CSP meta tag also controls behavior when Electron renders `file://` content, so enforcement is confirmed by `webSecurity: true`.

**`corePath()` in non-dev non-packaged smoke.** When the packaged smoke runs the Candor.exe release build, `app.isPackaged = true`, so `corePath()` returns `process.resourcesPath + "/bin/candor-core"`. This path is included in the smoke JSON proof (`corePath:` field, line 1415) and uploaded as a CI artifact. The path exposes the CI runner's working directory. This is expected for CI artifacts and confirmed acceptable, but care should be taken if proof files are ever included in release packages (they are not currently — the `files:` stanza in `electron-builder.v3.yml` excludes them).

**`repoRoot` in `v3-verify.mjs` proof output.** `scripts/v3-verify.mjs:68` emits `repoRoot` into the local verification proof JSON. The same observation applies.

**RUSTFLAGS quoting with spaces.** `build-release-core.mjs:28-29` quotes `--remap-path-prefix=...` flags only when they contain spaces. The current `repoRoot` (`C:\Claude_Config\candor-v3-m0`) has no spaces, so this is not currently triggered. Windows paths with spaces (e.g., `C:\Users\First Last\projects`) could cause the remap flag to split when parsed by Cargo from `RUSTFLAGS`. Uncertain without a path-with-spaces test; `CARGO_ENCODED_RUSTFLAGS` is always safe (SOH-delimited). Consider always using `CARGO_ENCODED_RUSTFLAGS` to avoid the quoting problem entirely.

---

## Review Question Answers

**Q1 — Data access and v2 import:**
No regression. `crates/candor-core/src/v2_importer.rs` is present and unmodified; `fs::canonicalize` and `originalsUntouched: true` are confirmed. The app ID remains `com.candor.v3`, preserving OS application-data and key-storage identity. No runtime vault path, recording store, or importer source was deleted. This is clean.

**Q2 — Electron authority:**
Yes, genuinely Electron-authoritative. `src/`, `src-tauri/`, `vite.config.ts`, `tsconfig.json`, `index.html` (root), `scripts/tauri-dev.ps1`, and the Tauri workflow are all absent from the active tree (confirmed by glob). Root `dev`, `build`, `start`, `dist`, `preview` all resolve to Electron operations. The CI contract smoke enforces the workflow count to exactly one (`v3-m0.yml`). The `docs/v3-hybrid-architecture.md` file looks suspicious by name but its content correctly describes Electron-only architecture and references the archive tag.

**Q3 — Audit vacuousness:**
The five in-memory mutation tests are meaningful and correctly detect the most important failures: missing main source, disabled sandbox, generic preload capability, hardcoded secret, and weakened v2 importer. The `sourceText` function returning `""` for null sources ensures missing files fail, not pass. The primary remaining gap is the secret scan scope (see Medium finding above) — secrets in the broader `scripts/` directory are not covered.

**Q4 — Release-core build safety:**
The build approach is sound and portable with one caveat:
- The `stableBuildRoot` (`C:\CandorBuild\...` / `/tmp/CandorBuild/...`) is shared across builds on the same machine without commit-level namespacing. Two concurrent local builds would race at the Cargo target directory. In CI (isolated VMs) this is not a risk. For local double-builds it's benign because `copyFileSync` is atomic enough at the OS level, but if two different commits build concurrently on the same dev machine the staged binary could be from either.
- `[profile.release] strip = true` + `lto = true` in `Cargo.toml:57-59` correctly strips debug symbols that would otherwise embed source paths even after remap.
- The `copyFileSync` only runs on a zero exit code (`child.once("exit", ...)` at build-release-core.mjs:56), so a partial build cannot stage a corrupt binary. A *complete* build from a previous commit can, however, persist at `build/core-bin/`. This is the stale-binary Low finding above.
- macOS signing: the `binaries:` key in `electron-builder.v3.yml:33` correctly includes the sidecar for post-package code signing. The remap flags remove source paths from the binary before it reaches the signing step.

**Q5 — Product-name change impact:**
No path, signing, or proof breakage detected. `app.setAppUserModelId("com.candor.v3")` (main.ts:1780) is unchanged. The M0 proof audit was updated for the new process identity per the verification log. The installer artifact is now `Candor Setup 2.0.0.exe` and executable is `Candor.exe`. The `electron-builder.v3.yml` `productName: Candor` and `package.json` `"desktopName": "Candor"` agree.

**Q6 — Documentation overclaiming:**
The documentation does not overclaim. README:104-105 explicitly says: `"Signed installers, clean-machine upgrade proof, real long-duration capture, sleep and resume, and device-switch evidence remain mandatory release gates."` ARCHITECTURE.md:193-194 echoes this. The verification log explicitly lists all non-passing gates. No signed, notarized, or clean-machine claims are made. This is well-handled.

**Q7 — Blockers for Phase 2:**
No data-loss, data-access regression, or security control removal was found. The two High findings (unbounded stderr, overly-permissive file: navigation check) are both pre-existing and explicitly scoped to Phase 2 in the accepted plan.

---

## Phase 2 Go / No-Go

**Go. No blockers.**

The four tracked items that should be resolved before Phase 2 merges back to `main` (not before starting):

1. **(High)** Tighten `will-navigate` production guard to the exact renderer URL. One-line fix; eliminates a defense-in-depth gap before adding more renderer features.
2. **(High)** Bound the `child.stderr` handler to a fixed byte cap. Prevents OOM during any capture-adjacent Phase 2 work that exercises the core process.
3. **(Medium)** Redact or relativize `coreSupervisor.executable` before sending it to the renderer via `supervisorStatus`. The preload and declaration already expose this; making it explicit that the full path is intentionally sent (or removing it) removes ambiguity.
4. **(Medium)** Expand the secret scan to cover all tracked files in `scripts/`. Low-cost change, closes a real gap before the script surface grows in Phase 2.

The sequential integer IDs (Phase 3), proof self-declaration gaps (Phase 5/6), and stale-binary dev-mode risk (acceptable in dev) are tracked concerns for their respective phases.
