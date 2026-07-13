I now have a complete picture of the codebase. Let me compile the full adversarial review.

---

## Protocol Boundary Review: Electron Main / Rust IPC — Commits `1f1afa3`–`6039f02`

---

### Verdict: **Go with required fixes**

Two findings must be resolved before renderer decomposition ships: one latent state-machine bug (`captureActive` not cleared on unexpected exit) and one boundary contract gap (raw Rust error messages crossing into the renderer). Both are localized fixes with no architectural implications. Everything else is medium or lower.

---

## Findings

---

### HIGH — H1: `captureActive` not cleared on unexpected core exit

**File:** `electron/core/core-client.ts` — `handleExit` lines 271–291, `handleTimeout` lines 328–333

**Evidence:**
```ts
// handleExit — captureActive is never reset
private handleExit(child, code, signal): void {
  if (this.child !== child) return;
  const wasStopping = this.supervisor.state === "stopping";
  this.child = null;
  this.handshakePromise = null;
  // ← captureActive is not touched
  ...
}

// handleTimeout — reads stale captureActive
private handleTimeout(): void {
  this.supervisor.state = "failed";
  if (!this.captureActive) {          // ← could be wrong after restart
    this.protocolFault = "candor-core became unresponsive";
    this.child?.kill();
  }
}
```

**Impact:** If the core crashes with capture active: (1) `captureActive` stays `true`; (2) the next `call()` invocation triggers `start()` and spawns a fresh core — which has no capture in progress; (3) if a request to the fresh core times out, `handleTimeout` reads `captureActive = true` and skips the kill, leaving a zombie supervisor in `state: "failed"` with a live, unresponsive child process. The app cannot self-recover without a full restart.

**Concrete fix:**
```ts
private handleExit(child, code, signal): void {
  if (this.child !== child) return;
  const wasStopping = this.supervisor.state === "stopping";
  this.child = null;
  this.handshakePromise = null;
  this.captureActive = false;          // ← add this line
  ...
}
```

Alternatively, reset `captureActive = false` inside `start()` so it is always cleared when a new process begins. Either location is correct; `handleExit` is clearer because it is the definitive end-of-life event.

**Blocks renderer work?** No, but must be fixed before any flow that exercises sidecar restarts ships.

---

### HIGH — H2: Raw Rust error messages forwarded to renderer without filtering

**File:** `electron/ipc/core-ipc.ts` line 18

**Evidence:**
```ts
if (!response.ok) throw new Error(response.error?.message ?? "candor-core request failed");
```

Rust's `decode_params` at `main.rs:368` produces:
```rust
format!("invalid request parameters: {err}")  // serde_json error text
```
serde_json error text includes field names and, for type mismatches, partial field values. Domain error messages from `RecordingStoreError`, `CaptureError`, `ConsentError`, etc. have free-form `message` fields whose content cannot be audited in this review (service implementations not in scope). Any raw path, key identifier, or system detail inside those messages would cross the trust boundary and appear in renderer JS.

**Impact:** Violates the explicit `deniedCapabilities: rendererRawPaths` and `rendererVaultKeys` guarantees stated in the threat model. A compromised renderer could also read error messages to fingerprint internal state.

**Concrete fix:**
```ts
// core-ipc.ts
if (!response.ok) {
  const code = response.error?.code ?? "CORE_ERROR";
  throw new Error(code);   // renderer receives only structured error codes
}
```
The renderer maps codes to localized display strings. This approach also gives the renderer decomposition a stable error contract to type against.

**Blocks renderer work?** Yes. The renderer decomposition phase requires a typed error boundary; raw string forwarding prevents that.

---

### MEDIUM — M1: `recording.notes.save` validates by character count, not byte count

**File:** `electron/security/validate-core-input.ts` line 274

**Evidence:**
```ts
if (typeof value.markdown !== "string" || value.markdown.length > INPUT_LIMITS.notesCharacters)
```
`INPUT_LIMITS.notesCharacters = 2_000_000` (characters). A string of 2M four-byte UTF-8 characters (e.g., emoji) passes the character check but produces up to 8 MB of UTF-8 bytes. The 4 MB RPC line check (`core-client.ts:119`) would then reject it with `CORE_PROTOCOL_FAULT` rather than a clean validation error.

