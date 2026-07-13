I now have sufficient evidence to write the complete review. Here is the adversarial implementation review.

---

## Implementation Review: SPEC-2 `codex/post-consolidation-hardening`

Reviewed commit `918ee24` against `origin/main` at `1f9b87e`. All findings are from code inspection only; I did not modify any files.

---

## Findings (ordered by severity)

---

### Finding 1 — Medium: `handleTimeout` blind kill during capture-start, contradicting "no blind core kill"

**Severity:** Medium
**Location:** `electron/core/core-client.ts:583–591`

```typescript
private handleTimeout(method: string): void {
  if (this.captureActive) {          // ← only checks confirmed-active
    this.enterCaptureRecovery(method);
    return;
  }
  this.supervisor.state = "failed";
  this.protocolFault = "candor-core became unresponsive";
  this.child?.kill();                // ← blind kill
}
```

`captureActive` is `false` until a successful `capture.startMic/System/MicAndSystem` response is received. If that response never arrives (15-second timeout), `captureActive` is still false and the handler kills the core. The Rust side may already have opened the audio device and started writing audio chunks — this kill loses that in-flight data.

The existing `captureGuardPhase()` method correctly returns `"starting"` when a capture-start call is pending in `this.registry`:

```typescript
captureGuardPhase(): CaptureGuardPhase {
  if (this.registry.hasAnyMethod(CAPTURE_START_METHODS)) return "starting";
  return this.captureActive ? "recording" : "idle";
}
```

But `handleTimeout` doesn't use it.

**User/security impact:** A slow audio-device initialization (common on Windows with exclusive-mode WASAPI devices) that exceeds 15 seconds causes a core kill, losing any audio already buffered in the Rust side, and no recovery metadata is written. The spec explicitly forbids blind core kills during degraded capture.

**Fix:** Change the condition in `handleTimeout` to cover the starting phase:
```typescript
if (this.captureActive || this.registry.hasAnyMethod(CAPTURE_START_METHODS)) {
  this.enterCaptureRecovery(method);
  return;
}
```

**Test that must prove it:** A test in `controllable-core.test.ts` using a mode that hangs specifically on `capture.startMic` (not on all post-handshake methods), verifying that the supervisor enters `"capture-connection-degraded"` rather than `"failed"` on timeout, and the child process is not killed.

---

### Finding 2 — Medium: `retryConnection()` silently clears `captureRecoveryRequired`, bypassing `recording.durable.recover`

**Severity:** Medium
**Location:** `electron/core/core-client.ts:219–238` (retryConnection), `electron/core/core-client.ts:568–580` (updateCaptureState)

When the Rust core process exits during an active recording:

1. `handleExit()` → `enterCaptureRecovery("core.processExit")` — sets `captureRecoveryRequired = true`, persists recovery file, but clears `captureActive = false`.
2. The renderer polls `getConnectionStatus()` (1 s interval). Returns `{ state: "capture-connection-degraded", captureRecoveryRequired: true }`.
3. The renderer's separate `captureStatus` polling keeps failing (core is down), so `captureStatus.active` remains stale at `true`.

In `AppRouteOutlet.tsx`:
```tsx
const activeCapture = asBool(runtime.captureStatus.active);  // stale: true
const connectionDegraded = asString(runtime.connectionStatus.state) === "capture-connection-degraded";

if (connectionDegraded && activeCapture) {
  // Shows "Try to reconnect" alert — correct path since capture looks active
}
if (asBool(runtime.connectionStatus.captureRecoveryRequired) && !activeCapture) {
  // "Recover recording" screen — never shown because !activeCapture is false
}
```

User clicks "Try to reconnect" → `api.app.retryCore()` → main-process `retryConnection()`:
```typescript
if (this.supervisor.state === "capture-connection-degraded") {
  const response = await this.call("capture.status");  // new core: active: false
  // updateCaptureState runs synchronously from handleStdout before this resumes:
  //   captureRecoveryRequired = false
  //   resolveCaptureRecovery() → captureRecoveryStore.clear()
  this.supervisor.state = "running";
  return this.rendererSnapshot();  // captureRecoveryRequired: false
}
```

`recording.durable.recover` RPC is never called. Recovery file is cleared. The renderer sees state "running", `captureRecoveryRequired: false`, and shows nothing to the user about quarantined or recovered recordings.

The Rust core auto-runs `recording_store.recover()` on startup (`main.rs:204–207`), so actual data loss risk depends on what that cleanup covers. But the explicit `recording.durable.recover` RPC returns a richer result (`recoveredCount`, `quarantinedCount`, `completedDeletionCount`) that the renderer is supposed to surface via the recovery screen. That screen is permanently bypassed in this path.

**User/security impact:** User loses visibility into what happened to their recording after a core crash. If recordings were quarantined, the user does not know. The persistence file is cleared without acknowledgement.

