# Claude Final Review Request

Date: 2026-07-21

## Role And Scope

Perform a focused final adversarial review of fixes made from
`claude-implementation-review.md`. Do not edit files. Read only the files below
and their directly referenced types/tests:

- `electron/models/model-acquisition-service.ts`
- `electron/models/model-acquisition-service.test.ts`
- `crates/candor-core/src/local_instruct_model.rs`
- `crates/candor-core/src/background_jobs.rs`
- `docs/implementation/superwhisper-improvements/claude-review-reconciliation.md`

Do not inspect credentials, `.env`, recordings, transcripts, vault data, keys,
user data, or unrelated files.

## Prior Review Result

The implementation review reported no Critical or High findings. It reported:

1. Medium: missing HTTP `Content-Length` was replaced with the expected catalog
   byte count, making the early check vacuous.
2. Low: missing `cleanupFallbackApplied` silently defaulted to true in two audit
   lineage paths.
3. Low: known release-gated Parakeet passes the fixed Electron ID validator and
   is rejected by Rust with `PARAKEET_RELEASE_GATED`.

## Fixes To Validate

### Model acquisition

The broker now:

- requires `response.headers["content-length"]` to be present
- destroys the response and throws when absent
- requires it to parse as a safe integer exactly equal to the packaged catalog
  byte count
- retains the streaming upper bound, exact final byte count, SHA-256 check,
  staging abort, redirect allowlist, and fixed catalog ID boundary

The new test removes the response header and proves:

- the download rejects with a content-length error
- `models.importAbort` is called
- `models.importChunk` is never called
- `models.importFinish.start` is never called

Focused result: 2 Vitest files, 7 tests passed.

### Cleanup and recap lineage

The local-LLM response now calls `required_cleanup_fallback(transcript)`, which
requires an actual boolean or returns
`LOCAL_LLM_TRANSCRIPT_LINEAGE_MISSING`.

The recap job now calls its own typed helper before writing the receipt. Missing
or non-boolean data returns `LOCAL_AI_RECAP_LINEAGE_INVALID` and is not
retryable. There is no default.

Focused Rust tests for both missing-field cases passed.

## Recorded Dispositions To Challenge

- Parakeet remains admitted only as one fixed known model ID at the Electron
  validator, then rejected by the core-owned profile policy with the stable
  release-gate code. The request accepts no URL, path, hash, runtime, command,
  or arbitrary model ID and has no state change. This was retained intentionally
  so the core owns profile validity across renderer and companion callers.
- Ask is receipt-exempt because it is an ephemeral query rather than a stored
  transcript or structured recap. It still has bounded job provenance and a
  privacy processing fact.
- Reusing an existing valid cleaned revision does not create a new processing
  receipt because no model run, text, revision, or evidence transformation is
  created.
- Persisting a migrated backup when the primary file is corrupt is deferred to
  a dedicated fault-injected recovery change. Normal schema migration remains
  atomic and Whisper-preserving.

## Required Questions

1. Does the content-length fix fully address the Medium finding without opening
   a new partial-import, response lifecycle, cancellation, or denial-of-service
   path?
2. Do the two required boolean helpers fail closed at the right boundaries and
   preserve accurate receipt and renderer lineage?
3. Is any Critical, High, or Medium issue introduced by these fixes?
4. Is either rejected/deferred disposition actually unsafe within the locked
   product contract? If yes, show the exact state-changing or data-loss path.

## Output

List only confirmed findings, in Critical, High, Medium, Low order, with exact
file and line, failure path, smallest fix, and focused test. Separate questions
or defence-in-depth suggestions. Explicitly state whether the prior Medium and
Low accepted findings are resolved and whether any Critical, High, or Medium
finding remains.
