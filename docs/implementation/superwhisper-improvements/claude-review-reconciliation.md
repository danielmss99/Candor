# Claude Implementation Review Reconciliation

Date: 2026-07-21

Review source: `claude-implementation-review.md`

Invocation status: accepted. The helper exited successfully, wrote 12,711
bytes, and the artifact begins with `I've now read all scoped files`, not
`CLAUDE INVOCATION NOT PERFORMED`.

## Severity Gate

- Critical: none.
- High: none.
- Medium: one, accepted and fixed.
- Low: two, one accepted and fixed and one rejected as an intentional boundary
  decision.

## Confirmed Finding Dispositions

### Medium: missing Content-Length passed the early model size check

Disposition: accepted and fixed.

`electron/models/model-acquisition-service.ts` no longer substitutes the
catalog byte count when the response omits `Content-Length`. A missing header
now destroys the response, aborts the core-owned staging import, and fails
before `models.importChunk`. A present header must parse as a safe integer and
match the catalog byte count exactly. End-of-stream byte count and SHA-256
verification remain required.

Focused proof:

- `npx vitest run electron/models/model-acquisition-service.test.ts electron/models/model-catalog.test.ts`
- Result: 2 files, 7 tests passed.
- The new absent-header test asserts `models.importAbort` runs and neither an
  import chunk nor finish job is sent.

### Low: Parakeet is admitted by the known-ID Electron validator before the core gate

Disposition: rejected as a defect; retained intentionally and documented.

The renderer boundary accepts only the fixed packaged model ID. It accepts no
URL, path, hash, runtime, command, byte count, or arbitrary ID. Rust owns
meeting-profile validity and returns the stable `PARAKEET_RELEASE_GATED` code.
Keeping that explicit core-owned release decision was an accepted plan
requirement and prevents divergent policy between renderer callers, CLI/MCP
companions, and future core-owned profile operations. The request has no side
effect and cannot install, select, or execute Parakeet. Repeated rejected calls
do not create materially different authority from repeated invalid calls for
any other bounded core method.

The catalog still has no Parakeet URL, hash, byte count, runtime, or model
artifact. Its download action and default eligibility remain false.

### Low: missing cleanupFallbackApplied silently defaulted to true

Disposition: accepted and fixed.

Both paths now require an actual boolean:

- `local_instruct_model.rs` returns
  `LOCAL_LLM_TRANSCRIPT_LINEAGE_MISSING` when the transcript handoff omits the
  cleanup fallback field.
- `background_jobs.rs` returns `LOCAL_AI_RECAP_LINEAGE_INVALID` before writing a
  recap receipt when the result omits the field.

Focused proof:

- `local_instruct_response_requires_explicit_cleanup_lineage`: passed.
- `recap_receipt_requires_explicit_cleanup_fallback_lineage`: passed.

## Questions And Defence-In-Depth Notes

### Ask receipts

Disposition: no change. `ask` is an ephemeral query result, not a stored
transcript or structured meeting recap revision. It retains bounded job
provenance and the core privacy processing fact. The durable processing receipt
is required for cleanup revisions and stored recap lineage, not every temporary
question.

### Reused cleanup receipt

Disposition: no change. Reuse creates no new text, model execution, revision,
or evidence transformation. The existing cleanup receipt remains the canonical
lineage for the reused immutable cleaned revision. The reuse result is explicit
and cancellation cannot publish a partial revision because no mutation occurs.

### Migrated backup flag

Disposition: deferred as a narrow recovery hardening follow-up. The reviewed
branch reads and validates a backup and migration is idempotent, but does not
persist a schema-1 migration when the primary file exists and is corrupt.
Changing corrupt-primary promotion safely requires preserving the last valid
backup across a failed replacement. It is unrelated to normal schema migration,
which is atomic and covered, and it does not alter the returned profile or
Whisper selection. This will not be mixed into the local-AI handoff without a
dedicated recovery design and fault-injection proof.

### Text audit and computed network module names

Disposition: documented limitation, no change. The source audit combines exact
literal import checks, a single exact-file network exception, forbidden raw
network modules and browser transports, runtime checks, and 37 mutations. A
text audit is not a parser. A computed import could evade that one regex, but it
would require a source-code change and is not present in the reviewed tree.

### Cancellation after cleanup validation but before commit

Disposition: no code change from this review. Cleanup publication remains a
single manifest replacement under the mutation lock. If cancellation arrives
after the final cancellation check and the atomic commit has started, the valid
revision and receipt commit together rather than leaving a half state. This is
the safer integrity outcome; the job state and receipt allow diagnosis.

## Review-Triggered Reruns

Completed:

- Model catalog/acquisition Vitest: 7 passed.
- Local instruct missing-lineage Rust test: passed.
- Recap receipt missing-lineage Rust test: passed.
- `cargo fmt`: passed.

Completed after final review:

- Source-security audit: 214 checks and 37 mutations passed.
- Renderer typecheck and Electron main build: passed.
- Full Electron matrix: 12 of 12 passed.
- Affected Rust suites: passed.
- Final `npm run v3:verify`: passed with 31 library, 353 core, and 482 Vitest
  tests plus all staged M0 through M5 proof commands.
- `claude-final-review.md`: real invocation, no confirmed finding and no open
  Critical, High, or Medium issue.
