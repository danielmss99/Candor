I now have sufficient data to synthesize the review. Here is the full pass.

---

## SPEC-4 Final Review — `codex/whisper-llm-release`

### Architecture summary (confirmed from code)

- Rust core validates all inputs at `decode_params::<T>()` with `deny_unknown_fields`; Electron validates at `validateRendererCoreParams` / `validatePrivateCoreParams` via the operation registry for `candor-core:*` channels.
- Private job channels (`candor-jobs:*`, `candor-ai:*`, `candor-transcript:start/benchmark`) are dispatched through `jobs-ipc.ts`'s `register()` helper, which does **not** use the operation registry.
- Grounded output is fully strict-JSON-parsed with `deny_unknown_fields`, source-ID-validated, numerically validated, and sensitive-term validated before any value reaches the renderer.
- Quality policy is serialized under a Mutex, written temp→rename, with backup recovery. Terminology store uses ChaCha20-Poly1305 with OS-key-derived key.
- Benchmark evidence requires matching the compiled-in `trusted_model_sha256` anchor; a changed model hash invalidates old evidence.

---

### P1 Defects

#### 1. Private job IPC channels bypass Electron-layer param validation
**File:** `electron/ipc/jobs-ipc.ts:20–29`

```ts
const register = (channel: string, method: string) => {
  ipcMain.handle(channel, async (event, params?: JsonValue) => {
    validateIpcSender(event, dependencies.getMainWindow);
    return callCore(dependencies, method, params ?? null);  // ← no validator
  });
};
```

All nine async channels (`candor-ai:ask`, `candor-ai:recap`, `candor-transcript:startQualityBenchmark`, `candor-transcript:start`, `candor-export:start`, `candor-models:verify`, `candor-jobs:get/cancel/acknowledge`) pass renderer-supplied params directly to the core without calling `validatePrivateCoreParams`. The Rust core does validate all inputs, so exploitability is low—but `validatePrivateCoreParams` was extended in this diff to handle exactly these methods (`ai.ask.start`, `ai.recap.start`, `transcription.quality.benchmark.start`, etc.), making it dead code on the actual call path. The intended defense-in-depth architecture is not enforced.

**Fix:** In `register()`, call `getCoreOperation(method).paramsSchema.parse(params ?? null)` (which invokes `validatePrivateCoreParams`) before `callCore()`, matching how `core-ipc.ts` handles renderer operations.

---

#### 2. Prompt temp file has no access control on Windows
**File:** `crates/candor-core/src/local_instruct_model.rs:787–793`

```rust
let mut options = OpenOptions::new();
options.write(true).create_new(true);
#[cfg(unix)]
options.mode(0o600);           // ← Windows has no equivalent
```

On Windows, `write_prompt_file()` creates a file in `%TEMP%` with default system ACLs. On a multi-user or domain-joined Windows machine, other local accounts may be able to read the file before it is deleted. Meeting transcript content—possibly pharmaceutical—passes through this file.

