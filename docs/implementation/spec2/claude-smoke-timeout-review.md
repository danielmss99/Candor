I now have enough material for a thorough adversarial review. Here is my finding.

---

## Adversarial CI & Reliability Review

### Scope of diff

Two files changed, identical in structure:

| File | Change |
|---|---|
| `m1-capture-crash-recovery-smoke.mjs:16` | `const smokeRpcTimeoutMs = 20_000;` added |
| `m1-capture-crash-recovery-smoke.mjs:88-89` | `5000` → `smokeRpcTimeoutMs`; error includes the budget |
| `m2-local-library-export-smoke.mjs:17` | Same constant added |
| `m2-local-library-export-smoke.mjs:67-68` | Same substitution |

No other files touched. Every other smoke script, Electron code, and protocol file is unmodified.

---

### Review questions answered

---

#### Q1 — Does 20 s mask a product hang or correctness defect?

**No.**

`capture.proofInterruptedSerializedWriter` is a smoke-only RPC method. The budget it races against is a test-harness timer, not a production timeout. The underlying work — 8 symmetric encrypted chunk writes flushed to a tmpdir — is performed by a debug binary on a Windows runner that had just completed 87 Rust tests. Release builds use hardware AES acceleration, a completely different IPC transport (Electron IPC, not JSONL stdio), and never expose this RPC at all.

The 20 s budget is a detection ceiling: if the core stalls permanently, the harness fails after 20 s. If it completes in 7 s under runner contention, it passes. Neither outcome hides a product defect because the product path is not exercised by this timer.

---

#### Q2 — Is 20 s bounded enough to fail deterministically on a stalled core?

**Yes, with analysis:**

**M1 call sequence** (sequential `await` chain): 5 RPCs × 20 s = 100 s max cumulative if every call stalled. The CI job `timeout-minutes: 60` is 3 600 s. Headroom: 36×.

**M2 call sequence**: ~12 RPCs × 20 s = 240 s max. Still within 60 min by 15×.

A genuine deadlock or blocked I/O fires at ≤ 20 s. The specific failing case — 8 encrypted writes on a loaded Windows runner — completed in well under 20 s once contention eased (6 consecutive local passes). The 4× increase (5 s → 20 s) is calibrated, not open-ended.

One nuance: the `waitForExit` helper in M1 still uses a default of `5000` ms (line 22, unchanged). SIGKILL delivery is near-instantaneous on all supported platforms, so this is not a practical risk, but the two timeout constants are now semantically inconsistent — one is named, the other is magic.

---

#### Q3 — Per request, per durable-write operation, or split by method?

**Per request is correct for this use case.**

Calls in both scripts are strictly sequential (each `await call(…)` completes before the next). Per-request and per-operation are equivalent here. Method-specific splitting (e.g., shorter timeout for `core.status`, longer for `export.create`) would add complexity with no benefit in a smoke harness that already validates deterministic output, not latency.

The existing architecture is sound: the request UUID keying in `pending` prevents any possibility of a stale timed-out response being mistaken for a response to a later call.

---

#### Q4 — Are the improved timeout diagnostics sufficient for a hosted failure?

**Sufficient, with one pre-existing gap worth noting:**

| Diagnostic element | Status |
|---|---|
| Method name in error | Present (unchanged) |
| Budget value in error | **New** — now included |
| Stderr relay (`child.stderr.on("data")`) | Present, will capture Rust-side panics/logs |
| Process cleanup on timeout | Correct: M1 `finally` calls `writer.crash()`; M2 `finally` calls `child.kill()` |
| Double-rejection guard | Correct: `pending.delete(id)` before reject; exit handler iterates only remaining entries |

**Pre-existing gap (out of scope, informational):** In M2's `finally` block (line 297), `child.kill()` is called but not awaited. The subsequent `rmSync(dataDir, …)` on line 298 therefore races with in-flight OS writes from the candor-core process. This predates the diff and is not caused by it; noting for completeness.

---

#### Q5 — Are additional focused tests required before commit?

This is the sharpest edge of the review.

**`m1-durable-recording-smoke.mjs` (line 61) and `m1-durable-crash-recovery-smoke.mjs` (line 88) still have hardcoded `5000` ms.**

Both scripts do encrypted durable chunk writes on the same code path. However:

- `m1-durable-recording-smoke.mjs` does **1 chunk write** per recording path (two separate recordings = 2 total individual write calls), not 8.
- `m1-durable-crash-recovery-smoke.mjs` does **1 chunk write** before the crash, then reads/status calls on recovery.
- Both run **before** `m1:capture-crash-smoke` in the `m1:verify` pipeline.

The specific evidence from run 29279169255 shows both sibling scripts completed within 5 s on the same loaded runner that failed the 8-chunk single-RPC call. This makes physical sense: `capture.proofInterruptedSerializedWriter` is a single RPC that drives 8 flush-to-disk + encrypt cycles internally before replying. A 1-chunk write RPC is 1/8 the I/O workload and is far less likely to breach 5 s even under contention.

**Assessment:** The scope limitation to the two demonstrated durable-write paths is technically defensible. No additional focused tests are required for correctness, though extending `smokeRpcTimeoutMs` to the two sibling scripts is low-effort insurance (see suggestions below).

---

### Findings

#### Required defects — none

The diff is correct. No change in semantics beyond the budget value and the error string.

---

#### Optional suggestions (no blocking status)

**S1 — Low — `m1-durable-recording-smoke.mjs:61`, `m1-durable-crash-recovery-smoke.mjs:88`**

Both sibling scripts retain `5000` hardcoded. They share the same vulnerability class (Windows OS-key encrypted chunk writes) at lower per-call workloads (1–2 chunks vs 8). They have not demonstrated the failure and empirically passed on the failing run. Raising them to a named constant and including it in the error message would make the harness suite internally consistent and would cost two lines each. Not required; worth doing at the same time.

**S2 — Low — `m1-capture-crash-recovery-smoke.mjs:22`**

`waitForExit(child, timeoutMs = 5000)` is now the only unnamed `5000` in this file. The constant doesn't need to be the same value as `smokeRpcTimeoutMs` — process exit after SIGKILL is effectively instantaneous — but the inconsistency is a mild readability issue. Either name it (e.g., `const smokeProcessExitMs = 5_000`) or leave it as-is.

**S3 — Informational — `m2-local-library-export-smoke.mjs:297`**

`child.kill()` is not awaited before `rmSync`. Pre-existing; out of scope for this diff but worth a follow-up ticket.

---

### Summary table

| # | Severity | File:Line | Finding | Required? |
|---|---|---|---|---|
| S1 | Low | `m1-durable-recording-smoke.mjs:61`, `m1-durable-crash-recovery-smoke.mjs:88` | Sibling scripts still have unnamed 5 s timers; same risk class, lower workload, haven't failed | No |
| S2 | Low | `m1-capture-crash-recovery-smoke.mjs:22` | `waitForExit` default is now the only unnamed timeout in the file | No |
| S3 | Info | `m2-local-library-export-smoke.mjs:297` | Pre-existing: `child.kill()` not awaited before `rmSync` | No (pre-existing) |

---

## Decision

**`approve`**

The diff is a minimal, correct, and appropriately scoped fix to two test-harness budget constants. The constant name is clear, the error message now includes the budget, process cleanup is correctly handled, no production code is touched, and the 20 s ceiling will catch a genuinely stalled core while tolerating realistic I/O latency on loaded Windows CI runners. The three findings above are pre-existing or stylistic; none block this change.
