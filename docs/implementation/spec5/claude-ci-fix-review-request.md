# Claude Review Request: Headless CI Shutdown Fix

Review this focused change adversarially. Do not edit the repository.

## Context

GitHub's headless Ubuntu runner has no desktop Secret Service keyring. The Rust core correctly keeps persisted background jobs fail-closed when the OS-backed encryption key is unavailable. However, the M0 stdio smoke failed on `core.shutdown` because `pause_all_for_shutdown` tried to rewrite the encrypted job store even when there were no active jobs.

## Proposed behavior

When the active-job set is empty, shutdown returns immediately without reading or writing job persistence. Real restartable job submission, retry, recovery, and pausing of active jobs continue to require encrypted persistence.

Once shutdown begins, the submission gate also rejects new jobs with `JOB_SHUTDOWN_IN_PROGRESS`, closing the race between the empty-queue check and a concurrent submit.

## Diff

```diff
@@ pub fn pause_all_for_shutdown
         {
             // Existing loop collects and mutates nonterminal jobs into `paused`.
         }
+        if paused.is_empty() {
+            return Ok(json!({
+                "pausedCount": 0,
+                "restartOnNextLaunch": false,
+                "rawPathExposed": false
+            }));
+        }
         self.persist()?;

@@ fn insert_job
+        if self.inner.shutdown_requested.load(Ordering::SeqCst) {
+            return Err(JobManagerError::new(
+                "JOB_SHUTDOWN_IN_PROGRESS",
+                "new local work cannot start while Candor is closing",
+            ));
+        }
```

One regression test creates a corrupt job-store file, initializes the manager in its unavailable persistence state, calls shutdown with no in-memory active jobs, and asserts shutdown succeeds while persistence remains unavailable. A second test verifies that a submission attempted after shutdown is rejected and the queue stays empty.

## Verification

- `cargo fmt -- --check`: passed
- `cargo test shutdown_without_active_jobs_does_not_require_job_store_access`: passed
- `cargo clippy --all-targets -- -D warnings`: passed
- `npm run m0:verify`: passed, including 149 Rust tests and the stdio smoke

## Review questions

1. Does this preserve fail-closed behavior for any operation that creates, changes, retries, or pauses real background work?
2. Can returning `restartOnNextLaunch: false` be misleading when persistence is unavailable, even though no in-memory active job was observed?
3. Is there a race in which a worker becomes active after the empty check?
4. Is a stronger regression test needed?

Report only actionable findings. For each finding include severity, file/line, evidence, and a concrete fix. Clearly distinguish defects from optional improvements.