**Impact:** Not a security bypass — the frame limit enforces the boundary — but the renderer receives an opaque protocol error instead of "notes too long."

**Concrete fix:** Add a byte-count check:
```ts
if (
  typeof value.markdown !== "string" ||
  value.markdown.length > INPUT_LIMITS.notesCharacters ||
  Buffer.byteLength(value.markdown, "utf8") > 3_900_000   // leaves headroom for envelope
)
```

**Blocks renderer work?** No.

---

### MEDIUM — M2: Core process PID visible to renderer via `core.status`

**File:** `crates/candor-core/src/main.rs` line 499

**Evidence:**
```rust
pid: process::id(),   // included in core.status JSON result
```
`window.candor.core.status()` returns this value to the renderer. The capability matrix (`main.rs:481`) explicitly lists `rendererRawPaths` as denied, but a PID is a process-level identifier.

**Impact:** A compromised renderer can target the core process for local signals, ptrace inspection, or process-substitution attacks on platforms that allow cross-process operations to same-UID processes. Minor, but contradicts the stated denied-capabilities intent.

**Concrete fix:** Remove `pid` from the `core.status` serialised output. If PID is needed for diagnostics, expose it only in the Electron supervisor snapshot (`snapshot()` already has `pid: this.supervisor.pid`) which is main-process-only data not forwarded to the renderer.

**Blocks renderer work?** No.

---

### MEDIUM — M3: No test for timeout-while-capture-active behavior

**File:** `electron/core/core-client.test.ts` — missing test

**Evidence:** Test 4 ("bounds a hung request") covers the non-capture timeout path (core is killed, state becomes "failed"). The capture-active timeout path (`handleTimeout` lines 330–333) — where the core must **not** be killed — has no test. The threat model document at `docs/proofs/M0_IPC_THREAT_MODEL.md` explicitly documents this behavior.

**Impact:** A one-line regression in `handleTimeout` (removing the `captureActive` guard) would kill the core during an active recording without any failing test.

**Concrete fix:** Add a test:
```ts
it("does not kill a core that times out while capture is active", async () => {
  // Core reports capture active, then goes silent
  const client = new CoreClient({ ..., spawnCore: () => spawnNode(capturingThenSilentCore()) });
  await client.ensureHandshake();
  // Trigger timeout on a second request with a short timeout
  await expect(client.call("core.status", null, 25)).rejects.toThrow("timed out");
  await new Promise(r => setTimeout(r, 30));
  expect(client.snapshot()).toMatchObject({ state: "failed", captureActive: true });
  // The child must still be alive (not killed)
  expect(/* child.killed */).toBe(false);
});
```

**Blocks renderer work?** No, but should be added before the M1 capture milestone.

---

### MEDIUM — M4: Source-security checks for permission handlers verify presence, not correctness

**File:** `scripts/source-security-rules.mjs` lines 133–134

**Evidence:**
```js
["permission-request-denied", "setPermissionRequestHandler"],
["permission-check-denied", "setPermissionCheckHandler"],
```
These checks confirm the string appears in `electronRuntimeSource`. A no-op call like `session.setPermissionRequestHandler(null)` — which removes the deny handler and falls back to Chromium defaults — would pass the check.

**Impact:** If the deny handler is accidentally weakened, the source-security audit would not catch it, potentially allowing the renderer to request microphone, camera, or screen-capture permissions directly.

**Concrete fix:**
```js
["permission-request-denied", "callback(false)"],
["permission-check-denied", "return false"],
```
Or add a paired `excludes` check that the handler never calls `callback(true)` unconditionally.

**Blocks renderer work?** No.

---

### LOW — L1: `restartCount` incremented before spawn succeeds

**File:** `electron/core/core-client.ts` line 196–198

