# Focused Claude re-review: SPEC-5 finding fixes

Review the uncommitted SPEC-5 fixes in `C:\Claude_Config\candor`. Do not edit files and do not run the full test suite. Read the two prior reviews first:

- `docs/implementation/spec5/claude-core-review.md`
- `docs/implementation/spec5/claude-boundary-review.md`

Then inspect only the relevant changed regions in:

- `crates/candor-core/src/job_manager.rs`
- `crates/candor-core/src/dictionary_package.rs`
- `crates/candor-core/src/terminology_dictionary.rs`
- `scripts/spec3-verify-ai-bundle.mjs`
- `v3/renderer/src/features/jobs/BackgroundActivity.tsx`
- `v3/renderer/src/features/jobs/BackgroundActivity.test.tsx`
- `v3/renderer/src/features/terminology/useTerminologyWorkspace.ts`

The fixes are intended to resolve all prior findings:

1. Cancellation and terminal job states cannot be overwritten by pause, start, queue, or shutdown transitions.
2. Job insertion projects the encrypted store size before mutation and returns `JOB_STORE_CAPACITY` without poisoning later persistence.
3. Dictionary ZIP entries are read through an actual decompressed-byte limit rather than trusting central-directory sizes.
4. Standard release verification rejects extra speech models that belong only to the Maximum profile.
5. Re-importing a signed package ID reports the installed and available versions, and the UI explicitly says when an update is available without replacing encrypted installed data.
6. Background job actions have job-specific accessible names.

Focused tests for each fix pass. Review for correctness, security regressions, and whether each original finding is fully resolved. Report only actionable findings with severity, exact file and line, evidence, and a concrete fix. If no blocker or material issue remains, say that plainly.
