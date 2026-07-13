I have all the evidence I need. Here is the follow-up review.

---

## Follow-up Review: SPEC-2 `codex/post-consolidation-hardening`

**`git diff --check`:** Passed. CRLF line-ending conversion warnings only — no whitespace errors.

---

### Finding 1 — Resolved

The fix at `electron/core/core-client.ts:583–586`:

```typescript
if (this.captureActive || CAPTURE_START_METHODS.has(method)) {
  if (CAPTURE_START_METHODS.has(method)) this.captureActive = true;
  this.enterCaptureRecovery(method);
  return;
}
```

Using `CAPTURE_START_METHODS.has(method)` directly (rather than `this.registry.hasAnyMethod(CAPTURE_START_METHODS)`) is correct: the timeout handler removes the registry entry before `handleTimeout` is called, so querying the registry would always return false. Checking the `method` argument is the right approach.

Setting `captureActive = true` before `enterCaptureRecovery` ensures Stop is callable and the snapshot exposes `captureActive: true`. `enterCaptureRecovery` records `recordingId: this.activeRecordingId` (null for a timed-out start, which is acceptable).

The `hang-during-capture-start` mode in `controllable-core.mjs:88–91` hangs only on `capture.startMic`, which is the correct scope. The test at `controllable-core.test.ts:128–169` proves all six required behaviors:

| Assertion | Result |
|---|---|
| capture start times out | `rejects.toThrow("timed out")` ✓ |
| child not killed | `child.killed === false` ✓ |
| degraded state visible | `state: "capture-connection-degraded"` ✓ |
| recovery required set | `captureRecoveryRequired: true` ✓ |
| capture guarded active | `captureActive: true` ✓ |
| Stop succeeds and clears recovery | `state: "running", captureActive: false, captureRecoveryRequired: false` ✓ |

One non-blocking style note: `CAPTURE_START_METHODS.has(method)` is evaluated twice in the condition. Correct in a single-threaded async context, just slightly redundant.

**Status: RESOLVED.**

---

### Finding 2 — Correctly withdrawn

The tracing in the rejection is confirmed by reading `handleExit` (lines 504–528) and `retryConnection` (lines 219–238) together:

**State machine after process exit during active capture:**

1. `handleExit` → `captureWasActive = true` → `enterCaptureRecovery("core.processExit")` sets `supervisor.state = "capture-connection-degraded"`, `captureRecoveryRequired = true`
2. `handleExit` then immediately overwrites at line 518: `this.supervisor.state = ... "exited"` — this overwrites the degraded state set by `enterCaptureRecovery`
3. After the child exits, state is `"exited"` and `captureRecoveryRequired = true`

**retryConnection() with state `"exited"`:**

- `this.supervisor.state === "capture-connection-degraded"` → **false** — the degraded probe branch is not entered
- Takes the ordinary path: `ensureHandshake()` → `this.call("core.status")`
- `handleStdout` → line 485: `this.updateCaptureState("core.status", response)`
- `updateCaptureState` has no case for `"core.status"` — `captureRecoveryRequired` is untouched

I audited all four locations where `captureRecoveryRequired` can be cleared: `updateCaptureState("capture.stop", ...)`, `updateCaptureState("capture.status", ...)` when in `capture-connection-degraded` state, and `completeCaptureRecovery()`. None of these are reached in the ordinary post-exit retry path.

The `exit-during-capture` test extension directly proves the post-retry snapshot:

```
{ state: "running", captureActive: false, captureRecoveryRequired: true }
```

No reachable implicit state transition clears the process-exit recovery marker before `completeCaptureRecovery()` or `capture.stop`. The finding is correctly withdrawn on both tracing and behavioral evidence.

**Status: CORRECTLY WITHDRAWN.**

---

### Finding 3 — Resolved

The Rust change (`main.rs:1772–1776`) removes the three-line `metadata_count == 0` early return. The gate is now simply `if metadata_count != 3 { return Err(...INVALID_RPC_ENVELOPE...) }`. All metadata fields are unconditionally required.