**Evidence:**
```ts
if (this.hasStarted) this.supervisor.restartCount += 1;
this.hasStarted = true;
// spawn happens next
const child = (this.options.spawnCore ?? defaultSpawnCore)(executable);
```
If `spawnCore` throws synchronously, `restartCount` is already incremented and `hasStarted` is already `true`.

**Impact:** `snapshot()` would report inflated `restartCount` after a spawn failure. Minor diagnostic inaccuracy.

**Fix:** Move the increment into the `spawn` event callback.

**Blocks renderer work?** No.

---

### LOW — L2: `core.ping` echoes unbounded-content renderer input back through Rust

**File:** `validate-core-input.ts:227` and `main.rs:380–383`

**Evidence:** `core.ping` accepts any JSON up to 1 MB. Rust echoes `req.params` verbatim in `{ "pong": true, "echo": req.params }`. The renderer controls what it sends and receives; there is no information gain. However, this is an unrestricted JSON round-trip path that bypasses the per-method field allowlist pattern used by every other method.

**Impact:** Negligible in isolation. The concern is that future callers might use ping as a general-purpose JSON transport without realizing it bypasses the method-specific field enforcement philosophy.

**Fix:** Optional. If ping is intended only for latency checks, restrict its echo to a boolean or small struct rather than arbitrary JSON.

---

### LOW — L3: `supervisorStatus` exposes `lastExit.error` (protocolFault message) to renderer

**File:** `electron/core/core-client.ts` lines 93–105 (`snapshot()`), forwarded by `core-ipc.ts:29–31`

**Evidence:**
```ts
lastExit: this.supervisor.lastExit,  // includes: error: this.protocolFault
```
`protocolFault` contains messages like `"candor-core response exceeded the JSONL boundary limit"` — implementation details without sensitive data. Currently no message includes paths, but if the protocol fault message were ever widened, it would reach the renderer.

**Fix:** Filter `lastExit.error` from the snapshot before returning to renderer, or return only a boolean `lastExit.hadError`. Low priority.

---

## Legacy Envelope Compatibility Assessment

**Conclusion: Safe as structured, with one documentation obligation.**

The dual-path is sound because the two consumers are genuinely isolated:

- **Production Electron path**: `CoreClient` always generates the full versioned envelope (`protocolVersion`, `requestId`, `sentAt`). `parseCoreResponseLine` requires `requestId` to match `id` as a string — a legacy response with `request_id: None` would fail this check immediately. The versioned path cannot accidentally receive legacy responses.

- **Proof-script path**: M0–M5 scripts communicate with Rust over their own spawned stdio process, not through `CoreClient`. They use legacy numeric IDs and never invoke `parseCoreResponseLine`.

The interaction risk is zero because these paths share no process. The deduplication logic in Rust (`recent_request_ids.insert`) correctly applies to both paths, with legacy IDs keyed by their JSON-serialised form (e.g., `"1"` for `id: 1`) — type-distinct from versioned UUIDs (`"\"uuid-here\""`).

**One obligation:** When proof scripts eventually migrate to the versioned envelope, the `validate_request_envelope` all-or-nothing rule (`metadata_count` must be 0 or 3) is the correct migration gate. The check at `main.rs:1288–1298` correctly enforces this. No code change needed; migration should be tracked.

---

## Capture-Active Timeout Assessment

**Conclusion: Semantics are intentional and correctly documented; one behavioral edge case is the already-reported H1.**

When capture is active and a request times out:
1. `handleTimeout()` sets `supervisor.state = "failed"` and does **not** kill the child.
2. The timed-out request rejects via the registry timer.
3. The child remains alive; future `call()` invocations can still write to its stdin.

This is the correct tradeoff for M0: losing in-flight audio is worse than having a "failed" supervisor that is still running. However:

- **State inconsistency**: `supervisor.state = "failed"` while the core may still be processing. Future requests that succeed don't update state back to `"running"`. The state stays `"failed"` indefinitely. The renderer receives no active notification of degraded state and must poll `supervisorStatus()`. This is an acceptable gap for M0 but should be addressed with an event channel in M1.

