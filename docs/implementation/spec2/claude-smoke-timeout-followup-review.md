Now I have all the evidence needed. Let me compile the findings.

---

## Review: CI Timeout Diff — Final

### Scope

Three files changed: `scripts/m1-capture-crash-recovery-smoke.mjs`, `scripts/m2-local-library-export-smoke.mjs`, `electron/test-core/controllable-core.test.ts`. Untracked `docs/implementation/spec2/` artifacts are outside the diff boundary.

---

### Finding 1 — Harness mode contract verified (INFORMATIONAL)

**File:** `electron/test-core/controllable-core.mjs:87`

```js
if (mode === "hang-before-response" && request.method !== "core.version") return;
```

The harness does respond to `core.version` normally in `hang-before-response` mode and silently drops every other method. This confirms the test design is sound: `ensureHandshake()` completes under the 2,000 ms handshake budget, then `core.status` hangs and hits the 200 ms target-request budget. The measured fault is exactly what the test claims.

---

### Finding 2 — Backward compatibility for `clientFor` callers is intact (INFORMATIONAL)

**File:** `controllable-core.test.ts:32`

```ts
function clientFor(mode: string, timeoutMs = 2_000, handshakeTimeoutMs = timeoutMs): CoreClient {
```

The default `handshakeTimeoutMs = timeoutMs` is evaluated at call time in TypeScript, so every existing two-argument call preserves its prior uniform timeout for both `core.version` and all other methods. The `startup-timeout` branch in the `it.each` (line 55) gives 200 ms to both paths, which is correct — the harness in that mode never writes to stdout, so the handshake legitimately times out.

---

### Finding 3 — `timeoutMsForTesting` signature contract (INFORMATIONAL)

**File:** `core-client.ts:63, 301`

```ts
timeoutMsForTesting?: (method: string, configuredTimeoutMs: number) => number;
// …
const timeoutMs = this.options.timeoutMsForTesting?.(operation.method, configuredTimeout) ?? configuredTimeout;
```

The new lambda `(method) => method === "core.version" ? handshakeTimeoutMs : timeoutMs` ignores `configuredTimeoutMs`, matching the prior `() => timeoutMs` behavior and consistent with the pre-existing direct `CoreClient` instantiations in `hang-during-capture` and `hang-during-capture-start` tests (lines 95, 136). TypeScript accepts this because callbacks may ignore trailing parameters. Zero production paths are touched — `timeoutMsForTesting` is only non-null in tests.

---

### Finding 4 — Hang detection surface in smoke scripts (INFORMATIONAL)

**Files:** `m1` line 89, `m2` line 68

The per-call budget rose from 5,000 ms to 20,000 ms. In both scripts, every request that hangs permanently will now wait 20 s before failing. The prior review approved this budget for the demonstrated eight-chunk durable write path. Confirmed: `waitForExit` (M1 line 22, fixed at 5,000 ms) is a separate concern for process-level exit, not RPC response, and is unaffected.

**One pre-existing limitation — not introduced by this diff:** M2 has no child `exit` event handler to eagerly reject pending entries when `candor-core` crashes mid-test. With 20 s budgets, a spontaneous crash would cause M2 to stall for up to 20 s instead of 5 s before failing. This was already true at 5 s. The diff does not worsen the correctness; it only extends the stall window on an already-accepted failure path. Not a defect to fix here.

---

### Required Defects

None.

---

### Optional Suggestions

| # | File | Line | Suggestion |
|---|------|------|-----------|
| S1 | `m2-local-library-export-smoke.mjs` | 30 | Add a `child.on("exit", …)` handler that rejects all pending entries, matching M1's pattern. Eliminates the 20 s stall on unexpected core exit. Pre-existing gap; low urgency. |
| S2 | `controllable-core.test.ts` | 55 | The `it.each` condition `mode.includes("timeout") \|\| mode.includes("hang")` is implicit naming convention. Consider an explicit set of modes that get short timeouts. Pre-existing; no urgency while the mode list is small. |

---

### Verdict

**approve**

The root cause (200 ms budget applied to `core.version` in `hang-before-response` mode) is correctly identified and cleanly fixed. The separate `handshakeTimeoutMs` parameter is backward-compatible by default, the harness behavior confirms the test measures precisely the intended fault, and no production code or timeouts are touched.