The test `bare_request_envelopes_are_rejected` correctly uses `handle_line` (the external entry point that calls `validate_request_envelope`), not `handle_request` (the internal dispatcher that bypasses it). Existing tests that call `handle_request` directly are not affected by the change — they construct `RpcRequest` structs directly for unit testing dispatch logic, which is appropriate.

All 20 proof client scripts import `createVersionedCoreRequest` from `scripts/core-rpc-envelope.mjs`. The helper correctly sets both `requestId` (Rust metadata field) and `id` (JSON-RPC correlation field) to the same UUID v4, and includes `protocolVersion` and `sentAt`. The `partial_or_incompatible_versioned_envelopes_are_rejected` Rust test continues to cover the 1-of-3 and wrong-version cases. 87 Rust tests passed.

**Status: RESOLVED.**

---

### Finding 4 — Resolved

The `candor-export:saveLocal` handler is fully removed from `export-ipc.ts:81–153`. The two imports used only by that handler (`MAX_LOCAL_EXPORT_INPUT_BYTES`, `validRecordingId`) are also removed — no dead imports remain.

The m0-audit change is stronger than originally requested: `"candor-export:saveLocal"` was moved from `requiredMainPatterns` to `bannedPatterns` (as a regex `/candor-export:saveLocal/`). A future accidental reintroduction would cause the m0 audit to fail at the banned-pattern check, not merely miss a presence check.

**Status: RESOLVED.**

---

### Finding 5 — Resolved

All four trust-boundary files and the versioned envelope helper are now in `requiredSourcePaths` (`source-security-rules.mjs:8–42`), each paired with a distinctive `includes()` token check:

| File | Token checked |
|---|---|
| `electron/core/operation-registry.ts` | `export const CORE_OPERATIONS` |
| `electron/security/validate-private-core-input.ts` | `export function validatePrivateCoreParams` |
| `electron/core/capture-recovery-store.ts` | `SAFE_METHOD.test` |
| `electron/ipc/jobs-ipc.ts` | `validateIpcSender` |
| `scripts/core-rpc-envelope.mjs` | `createVersionedCoreRequest` |

The source-security proof passed (per the verification matrix). Removing or emptying any of these files will now cause `v3:verify` to fail.

**Status: RESOLVED.**

---

### Finding 6 — Resolved

`operation-registry.ts:48` now declares `activeSession: "capture-session-or-null"` in the `capture.status` result schema. `runtime-schema.ts:34–40` implements the rule:

```typescript
case "capture-session-or-null":
  return value === null || (
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.recordingId === "string" &&
    value.recordingId.length > 0
  );
```

This precisely matches what the finding specified: null or an object with a nonempty string `recordingId`. The valid fixture adds `"activeSession": null`; the invalid fixture `capture-status-session-without-id.json` tests `activeSession: {}` → expected `CORE_RESULT_SCHEMA_INVALID`. Vitest 134 tests passed.

**Status: RESOLVED.**

---

## Regression check

No regressions identified. The changes are minimal and precisely scoped:
- `core-client.ts`: 3 lines changed (handleTimeout condition + captureActive assignment)
- `main.rs`: 3 lines removed (the early-return bypass) + 18 lines for the new test
- `export-ipc.ts`: 73 lines removed, 0 added
- `source-security-rules.mjs`: 5 required-path entries + 5 includes checks added
- `operation-registry.ts`: 1 line (schema field added)
- `runtime-schema.ts`: 8 lines (new FieldRule case)
- All 20 smoke scripts: import pattern updated, no logic change

---

## Final verdict: **APPROVE**

All six findings are fully disposed. The two changes-required findings (1 and 3) are correctly implemented with behavioral tests. Finding 2 is correctly withdrawn with a clear state-machine argument and a directly proving test. Findings 4–6 are resolved with the implementation and the security gate hardening that prevents regression. No new defects are introduced by the reconciliation.
