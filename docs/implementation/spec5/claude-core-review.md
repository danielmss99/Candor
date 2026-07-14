I have all the material I need. Here is the review.

---

## SPEC-5 Rust jobs and capture — focused review

---

### FINDING 1 — HIGH (Defect)

**`set_paused` unconditionally clears `cancel_requested`, causing lost user cancellations and `cancel_all` regression**

**Files / lines:** `job_manager.rs:1254–1262`, `job_manager.rs:1147–1219`, `job_manager.rs:1085–1092`

**Evidence:**

`set_paused` (called from both `wait_for_priority` and `spawn_descriptor`) unconditionally writes `cancel_requested = false` and `state = Paused` inside `mutate`:

```rust
// job_manager.rs:1254–1262
fn set_paused(&self, job_id: &str, stage: &str) {
    self.mutate(job_id, |entry| {
        entry.state = JobState::Paused;
        entry.stage = Some(stage.to_string());
        entry.cancel_requested = false;   // ← unconditional
        ...
    });
}
```

In `wait_for_priority` (lines 1147–1219), the jobs lock is released at the end of the `wait_reason` block, and `set_paused` re-acquires it via `mutate`. There is an unclosed race window between those two lock acquisitions:

1. Worker holds the jobs lock, reads `cancel_requested = false`, computes `wait_reason = "recording-priority"`, **releases lock**.
2. `cancel()` or `cancel_all()` acquires the same lock, writes `cancel_requested = true` (and `state = Cancelling` / `Cancelled`), releases lock, calls `notify_all()`.
3. Worker calls `set_paused` → `mutate` → acquires lock, writes `cancel_requested = false`, **state = Paused** (overriding `Cancelled` or `Cancelling`).
4. Condvar wait returns immediately (notified in step 2). Loop restarts.
5. Top of loop: `cancel_requested = false` → no early return. Recording still active → `set_paused` again → permanent loop. Cancel is **permanently lost**.

The same race is reachable from `spawn_descriptor:1090` (preemption path `set_paused("recording-priority")`) because `user_cancel_requested` is checked at line 1081 before `set_paused` is called at 1090, and `cancel()` can interleave between those two lines.

For `cancel_all` specifically, the regression is severe: `cancel_all` writes `state = Cancelled` (terminal), but the racing `set_paused` overwrites it to `Paused` (non-terminal) and clears the persisted `cancel_requested` flag. The store is then repersisted in the Paused state. On the next loop iteration the job re-enters `wait_for_priority` as a live non-cancelled job and will eventually execute.

**Failure scenario:** User cancels an exclusive-inference job while recording is active (job is in the preemption wait loop). After recording ends, the job runs to completion as if no cancellation occurred. For `cancel_all`, jobs marked Cancelled silently become Paused and resume on restart.

**Concrete fix:** Guard `set_paused` against overwriting a terminal or user-cancel state:

```rust
fn set_paused(&self, job_id: &str, stage: &str) {
    self.mutate(job_id, |entry| {
        if entry.state.terminal() || entry.cancel_requested {
            return;  // preserve cancel; don't undo cancel_all
        }
        entry.state = JobState::Paused;
        entry.stage = Some(stage.to_string());
        entry.updated_at = timestamp();
        entry.updated_at_ms = now_ms();
    });
}
```

This makes `set_paused` idempotent against concurrent `cancel()` / `cancel_all()`. The `cancel_requested` flag is already properly cleared only in `retry()` (line 895) and in the Ready path of `wait_for_priority` (line 1199), which are the semantically correct places.

---

### FINDING 2 — MEDIUM (Design defect)

**`DictionaryImport.archive_base64` stored verbatim in the encrypted descriptor; a single large import can prevent all subsequent job persistence**

**Files / lines:** `job_manager.rs:128–134`, `job_manager.rs:1571–1582`, `background_jobs.rs:294–317`, `validate-private-core-input.ts:10`

**Evidence:**

`DictionaryImport` serialises its full base64 payload into `PersistedJobEntry.descriptor`:

```rust
// job_manager.rs:128–134
DictionaryImport {
    source_file_name: String,
    archive_base64: String,   // up to MAX_DICTIONARY_PACKAGE_BASE64_CHARACTERS (~3.3 MB)
},
```

`write_job_document` checks the plaintext total before encrypting:

```rust
// job_manager.rs:1577–1582
if plaintext.len() as u64 > MAX_JOB_STORE_BYTES {   // 16 MB
    return Err(JOB_STORE_TOO_LARGE);
}
```

The IPC layer caps `archiveBase64` at 3,333,352 characters (~3.3 MB). Combined with other descriptors, metadata, and result blobs, a single large dictionary import can push total plaintext above 16 MB if other persisted jobs are present. When `write_job_document` returns `JOB_STORE_TOO_LARGE`, `persist()` fails, `remember_persistence_error` is called, and `require_persistence_ready` subsequently blocks **all further descriptor-based jobs** (transcription, recap, ask, export, all dictionary ops) until enough jobs are acknowledged and the store shrinks below the limit.