- **No self-recovery path**: Once the supervisor enters `"failed"` during capture, it cannot return to `"running"` without an explicit `capture.stop` + restart cycle. The `call()` method doesn't check supervisor state before writing (by design — it only checks `child.killed` and `stdin.writable`). This is correct for the capture-active scenario but means callers cannot distinguish "failed and actively capturing" from "failed and unusable."

The fix for H1 (resetting `captureActive` on exit) removes the only genuinely wrong behavior in this path.

---

## Optional Improvements

1. **Add a `recovering` supervisor lifecycle state.** When the core exits unexpectedly and auto-restarts on the next `call()`, the state transitions `exited/failed → starting` without an observable `recovering` state. The renderer decomposition phase will want to distinguish "recovering after crash" from "first boot."

2. **Filter or restrict `supervisorStatus` for renderer consumption.** `snapshot()` was designed for main-process diagnostics. Consider a separate `rendererSnapshot()` that omits `pid`, caps `lastExit.error` to a boolean, and excludes `executable` (even though it's already a basename).

3. **Handshake failure should gate window creation.** `main.ts:108–113` logs the handshake error and creates the window anyway. The renderer sees core unavailable immediately on load. A brief handshake timeout with an error overlay would give a better failure mode than a blank/unresponsive window.

4. **Rust duplicate-ID window of 1024 is static.** With event subscriptions and job cancellation planned, the in-flight request count will grow. The window should scale with expected concurrency.

5. **The `permission-request-denied` and `permission-check-denied` handlers** — once verified correct (see M4) — should have their callback patterns tested directly in `network-policy.test.ts`, not just via source-security regex.

---

## Uncertainties

1. **Rust domain error message content.** `RecordingStoreError`, `CaptureError`, `ConsentError`, `VaultStoreError`, and the others all have free-form `message: String` fields. H2 is rated High on the conservative assumption that some message could include an internal path, key name, or system detail. Confirming these messages are safe to forward would let H2 be downgraded to Medium. The service files are outside this review's scope.

2. **`network-policy.ts` permission handler implementation.** M4 flags the source-security check as presence-only. The actual deny logic in `installSessionHardening` / `applyChromiumNetworkPolicy` is not in scope here but should be confirmed to call `callback(false)` unconditionally for all permission types.

3. **`import-ipc.ts`, `models-ipc.ts`, `export-ipc.ts`, `licensing-ipc.ts`.** These handle native pickers and file streaming and are explicitly out of scope. If any of them returns a raw file path to the renderer (even as confirmation), it would be a Critical finding. Recommend a separate review of these four IPC modules before the file-import renderer flows ship.

4. **Electron `senderFrame` reference equality.** `validate-sender.ts:13` checks `senderFrame === windowIdentity.mainFrame`. This relies on Electron maintaining stable object references for the main frame across reloads. If Electron recycles the frame object on `reload()`, the check could produce a false positive for the first IPC call after a reload. Low probability but not verified against Electron internals.

---

## Summary Table

| ID | Severity | File | One-line Description | Blocks Renderer |
|----|----------|------|----------------------|-----------------|
| H1 | **High** | `core-client.ts:271` | `captureActive` not cleared on unexpected exit | No (fix before restart flows) |
| H2 | **High** | `core-ipc.ts:18` | Raw Rust error messages reach renderer | **Yes** |
| M1 | Medium | `validate-core-input.ts:274` | Notes validated by chars not bytes | No |
| M2 | Medium | `main.rs:499` | Core PID accessible to renderer | No |
| M3 | Medium | `core-client.test.ts` | No test for capture-active timeout | No |
| M4 | Medium | `source-security-rules.mjs:133` | Permission handler checks are presence-only | No |
| L1 | Low | `core-client.ts:196` | `restartCount` incremented before spawn | No |
| L2 | Low | `validate-core-input.ts:227` | `core.ping` echoes arbitrary JSON | No |
| L3 | Low | `core-client.ts:100` | `lastExit.error` (protocolFault) in renderer snapshot | No |

**Required before renderer decomposition:** H2 only. H1 is required before any flow exercising sidecar restarts ships but does not block the decomposition itself.
