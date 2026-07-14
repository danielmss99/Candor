---

## Finding Summary

**No remaining P0 or P1 defects.** All seven prior findings are correctly resolved. Evidence:

### Prior findings — confirmed closed

**#1 — IPC bypasses private validation:** `validate-private-core-input.ts:73–86` now delegates `ai.askHeuristic`, `ai.recapHeuristic`, `ai.askInstruct`, `ai.recapInstruct`, `transcription.runLocal`, and `export.create` directly to `validateRendererCoreParams`. New `transcription.quality.benchmark.start` has its own validator at line 94.

**#2 — Windows prompt-file DACL:** `local_instruct_model.rs:835–896`. `ConvertStringSecurityDescriptorToSecurityDescriptorW` converts `D:P(A;;FA;;;OW)(A;;FA;;;SY)` and passes the descriptor to `CreateFileW`. `LocalFree` is called unconditionally after `CreateFileW`, before the `INVALID_HANDLE_VALUE` check — correct sequencing, no post-create window, no descriptor leak.

**#3 — Multi-speaker claims:** `grounded_output.rs:500–518`. All cited sources are iterated; `speakers.len() > 1` → `"Multiple speakers"`, `channels.len() > 1` → `"mixed"`. `start_ms` is the minimum across all cited sources (line 520–524).

**#4 — 4–7-token claims:** `grounded_output.rs:387–392`.
```rust
let required = match claim_tokens.len() {
    0..=3 => claim_tokens.len(),
    4..=7 => 3,
    _ => 3,
};
```
Exact number (`validate_exact_numbers`) and specialist-term (`validate_exact_sensitive_terms`) checks run first at lines 155–163, so dosage/drug errors are not silenced.

**#5 — Recap summary cites only summary sources:** `local_instruct_model.rs:1619` passes `&summary_source_ids` to `render_merged_recap`. Individual decision/action/risk/question items inline their own `sourceIds` from the claim JSON (lines 1676–1682). The Markdown summary section does not accumulate all decision/action sources.

**#6 — Raw path detection normalizes slash direction and case:** `local_instruct_model.rs:1148` applies `replace('\\', "/").to_lowercase()` to the LLM output. Line 1164 applies the same transform to each config path before `contains(...)`.

**#7 — Benchmark blocked during active capture:** `main.rs:1356–1361`. The `transcription.quality.benchmark.start` handler checks `state.capture_manager.is_active()` synchronously before submitting the job. `JobManager::has_active_type("local-ai-benchmark")` (lines 1363–1373) also prevents duplicate concurrent benchmarks.

---

### New surface area — no defects found

| Area | Validation chain |
|---|---|
| `terminology.*` renderer methods | `validate-core-input.ts` strict per-method validators; all Rust structs carry `deny_unknown_fields` |
| `terminology.import` private route | `validate-private-core-input.ts:105–130` validates name trim, format enum, byte count independently of char count |
| `transcription.quality.update` | Renderer validator enforces `tier` as required (undefined fails the enum check), `languagePreference` optional but enum-guarded |
| `transcription.quality.benchmark.start` | Private validator at `validate-private-core-input.ts:94–101`; `tier` restricted to `{balanced, maximum}` (no `fast`) |
| `local-ai-benchmark` job type | Added to `CORE_JOB_TYPES` in `protocol.ts:134` and `safe_failure_message` in `job_manager.rs:490` |

---

### PR-readiness verdict

**Ready to merge on the code.** No P0 or P1 defects remain in the diff. The remaining release blockers — real model assets, license approval, hardware benchmarks on target machines, code signing, and clean-machine smoke evidence — are correctly flagged as external blockers in the checklist and cannot be satisfied by code changes.