**Fix:** On Windows, create the temp file inside a process-private sub-directory (e.g., `TEMP\candor-<pid>\`) created with restricted ACLs via `CreateDirectoryExW` + `SetSecurityInfo`, or use the `SetNamedSecurityInfo` API to restrict the file to the current user SID. At minimum, document the limitation in the security review and ensure it is addressed before the Complete installer ships.

---

### P2 Issues

#### 3. `claim_value()` always attributes multi-source claims to source[0]
**File:** `crates/candor-core/src/grounded_output.rs:490`

```rust
let source = cited_sources(&claim.source_ids, sources)?[0];
```

For actions or decisions that cite two or more segment IDs, the rendered `speaker`, `channel`, and `startMs` in the JSON output always reflect the first cited source. A claim like "Priya and Alex agreed on Friday" citing `["s0","s1"]` would show `speaker: "Priya"` and `startMs: 10`, omitting `"Alex"`'s attribution entirely. Downstream renderer attribution is misleading.

#### 4. Lexical grounding threshold allows 50% divergence for 4–7 token claims
**File:** `crates/candor-core/src/grounded_output.rs:382–388`

```rust
let required = match claim_tokens.len() {
    0..=3 => claim_tokens.len(),
    4..=7 => 2,            // ← 2/4 = 50% required
    _ => 3,
};
```

A four-meaningful-token claim needs only two tokens to overlap with the cited evidence, after the stopword filter is applied. Numeric and drug-name validators add extra protection for critical values, but general factual claims with 4–7 meaningful tokens can be half-divergent from the cited evidence and still pass. Consider raising the requirement to `(claim_tokens.len() + 1) / 2` (ceiling 50%) or at least `3` for the 4–7 bucket.

#### 5. `render_merged_recap` appends all collected source IDs to a single summary line
**File:** `crates/candor-core/src/local_instruct_model.rs:1568–1574`

```rust
for source_id in source_ids {
    markdown.push_str(" [");
    markdown.push_str(source_id);
    markdown.push(']');
}
```

With `MAX_MERGED_SOURCE_IDS = 320`, the summary paragraph can receive up to 320 bracketed citation markers. This is not useful in UI and makes the compatibility Markdown field unreadable for long meetings. The summary section should cite only the `source_ids` from the summary claims themselves (already stored in `batch.grounded.source_ids` for summary-batch indexes), not all merged IDs from all sections.

#### 6. Windows temp file path separator may appear in path-exposure check
**File:** `crates/candor-core/src/local_instruct_model.rs:1085–1089`

The `sensitive_path_kind` check uses `text.contains(path.as_ref())` where `path.to_string_lossy()` on Windows produces backslash-separated paths. If the model output contains a forward-slash variant of the path, the check would not catch it. This is low risk on Windows since llama.cpp output is unlikely to contain the path, but the check is not bidirectional.

---

### Missing or Weak Tests

**T1.** No test that the `register()` helper in `jobs-ipc.ts` rejects oversized or malformed params for `ai.ask.start` before they reach the core. Because `validatePrivateCoreParams` is not called on this path, the Electron-boundary contract for `question` length is not tested end-to-end.

**T2.** No test for prompt temp file ACLs on Windows. The existing test matrix has no coverage of whether another Windows user can read the file before deletion.

**T3.** No test for the `lexically_grounded` 4-token boundary case where 2 tokens overlap but the claim is factually incorrect. The mutation tests cover dosage and drug-name rejection, but not the minimum-overlap pass threshold for general claims.

**T4.** `render_merged_recap`'s multi-source citation flood is not tested. A test with two batches of segments would expose the 320-citation summary problem.

**T5.** No explicit test that a stale `BenchmarkEvidence` with a correct `balanced_passed: true` but wrong `balanced_model_sha256` is rejected by `evaluate_tier`. The test at line 955–968 of `transcription_quality.rs` covers this, which is good—but this is the most critical invariant in the quality policy and deserves an explicit named test rather than being covered only through the `trusted_model_revision_change_invalidates_old_benchmark_evidence` test which uses `"0".repeat(64)` as the stale hash.

**T6.** No test that `claim_value`'s `source` index is semantically correct for multi-source claims (i.e., `[0]` attribution). If the behavior is intentional, document it; if not, add a test that verifies the chosen attribution.

---

### Claims that exceed evidence

None found. Specifically:

- `citationsVerifiedFromOutput: true` is set after `validate_and_render` succeeds, which is correct—every source ID has already passed citation validation.
- `estimatedRealTimeFactor: null` in `status_for` is correctly suppressed; only the rounded `estimatedMinutesPerHour` is exposed.
- `rawHashExposed: false`, `rawModelNamesExposed: false` are set consistently and verified by the result schema in `operation-registry.ts`.
- The `model-lock.json` correctly sets `expectedSha256: null` for the Qwen3-4B-Instruct-2507 Q4_K_M primary candidate and populates the fallback artifact's hash only for the known official GGUF artifact—neither is packaged.
- `release:complete` exits nonzero as required; the gate is not a placeholder.

---

### PR readiness recommendation

**The source diff is ready for a pull request**, subject to resolving the two P1 defects above before merging:

1. Wire `validatePrivateCoreParams` into the `register()` helper in `jobs-ipc.ts` — one-line fix per call site or factored into `register()`.
2. Restrict Windows prompt temp file to the current user — the Unix path is correct; Windows needs an equivalent.

The `Complete` release correctly remains blocked: the verifier explicitly reports missing profile selection, absent model assets, no benchmark evidence, no tested runtime, and a null language-model artifact digest. No command in this diff can produce or claim a `Complete` artifact. The `Candor Source Interface` build identity and separate app ID are correctly established. These are the right guardrails for the current state of the branch.
