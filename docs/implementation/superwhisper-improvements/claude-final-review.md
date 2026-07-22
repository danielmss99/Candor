The grep confirms `local_ai_service.rs` lines 314 and 427 both emit `cleanupFallbackApplied`, and `recording_store.rs` line 2620 sets it in `transcript_for_local_ai` results. I have enough to complete the adversarial analysis.

---

## Final Adversarial Review

### Confirmed Findings

**None.** No Critical, High, or Medium findings remain or are introduced. The two Low findings from the prior review are resolved.

---

### Prior Finding Resolutions

**Medium — Missing `Content-Length` passed the early size check**
**Status: Resolved.**

`model-acquisition-service.ts:183–191` now checks for `rawContentLength === undefined` before any streaming begins, calls `response.destroy()`, and throws before `models.importChunk` is ever called. The check then requires `Number.isSafeInteger(contentLength) && contentLength === entry.bytes`; neither a float, `NaN`, zero, nor a value that diverges from the catalog byte count will pass. The streaming upper bound at line 199, exact final byte count at line 208, and SHA-256 at line 208 all remain intact.

The test at `model-acquisition-service.test.ts:88–101` verifies the three required postconditions: the download rejects with a "content length" error; `models.importAbort` is called; `models.importChunk` and `models.importFinish.start` are not called. The catch block correctly reaches abort because `active.importId` is set at line 178 before `responseFor` is called.

No new paths are opened:
- **Partial import**: impossible — the check fires before the async iterator.
- **Response lifecycle**: `response.destroy()` at line 184/190 and `active.request?.destroy()` in the `finally` block at line 230 are on different objects sharing the same socket; double-destroy is idempotent.
- **Cancellation**: the `active.cancelled` check at line 194 is still evaluated in the streaming loop; cancellation before streaming is caught by the same `responseFor` guard at line 81–84.
- **DoS / slow-send**: the `NETWORK_IDLE_TIMEOUT_MS = 30_000` idle timeout at line 66 still fires against the request handle and calls `requestHandle.destroy()`, which ends the response stream and propagates to the catch block.

---

**Low — `cleanupFallbackApplied` silently defaulted to true**
**Status: Resolved in both paths.**

`local_instruct_model.rs:2379–2389` (`required_cleanup_fallback`) fails closed: if `cleanupFallbackApplied` is absent or non-boolean in the transcript handoff, it returns `LOCAL_LLM_TRANSCRIPT_LINEAGE_MISSING` — not retryable, no default. This is called unconditionally at line 2312 inside `local_instruct_response` before the response object is constructed, so a missing field prevents the response from being returned to `background_jobs.rs` at all.

`background_jobs.rs:1075–1086` (`required_cleanup_fallback`) fails closed: if `cleanupFallbackApplied` is absent or non-boolean in the assembled result, it returns `LOCAL_AI_RECAP_LINEAGE_INVALID` — not retryable, not written as a receipt. The `?` at line 497 propagates before `record_recap_receipt` at line 502 is reached.

**Boundary completeness (greppable cross-check):** `recording_store.rs:2620` sets `cleanupFallbackApplied` in `transcript_for_local_ai` output; `local_ai_service.rs:314` and `local_ai_service.rs:427` set it in heuristic recap and heuristic ask results. Every consumer path that reaches the receipt boundary delivers the field; the helper in `background_jobs.rs` is therefore never reached with a missing field from a path that should succeed. Neither helper has a default escape: `Value::as_bool` returns `None` for `true` the JSON number, a JSON string, or `Value::Null`, all of which become `LOCAL_AI_RECAP_LINEAGE_INVALID`.

---

**Low — Parakeet admitted by Electron ID validator, rejected by Rust**
**Status: Retained intentionally. Not unsafe.**

The Electron renderer boundary accepts only one fixed string (`model-acquisition-service.ts:114–118`). The call carries no URL, no hash, no byte count, no path, no runtime, no arbitrary ID, and no byte is written to disk or to the staging slot. `PARAKEET_RELEASE_GATED` is a stable, stable-typed Rust error; repeated invalid calls produce no state change and no materially different authority from any other bounded rejected core method. The core owns release-gate policy across all callers.

---

### Answers to Required Questions

**Q1 — Does the content-length fix fully address the Medium finding without opening a new partial-import, response lifecycle, cancellation, or denial-of-service path?**

Yes. The fix is complete. No new path is opened. The abort, streaming bound, exact byte count, SHA-256, redirect allowlist, and catalog boundary are all intact.

**Q2 — Do the two required boolean helpers fail closed at the right boundaries and preserve accurate receipt and renderer lineage?**

Yes. Both helpers use `Value::as_bool` with no default. `local_instruct_model.rs:2379` blocks before the response object is constructed. `background_jobs.rs:1075` blocks before the receipt is written. Every supplying path (`recording_store.rs`, `local_ai_service.rs`) delivers the field, so no correctly operating path reaches the helpers with a missing field. The `false` case (no fallback applied) is tested explicitly in `local_instruct_model.rs:2839`.

**Q3 — Is any Critical, High, or Medium issue introduced by these fixes?**

No.

**Q4 — Is either rejected/deferred disposition actually unsafe within the locked product contract?**

No. The Parakeet Electron admission has no side effect and is bounded by the core release gate. The Ask receipt exemption is correct for an ephemeral query (a bounded processing fact is still written at `background_jobs.rs:631`). Reuse of a valid cleaned revision at `background_jobs.rs:237–254` causes no mutation and no partial state. The migrated-backup deferral is correctly scoped to a fault-injected recovery path that is not on the normal schema migration route.

---

### State of Prior Findings

| Finding | Severity | Status |
|---|---|---|
| Missing `Content-Length` passed early size check | Medium | **Resolved** |
| `cleanupFallbackApplied` silently defaulted to true (both paths) | Low | **Resolved** |
| Parakeet admitted by Electron ID validator | Low | Retained intentionally; not unsafe |

**No Critical, High, or Medium finding remains open or is introduced by these fixes.**
