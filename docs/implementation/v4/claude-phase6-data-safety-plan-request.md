# Claude Review Request: V4 Phase 6 Data Safety Design

You are reviewing a proposed implementation before persisted-data code changes.
Be adversarial. Do not edit files. Return findings with severity, file or design
area, evidence, smallest safe correction, and a final verdict of GO, GO WITH
REQUIRED FIXES, or STOP.

## Mission

Candor is an Electron/React desktop meeting recorder with a Rust core. Recording,
transcription, AI, notes, and exports remain local. Existing recordings must
remain openable, exportable, and deletable regardless of license or network
state. A migration failure must not destroy or silently downgrade data.

## Current Evidence

- `crates/candor-core/src/vault_store.rs` has one SQLCipher schema. Its current
  `migrate()` always runs `INSERT OR REPLACE ... schemaVersion = 1`, so an unknown
  future schema could be silently downgraded.
- The production vault is `candor-v3.sqlcipher`; the key remains in OS-backed
  storage. The renderer never receives paths or key material.
- `recording_store.rs` uses append-only encrypted chunks, `sync_all()` per chunk,
  and atomic manifest tmp/backup swaps. It can recover missing/corrupt manifests
  from chunks, but one unrecoverable recording can still fail a full library read.
- Recording manifest schema 1 is read compatibly as schema 2 through serde
  defaults. There is no explicit unknown-future-schema rejection or persistent
  quarantine receipt.
- Startup capture recovery already marks interrupted captures and has crash
  tests.
- `electron/main.ts` shuts down the core in `before-quit` but has no capture-aware
  close guard.
- Renderer job state includes `canceling`, but transcription and local LLM calls
  are synchronous inside the Rust JSONL request loop. The core cannot receive a
  second cancellation request while one of those calls is running.
- Packaged runtime, security, and M0-M5 verification currently pass.

## Proposed Implementation

### A. SQLCipher migration framework

1. Add `CURRENT_VAULT_SCHEMA_VERSION = 2`.
2. Detect whether `candor_meta` exists. Treat a new empty vault as version 0.
3. Reject versions greater than 2 without writing anything.
4. For schema 0, create the current schema transactionally with no backup.
5. For schema 1, close the keyed connection, byte-copy the encrypted vault to a
   sibling migration backup, reopen with the same core-owned key, run a single
   transaction, verify table/schema/row invariants, and commit schema 2.
6. Schema 2 adds only migration/quarantine receipt metadata; recording data is
   unchanged.
7. Store a random per-core-launch ID in the migration receipt. Retain the raw
   encrypted backup throughout the launch that performed migration. On a later
   core launch, reopen, verify invariants, mark the migration confirmed, then
   remove the backup.
8. On migration or invariant failure, close SQLite, restore the exact backup,
   reopen it, and verify the old schema and row invariants before returning a
   structured failure.
9. Add tests for idempotence, backup byte equality, row preservation, forced
   mid-migration failure and rollback, unknown future schema, and next-launch
   backup cleanup.

### B. Recording manifest migration and quarantine

1. Introduce explicit current manifest version 2 and reject versions above 2.
2. Migrate version 1 to 2 using a retained byte-identical migration backup and
   atomic write. Verify recording ID, state, chunk list, and referenced files.
3. Restore the original manifest if migration or invariant verification fails.
4. Leave corrupt recording directories untouched. Persist only an opaque
   quarantine receipt outside the recording directory, then omit that record
   from normal lists while continuing to return healthy recordings.
5. Expose counts and structured error codes, never raw paths or content.
6. Add tests for previous schema, interrupted migration, corrupt manifest plus
   healthy sibling, missing audio, unknown future schema, and quarantine
   persistence.

### C. Disk pressure

1. Add a small cross-platform free-space dependency owned by the Rust core.
2. Expose pathless storage health with `ok`, `low`, and `blocking` states.
3. Refuse a new capture below a blocking reserve. Before each chunk write,
   require enough space for encrypted output, manifest replacement, and reserve.
4. On a write failure or disk-full condition, preserve the last flushed manifest,
   mark the capture recoverable, and return a stable error code.
5. Render low disk as a persistent banner and disk full as a blocking recovery
   state, not a transient toast.

### D. Capture-aware close guard

1. Add a focused Electron window close-guard module.
2. Ask the Rust core for capture status before closing. If capture is active or
   finalizing, prevent close and show a native choice: keep recording, or stop,
   durably finalize, and quit.
3. If stop/finalization fails, keep the app open and show a blocking error.
4. Never kill the core merely to make close complete.

### E. Safe diagnostics

1. Build an allowlisted diagnostic preview in Electron main from pathless core,
   supervisor, build, and network-policy facts.
2. Add exact preview/export IPC methods, not a generic filesystem API.
3. Save through a main-owned dialog. Never include transcript, notes, audio,
   participant names, prompts, outputs, keys, tokens, PIDs, or full paths.
4. Let the user inspect the exact JSON in Advanced Settings before export.

### F. Cancellation honesty

Do not label synchronous transcription or LLM work cancellable yet. A renderer
AbortController would only abandon the response and would be dishonest. Treat
true cancellation as a separate core job-runner change unless you can identify a
small safe design that allows cancel messages while preserving the capture and
single-model scheduler invariants.

### G. Existing-data deletion gap

The license policy test says existing data is always accessible, but there is no
implemented recording delete RPC or UI. Proposed smallest safe addition: an
exact `recording.durable.delete` operation that atomically moves the selected
opaque recording directory into a vault-managed local trash area, records a
pathless deletion receipt, removes it from normal lists, and offers undo before
any later explicit purge. License state is not consulted. Review whether this is
the right data-safe interpretation of the requirement or whether deletion should
be deferred until a separately designed trash/purge workflow exists.

## Questions

1. Is raw encrypted file copy safe at the proposed point, or must WAL/checkpoint
   behavior change first?
2. Is the launch-ID backup-retention design sufficient to prove "successful next
   launch"?
3. Should corrupt manifests be skipped with a receipt, or should the whole
   library fail closed?
4. What invariants are missing from SQLCipher and manifest verification?
5. Does the close guard have a race between status and stop, and what is the
   smallest safe correction?
6. Which proposed items are required before Phase 6 can be called complete, and
   which should be deferred to avoid unsafe scope?
7. Is there a safe incremental true-cancellation design with the current
   synchronous stdio core, or should the plan explicitly report that gap?
8. Must the data-safe local trash operation ship in Phase 6 to make the licensing
   guarantee real, or is a policy claim without a delete implementation acceptable?

## Verification Expectations

- Every migration test uses isolated temporary data.
- Existing source and packaged smoke tests remain green.
- A fresh `npm run v3:verify` passes.
- No test claims real disk-full, hardware, signing, or clean-machine evidence
  without actually producing it.
