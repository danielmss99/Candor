# Focused Claude review: SPEC-5 Rust jobs and capture

Review the uncommitted SPEC-5 diff in `C:\Claude_Config\candor`. Do not edit files and do not run the test suite. Limit the response to actionable correctness or security findings, plus a short no-findings statement for reviewed areas. Finish within this invocation.

Read only:

- `docs/implementation/spec5/implementation-plan.md`
- `crates/candor-core/src/job_manager.rs`
- `crates/candor-core/src/background_jobs.rs`
- the changed job and capture sections in `crates/candor-core/src/main.rs`
- relevant `git diff` for those files

The implementation uses an encrypted atomic job snapshot, serializable descriptors, restart recovery, deterministic inference priority, cooperative recording preemption, cancellation/retry/acknowledgement, and transcription-to-recap chaining. A verified durable capture stop queues transcription without allowing queue failure to fail Stop.

Review only these risks:

1. races among cancellation, completion, pause, retry, acknowledgement, and shutdown;
2. duplicate or skipped follow-up recap jobs;
3. job persistence corruption, interrupted writes, and plaintext sensitive data;
4. recording priority release on failed start, unverified stop, verified stop, and recovery paths;
5. whether lower priority inference can run ahead of queued transcription or starve forever;
6. whether an AI queue failure can delay or invalidate durable capture finalization;
7. unsafe event or error exposure of questions, transcript content, results, keys, or paths.

For every finding provide severity, exact file and line range, evidence, failure scenario, and concrete fix. Distinguish defects from suggestions. Do not restate the architecture.