**Fix:** Do not clear `captureRecoveryRequired` in `updateCaptureState` when called from the degraded retry path. Instead, leave it set and let the renderer explicitly go through `recoverCapture()`. One implementation: store a flag `private retryConnectionActive = false` and skip the recovery clear in `updateCaptureState` when that flag is set. Alternatively, issue `recording.durable.recover` inside `retryConnection()` when transitioning out of degraded state with `captureRecoveryRequired = true`.

**Test that must prove it:** Core dies while `captureActive = true`, `retryConnection()` is called, verify that `snapshot().captureRecoveryRequired` is still `true` after the call returns successfully. This test does not currently exist.

---

### Finding 3 — Low: Rust core accepts bare requests without protocol-version validation

**Severity:** Low
**Location:** `crates/candor-core/src/main.rs:1775–1776`

```rust
fn validate_request_envelope(request: &RpcRequest) -> Result<(), RpcResponse> {
    let metadata_count = [
        request.protocol_version.is_some(),
        request.request_id.is_some(),
        request.sent_at.is_some(),
    ].into_iter().filter(|p| *p).count();
    if metadata_count == 0 {
        return Ok(());   // ← bare request bypasses all envelope validation
    }
    ...
    if request.protocol_version.as_deref() != Some(PROTOCOL_VERSION) {
        return Err(make_error(..., "PROTOCOL_VERSION_MISMATCH", ...));
    }
```

A bare `{"id":"x","method":"core.status","params":{}}` (no `protocolVersion`, no `requestId`, no `sentAt`) passes validation and is dispatched to `handle_request`. The protocol-version guard is only active when any of the three metadata fields are present.

The TypeScript client always sends all three fields (`createCoreRequest`), so this gap is not normally reachable. However, any process that can write to the Rust core's stdin — including a compromised Electron main process — can call any method without version alignment.

**User/security impact:** Low. The Rust core is a local stdio-only process. A compromised Electron main process could reach `handle_request` via this route, but it could also send a fully-enveloped request. No privilege escalation beyond what the main process already has.

**Fix:** Require metadata_count to be exactly 3 or exactly 0-as-error:
```rust
if metadata_count != 3 {
    return Err(make_error(..., "INVALID_RPC_ENVELOPE", "..."));
}
```

**Test that must prove it:** Add a Rust test that sends a bare `{"id":"x","method":"core.version","params":{}}` and asserts the response code is `INVALID_RPC_ENVELOPE`, not a success or `PROTOCOL_VERSION_MISMATCH`.

---

### Finding 4 — Low: `candor-export:saveLocal` is a registered but dead handler still calling the sync `export.create` path

**Severity:** Low
**Location:** `electron/ipc/export-ipc.ts:81–153`

The renderer's preload exposes only:
```typescript
exports: {
  create: (input: JsonValue) => invoke("candor-export:start", input),  // job path
  saveCompleted: (jobId: string) => invoke("candor-export:saveCompleted", { jobId }),
  cancel: (jobId: string) => invoke("candor-jobs:cancel", { jobId }),
}
```

`candor-export:saveLocal` is registered in `registerExportIpc` but is not reachable from the renderer via the preload. The `useReportWorkflow` code confirms the renderer only uses `exports.create` + `exports.saveCompleted`.

The handler calls `dependencies.core.call("export.create", input)` (sync path) and expects raw bytes back. If the Rust core's `export.create` is job-based (returns a job ID), `decodeLocalExportResult` would silently receive a job-start envelope and likely return corrupted output.

**User/security impact:** The handler is not currently reachable and cannot be called by the renderer. However: (a) it creates confusion about which export path is authoritative; (b) a future accidental re-exposure would bypass the job lifecycle and serve unvalidated output; (c) the `saveLocal` path calls `decodeLocalExportResult` without going through `validateCompletedJobResult`, meaning the Rust result bytes would reach the filesystem without the type-discriminated schema check.

**Fix:** Remove the `candor-export:saveLocal` handler entirely. If a synchronous export path is ever needed again, it should be re-added with explicit acknowledgment of its differences from the job path.

**Test that must prove it:** `protocol.test.ts` already verifies preload channels against `rendererCoreOperations`. A parallel check should assert that no registered `ipcMain.handle("candor-export:...")` channel exists outside the preload-exposed set.

---

### Finding 5 — Low: New security-critical files absent from `requiredSourcePaths`

**Severity:** Low
**Location:** `scripts/source-security-rules.mjs:5–42`

Four files introduced in this branch contain trust-boundary logic that the security audit does not explicitly require to exist:

- `electron/core/operation-registry.ts` — parameter schema enforcement
- `electron/security/validate-private-core-input.ts` — private-scope input contracts
- `electron/core/capture-recovery-store.ts` — recovery file write with atomic rename and field allowlisting
- `electron/ipc/jobs-ipc.ts` — job-level IPC sender validation and recovery acknowledgement

If any of these files were absent or emptied (e.g., by a bad merge), `v3:verify` would not fail on a "required-source" check. The broader `trackedActivePaths` scan catches secret patterns but does not verify the presence of these files.

