I have a complete picture. Here is the re-review verdict.

---

## Re-review: Commit `214b4be` against Phase 2 Protocol Findings

---

### 1. Verdict: **Go**

All nine findings from the prior review are closed. No new Critical or High defects were introduced.

---

### 2. H1 Disposition — Closed

**`captureActive` not cleared on unexpected exit**

Fixed exactly as specified. `core-client.ts:316` adds `this.captureActive = false` inside `handleExit` immediately after `this.handshakePromise = null`, making it the authoritative end-of-life reset.

Two regression tests were added with real fake-core processes:
- `"clears stale capture state when the core process exits"` — kills the child mid-capture and asserts `captureActive: false` afterwards. Directly exercises H1.
- `"keeps an active capture process alive when a later request times out"` — proves the inverse: a timeout during active capture leaves `captureActive: true` and `child.killed === false`. Closes M3 concurrently.

H1 is structurally closed and regression-guarded.

---

### 3. H2 Disposition — Closed

**Raw Rust error messages reaching the renderer**

The fix is a proper defense-in-depth chain rather than a single replacement:

**Main process (`renderer-boundary.ts`):** `rendererSafeCoreError(code)` validates `code` against `/^[A-Z][A-Z0-9_]{1,63}$/` before constructing `CANDOR_CORE_ERROR:<CODE>`. Any code failing the regex — including paths, serde_json text, or `undefined` — becomes `CORE_REQUEST_FAILED`. All Rust static error codes (`&'static str`) pass this regex.

**`core-ipc.ts` routing:** Three catch paths all route through `rendererSafeCoreError`. The `if (error.message.startsWith("CANDOR_CORE_ERROR:")) throw error` arm cleanly re-passes already-safe errors without double-wrapping. A source-security `excludes` rule bans the old `response.error?.message` pattern and is mutation-tested.

**Renderer side (`candor-client.ts`):** `bridgeErrorCode` re-extracts the code with the same regex. The renderer never sees raw Rust text regardless of IPC transport behavior.

**Packaged smoke proof:** The smoke invokes `core.recordingDurableRead("../private-vault")` from inside the packaged renderer. `assertSmokePayload` fails if the error string contains `"private-vault"` or if the structured code is not exactly `INVALID_RENDERER_INPUT`. The packaged binary passed this check.

H2 is structurally closed, source-audited, mutation-tested, and runtime-proven in the packaged artifact.

---

### 4. New Critical/High Findings

**None.**

The commit was inspected for common introduction risks:

- **Error re-catch in `core-ipc.ts`**: The `try` block's `throw rendererSafeCoreError(...)` enters the `catch` block; the `startsWith("CANDOR_CORE_ERROR:")` guard re-throws it cleanly. Only values produced by `rendererSafeCoreError` can satisfy that check. No unsafe message can manufacture this prefix.
- **`rendererSnapshot()` field enumeration**: Returns `state`, `restartCount`, `startedAt`, `executableName` (basename via `path.basename`), `rawPathExposed: false`, sanitized `lastExit` (with `hadError: boolean`), `lastHandshake`, `captureActive`. Full path and PID are absent. No regression from the Phase 1 executable-path fix.
- **`sanitizeCoreResultForRenderer`**: Correctly scoped to `core.status` only, where `pid` appears. No other current method returns a PID in its result.
- **L1 spawn-failure fix**: `isRestart` is captured before the spawn attempt; `restartCount` increments only after `child` is successfully assigned. The synchronous-failure test confirms `restartCount: 0` and that `rendererSnapshot()` contains no path text from the thrown exception.
- **Parameterless ping**: Preload and validator both updated. No regression path for arbitrary JSON echo.

**One minor observation (not a new finding):** The mutation test suite covers `callback(false) → callback(true)` for `permission-request-false` but does not have a paired mutation for `permission-check-false` (`return false`). The `permission-check-false` finding is covered by a direct behavioral unit test (`denyPermissionCheck()` returns `false`) and an `includes` source rule, so the residual risk is low. This does not block decomposition but should be noted for the M1 audit backlog.

---

### 5. Renderer Decomposition

**May proceed.**

The blocking condition from the prior review was H2: the renderer lacked a typed error boundary and received raw Rust strings. That is now resolved. The renderer has:
- A stable, bounded error contract: `CANDOR_CORE_ERROR:<SAFE_CODE>` with regex-validated codes.
- A clean `rendererSnapshot()` that omits PID and protocol fault text.
- 43 fixed named channels (no generic IPC selector).
- Per-method input validation before any payload crosses into Rust.

All prior blockers are closed. Renderer decomposition may proceed.
