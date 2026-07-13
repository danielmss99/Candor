I have all the evidence needed. Here is the full review.

---

## Claude Phase 6 Shell Review

**Verdict: GO WITH REQUIRED FIXES**

One defect (F1) violates a stated product invariant and must be fixed before ship. No other finding is blocking.

---

### Assessed Property Coverage

| Invariant | Finding |
|---|---|
| Renderer authority over `recording.durable.delete` | **Pass** |
| Delete confirmation with Cancel as safe default | **Pass** |
| License independence for existing meeting access/delete | **Pass** |
| Stop always available during active capture | **FAIL — F1** |
| Durable-write / quarantine / deletion alerts are persistent, measured | **Pass** |
| Recording not marked saved until core returns durable ID | **Pass** |
| Validators reject malformed responses instead of coercing safe defaults | **Pass** |

---

### Required Fix

#### F1 — Stop button can be disabled during active capture by unrelated busy operations
**File:** `v3/renderer/src/app/AppRouteOutlet.tsx`, line 74
**Severity:** High — violates invariant 4

**Evidence:**
```typescript
const recordControlDisabled = Boolean(operations.busy) || (recordingBlocked && !activeCapture);
```

`operations.busy` is set to the label of ANY running operation — including "transcription", "notes", "load meetings", "audio", or "delete meeting". When `activeCapture` is `true` and any of these operations is in flight, `Boolean(operations.busy)` is `true`, making `recordControlDisabled = true` and disabling the record button. Because the record button doubles as the Stop button during active capture, this prevents stopping an active session.

The capture→Stop path uses exclusiveScope `"capture"` and label `"stop"` (`run("stop", ..., "capture")`), so `operations.busy` equals `"stop"` while Stop itself is in progress. Checking for `"stop"` is sufficient to block double-stop.

**User impact:** A user cannot stop an in-progress recording while any other job (transcript, AI recap, notes save, audio export) is running. A crash or OS sleep during this window could cause data loss.

**Concrete fix** — change line 74 to:
```typescript
const stopInProgress = operations.busy === "stop";
const recordControlDisabled = stopInProgress || (!activeCapture && (Boolean(operations.busy) || recordingBlocked));
```

This allows Stop at any time except when Stop itself is already executing, while still blocking Start when any other job is running or storage is blocking.

---

### Observed Defects (Non-Blocking)

None. No other defect-class issues were found in the reviewed surface.

---

### Observations (Optional Improvements)

#### O1 — Misleading fallback ID on capture start
**File:** `v3/renderer/src/features/capture/useCaptureActions.ts`, lines 84, 113, 141

All three `captureStart*` calls use `asString(..., "started")` as the fallback for `capture.recordingId`. If the core returns a start response without a `recordingId`, the capture session transitions with `"started"` as the ID. This is safe in practice (the `stop()` path independently validates the core-returned ID), but the string `"started"` leaking into `onNotice("Recording started")` and potentially into the session tracker is misleading. The stop path already has the correct guard; consider adding a similar empty-string throw on start to surface a core deviation early.

#### O2 — `protocol-methods.ts` and `preload-api.ts` are absent
The review request listed these two files, but they do not exist on disk. Their contents live in `electron/core/protocol.ts` and `electron/preload.cts` respectively, which I read instead. No evidence of missing contract surface — this is likely a stale reference in the review spec.

#### O3 — `sanitizeCoreResultForRenderer` strips PID only from `core.status`
**File:** `electron/core/renderer-boundary.ts`, line 12-17

Only `core.status` has path/PID sanitization applied. All other methods return the raw core result. The current `rendererCoreOperations` list doesn't include methods that would return filesystem paths, but as new read-type operations are added (e.g., `recording.durable.read`), this sanitizer won't automatically protect them. This is not a current issue but a pattern risk.

---

### Adversarial Question Verdicts

| Question | Verdict |
|---|---|
| Renderer path to `recording.durable.delete` or arbitrary core methods | None. `rendererCoreOperations` (protocol.ts:56–100) does not include `recording.durable.delete`. The IPC loop in `core-ipc.ts:11` is bounded to that allowlist. The only path is `candor-recording:delete`, which enforces the native dialog. |
| Confirmation bypass through another exposed operation | None. No other registered IPC handler calls `recording.durable.delete`. |
| License failure blocking existing meeting access/deletion | No. `shouldShowActivationPrompt` requires `existingRecordingCount === 0` (access-policy.ts:8–13). `canAccessExistingData` returns `true` unconditionally. If `licenseApiAvailable` is false, no gate is shown. |
| `busy` prop disabling Stop during active capture | **Yes — F1.** `Boolean(operations.busy)` is the first clause of `recordControlDisabled` with no carve-out for `activeCapture`. |
| Capture start failure for disk pressure leaving only a dismissible notification | No. Storage alerts are driven by `recordingStatus.storageHealth.level` from core, rendered as non-dismissible `<section>` elements (DesktopShell.tsx:71) without a close button. The dismissible transient error is additive. |
| Refresh failure marking failed save as successful (or vice versa) | No. `captureSession.saved(recordingId)` fires only after the core confirms a non-empty recording ID. If `loadRecording` subsequently throws, the catch clause emits `onError("Recording was saved locally, but its detail view could not be loaded.")` — an honest failure message, not a false success. |
| Persistent alerts overlapping content / exposing paths / claiming recovery without measured facts | No. Alerts render before `{children}` in the `.desktop-content` flow (DesktopShell.tsx:71–73). All four alert conditions are sourced directly from core-measured fields (`storageHealth.level`, `captureStatus.activeSession.integrityStatus`, `startupRecovery.pendingDeletionCount`, `quarantinedCount`, `startupRecovery.recoveredCount`). No filesystem paths appear in any alert message. |

---

### Smallest Required Fix Set

| # | File | Line | Change |
|---|---|---|---|
| 1 | `v3/renderer/src/app/AppRouteOutlet.tsx` | 74 | Replace `Boolean(operations.busy) \|\| (recordingBlocked && !activeCapture)` with `operations.busy === "stop" \|\| (!activeCapture && (Boolean(operations.busy) \|\| recordingBlocked))` |

**Re-review files after fix:**
- `v3/renderer/src/app/AppRouteOutlet.tsx` (changed line)
- `v3/renderer/src/features/capture/useCaptureActions.ts` (verify stop scope label is still `"stop"`)