**User/security impact:** The security CI gate would pass with a removed `validate-private-core-input.ts`, meaning arbitrary private-core params from the renderer would reach the Rust core without validation.

**Fix:** Add the four files to `requiredSourcePaths`. Add a paired `includes()` check for a distinctive token in each (e.g., `validatePrivateCoreParams` for the input validator, `SAFE_METHOD.test` for the recovery store).

---

### Finding 6 — Low: `capture.status` result schema omits `activeSession`, leaving `activeRecordingId` tracking unguarded against Rust-side schema drift

**Severity:** Low
**Location:** `electron/core/operation-registry.ts:48`

```typescript
{ method: "capture.status", ..., result: {
  implemented: "boolean", active: "boolean", sources: "object", rawPathExposed: "boolean"
}}
```

`updateCaptureState` reads `activeSession.recordingId` from the response to populate `activeRecordingId` (used in recovery metadata). Since `jsonObjectResultSchema` only checks required fields and passes extra fields through unchanged, this works now. But `activeSession` is completely outside the validated contract. If the Rust side renames or removes `activeSession`, `activeRecordingId` silently becomes null and all recovery metadata records `recordingId: null`.

**Fix:** Add `activeSession: "object"` to the `capture.status` result schema. A custom parser can make it optional (`field in value ? validate : skip`).

---

## Plan deviations

**"No blind core kill" — partially violated.** The accepted plan states: "Define degraded capture state and recovery metadata behavior" with "no automatic core kill." The `handleTimeout` method kills the core when `capture.startMic` is in-flight and times out (Finding 1). The `captureGuardPhase()` helper already models the "starting" phase; it is simply not consulted in `handleTimeout`.

**Renderer-reload job recovery** — correctly implemented. Jobs survive renderer reloads; the Rust in-memory store is the authority. Core restarts lose jobs, which is consistent with the design.

**Bounded retry** — the spec's acceptance check for phase 6 mentions "bounded reconnect attempts exactly N times." The current implementation makes retry user-triggered with no automatic retry counter. This may be intentional given the spec's language, but the acceptance check criterion is not met as stated.

**Preload v1 removal** — completely clean. No `window.core`, no dual surface. The plan's accepted rejection of the dual-surface approach is faithfully implemented.

---

## Uncertainties

1. **`export.create` Rust behavior.** `export-ipc.ts:saveLocal` calls `export.create` expecting a direct result (bytes). The operation registry labels it `mode: "job"`. Whether the Rust core dispatches `export.create` synchronously or into the job manager cannot be confirmed from TypeScript alone. If it is job-based on the Rust side, `saveLocal` silently receives a job-start envelope and the file-save path produces garbage without a schema error.

2. **`job_manager.rs` list sort.** `values.sort_by(...)` then `json!({ "jobs": values, "jobCount": values.len() })` — the expression order inside serde_json's `json!` macro determines whether `values` is borrowed or moved first. The code compiled and 86 Rust tests passed, but the evaluation order inside `json!` is non-obvious without inspecting the macro expansion. If `values` is moved before `values.len()` is evaluated, this would be a compile error the compiler is somehow eliding — or the macro borrows all values by reference, which would make the code correct.

3. **`retryConnection()` in the degraded-due-to-hang case.** When the core is alive but unresponsive (timeout, not exit), `captureActive` remains `true`. In this case, `retryConnection()` → `call("capture.status")` → if the core now responds, `updateCaptureState` clears the degraded state (including `captureRecoveryRequired`). This is correct because if the core recovered, recovery is no longer needed. The bug in Finding 2 is specific to the process-exit case where `captureActive` is cleared by `handleExit`. I cannot prove from code alone that the renderer correctly distinguishes these two paths during the 1-second polling window.

4. **`recording.durable.recover` RPC vs startup auto-recovery.** The Rust core runs `recording_store.recover()` on every startup. The explicit RPC appears to re-expose that result to the renderer. If auto-recovery is complete and idempotent, the explicit RPC call is only for result reporting, not for triggering recovery. If the explicit call does meaningful work beyond reporting, then bypassing it (Finding 2) causes data loss, not just an informational gap. Rust source for `recording_store.recover()` was not inspected.

---

## Verdict

**Changes required.**

Two defects require resolution:

1. `handleTimeout` must use `captureGuardPhase()` (or an equivalent check on `CAPTURE_START_METHODS`) to avoid killing the core during a slow capture start. This is a direct violation of the spec's "no blind core kill" requirement and is testable with a deterministic hang mode.

2. `retryConnection()` must not silently clear `captureRecoveryRequired` when it is set. The "Try to reconnect" user path permanently bypasses the recovery acknowledgement screen and the explicit `recording.durable.recover` RPC. The fix and the test for it are straightforward.

Findings 3–6 are non-blocking: Finding 3 (bare-request envelope) is low-risk given the stdio-only transport; Findings 4–6 are maintenance gaps that do not affect current user-visible behavior. They can be addressed as follow-ups before the next release gate.