There is no per-descriptor size cap that would prevent this. A legitimate large dictionary package can silently disable job persistence for the entire session.

**Failure scenario:** User imports a large but valid signed `.candordict` (say 2.5 MB compressed) while 3–4 other jobs are active with results. The combined plaintext exceeds 16 MB. Every subsequent `submit_descriptor` returns `JOB_STORE_CORRUPT` / `unavailable`. Transcription after recording stop fails to queue; the stop response shows `autoProcessingQueued: false`.

**Concrete fix (two-part):**

1. In `insert_job`, before inserting a `DictionaryImport` descriptor, check whether the projected store plaintext would exceed the limit (rough estimate: current serialized size + base64 length). Reject early with a clear error rather than letting persistence fail globally.

2. Alternatively, strip `archive_base64` from the persisted descriptor and instead point to a temporary encrypted side-file (keyed to the job ID). Restart recovery reads from the side-file. This keeps the descriptor compact and avoids the interaction between result accumulation and archive size.

---

### No-findings areas

**Reviewed and clean — no actionable issues found:**

- **Durable capture finalization:** `set_recording_active(false)` is called before any queue attempt at `main.rs:900`. Queue failure writes `processingQueueError` into the stop response but never delays or fails the stop itself. The spec requirement is met.

- **Recording priority on failed start:** All three capture start paths (`startMic`, `startSystem`, `startMicAndSystem`) call `set_recording_active(false)` in the error branch before returning (`main.rs:850`, `870`, `891`). No priority leak on failed start.

- **Recovery path priority release:** `recording.durable.recover` releases priority on success (`main.rs:1590`). On app restart, `recording_active` is initialised to `false` (no persisted flag), so any stuck priority clears automatically.

- **Follow-up deduplication:** `submit_follow_up` checks for an existing job with matching `parent_job_id` before inserting (`job_manager.rs:1114–1125`). The `follow_up_queued` flag is persisted atomically with the parent entry; if the process crashes between `finish_completed` and the follow-up insert, `recover()` re-submits exactly once because `follow_up_queued = false` is the gate.

- **Atomic write protocol:** temp-file write + fsync + rename-over-backup + restore-on-failure (`job_manager.rs:1611–1657`). An interrupted write leaves either the temp file (ignored on next read) or the backup (restored). No path can leave a corrupt live file.

- **Priority ordering:** `wait_for_priority` blocks a lower-priority exclusive-inference job as long as any non-terminal, non-cancelled, non-shutdown-paused job with higher priority exists (`job_manager.rs:1170–1186`). Paused jobs are not excluded from blocking (only terminal, cancel_requested, and shutdown_pause_requested jobs are). Transcription (60) reliably runs before Recap/Ask (50).

- **Lower-priority starvation:** Priority is determined per job type, not dynamically adjusted. Lower-priority jobs can wait behind a sequence of high-priority transcriptions. This is intentional per the spec ("queue transcription after each recording stop") and bounded by the 256-job cap. No unbounded starvation is possible in the described usage model.

- **AI queue failure cannot delay durable stop:** Confirmed above under capture finalization. The `processing_queue_failure` value is informational only.

- **Sensitive data isolation in emitted events:** `emit` calls `entry.value(false)`, which excludes `result`. The `descriptor` struct (containing `question`, `archive_base64`, `recording_id`) is not serialised into the emitted value. `safe_failure_message` (`job_manager.rs:1710–1729`) discards the raw failure message and returns a canned string; no internal paths, IDs, or content reach the renderer through error objects.

- **Encryption correctness:** ChaCha20-Poly1305 with fresh CSPRNG nonce per write, domain-separated AAD (`candor-background-jobs-v1`), key derived from OS-backed store with a distinct label. Schema version and job-count bounds are verified after decryption. Corrupt or tampered ciphertext fails closed with `JOB_STORE_CORRUPT`.

- **Job ID validation:** `validate_job_id` enforces exactly 32 lowercase hex characters at all IPC entry points (`job_manager.rs:1686–1694`). The IPC layer additionally enforces this with the `JOB_ID = /^[a-f0-9]{32}$/` regex (`validate-private-core-input.ts:6`).

- **Export descriptor path safety:** `export.start` passes `raw_params` to `descriptor_for_export` (`main.rs:1771`), but the IPC validation at `validate-private-core-input.ts:161, 281–295` has already enforced `exactFields` (only `recordingId`, `format`, `channel`, `report`, `options`) and bounded the nested `report`/`options` JSON. No raw filesystem paths can appear in the export descriptor.
