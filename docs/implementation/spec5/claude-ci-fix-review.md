CLAUDE INVOCATION NOT PERFORMED
Claude CLI failed with exit code 1.

Run this prompt through Claude manually, then save the response to:
.\docs\implementation\spec5\claude-ci-fix-review.md

Suggested repair commands when Claude Code auth is stale:
  claude auth logout
  claude auth login

For non-interactive automation, use one of:
  claude setup-token
  set ANTHROPIC_API_KEY in the process environment, then rerun this helper with -AllowApiKeyBareMode

--- AUTH STATUS ---
{
  "loggedIn": true,
  "authMethod": "claude.ai",
  "apiProvider": "firstParty",
  "email": "<redacted>",
  "orgId": "<redacted>",
  "orgName": "<redacted>",
  "subscriptionType": "pro"
}

--- CLI OUTPUT ---
{"type":"result","subtype":"success","is_error":true,"api_error_status":429,"duration_ms":1206,"duration_api_ms":0,"num_turns":1,"result":"You've hit your session limit · resets 12pm (America/New_York)","stop_reason":"stop_sequence","session_id":"<redacted>","total_cost_usd":0,"usage":{"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0},"inference_geo":"","iterations":[],"speed":"standard"},"modelUsage":{},"permission_denials":[],"terminal_reason":"completed","fast_mode_state":"off","uuid":"<redacted>"}

--- PROMPT ---
# Claude Review Request: Headless CI Shutdown Fix

Review this focused change adversarially. Do not edit the repository.

## Context

GitHub's headless Ubuntu runner has no desktop Secret Service keyring. The Rust core correctly keeps persisted background jobs fail-closed when the OS-backed encryption key is unavailable. However, the M0 stdio smoke failed on `core.shutdown` because `pause_all_for_shutdown` tried to rewrite the encrypted job store even when there were no active jobs.

## Proposed behavior

When the active-job set is empty, shutdown returns immediately without reading or writing job persistence. Real restartable job submission, retry, recovery, and pausing of active jobs continue to require encrypted persistence.

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
```

A regression test creates a corrupt job-store file, initializes the manager in its unavailable persistence state, calls shutdown with no in-memory active jobs, and asserts shutdown succeeds while persistence remains unavailable.

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
