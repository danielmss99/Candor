All five criteria check out:

1. **Stop enabled during unrelated jobs / blocked storage:** `shouldDisableRecordControl` short-circuits on `busy === "stop"` first, then only blocks when `!activeCapture`. During active capture the second clause is always `false`. Confirmed by test cases `("transcription", true, false) → false` and `("export", true, true) → false`.

2. **Stop disabled while Stop is in progress:** First line `if (busy === "stop") return true` fires unconditionally regardless of `activeCapture`. Test `("stop", true, false) → true` confirms.

3. **New starts disabled during busy work or blocked storage:** When `activeCapture = false`, `!activeCapture` is `true`, and `Boolean(busy) || recordingBlocked` catches both cases. Tests `("transcription", false, false) → true` and `("", false, true) → true` confirm. Idle-and-clear `("", false, false) → false` also verified.

4. **Missing start IDs fail visibly:** Old code `asString(..., "started")` silently returned `"started"` on a missing ID. New `requireStartedRecordingId` calls `asString` with no fallback (defaults to `""`), then throws on `!recordingId`. Because `started = true` and `captureSession.started(recordingId)` are both *after* the throw, the session state is never mutated with an invented ID.

5. **Tests don't weaken duplicate-action protection:** The `run("record", ...)` guard in all three start functions is untouched. The new tests add coverage without modifying existing assertions.

**GO**
