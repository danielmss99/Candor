# Phase 6 Permanent Deletion Verification

Date: 2026-07-13

Scope: license-independent permanent deletion of a durably finished local
meeting.

## Deletion Contract

1. The renderer can call only `recordingDelete(recordingId)`.
2. Electron main validates the opaque ID and opens a native warning dialog.
3. Cancel is the default and escape path.
4. Only after explicit confirmation does Electron main invoke the private Rust
   method `recording.durable.delete`.
5. Rust rejects active and recovery-required recordings.
6. Rust syncs a content-free deletion intent before moving the recording into a
   same-filesystem tombstone.
7. The active library stops seeing the recording at the rename boundary.
8. Rust permanently removes the tombstone and returns a structured incomplete
   state if recursive removal fails.
9. The core removes the encrypted SQLCipher index row.
10. Content-free intent and quarantine metadata are removed only after recording
    data and encrypted index cleanup both succeed.

No step imports, reads, or calls the license service. The TypeScript deletion IPC
accepts a dependency type containing only the core client and main-window
provider, so license access is unavailable at compile time.

## Crash Recovery

- Crash before intent sync: no deletion commit exists and the recording remains.
- Crash after intent sync but before rename: startup resumes the confirmed
  deletion.
- Crash after rename: startup removes the retained tombstone.
- Tombstone removal failure: the recording stays outside the active library and
  startup retries.
- Vault cleanup failure: the content-free pending marker remains and startup
  retries encrypted index cleanup.

## Verification Results

```text
node scripts/cargo-with-local-perl.mjs test \
  --manifest-path crates/candor-core/Cargo.toml

81 passed; 0 failed
```

```text
node scripts/cargo-with-local-perl.mjs test \
  --manifest-path crates/candor-core/Cargo.toml \
  --features sqlcipher-vault

96 passed; 0 failed
```

Focused Rust coverage includes active/recovery rejection, same-volume tombstone,
structured removal failure, pre-rename crash recovery, startup resume, idempotent
SQLCipher cleanup, and an RPC round trip without license state.

```text
npm test -- --run

32 files passed; 95 tests passed
```

Frontend and Electron tests verify that the native confirmation defaults to
Cancel, describes all deleted local content, and keeps the Rust delete method out
of the renderer core allowlist.

```text
npm run electron:v3:typecheck-renderer
npm run electron:v3:build
npm run electron:v3:pack
npm run m0:packaged-smoke

passed
```

Packaged proof:

```text
release-v3/proofs/m0-packaged-runtime-smoke-win32-x64.json
```

GUI evidence:

```text
release-v3/proofs/m3-product-surface-win32-x64-detail.png
```

The detail screenshot verifies that Delete meeting is a restrained destructive
secondary action, Review report remains the one dominant coral action, and both
controls fit without overlap at the packaged smoke viewport and display scale.

```text
node scripts/m0-audit-electron.mjs
npm run audit:source

Electron hardening passed.
Source security passed: 114 checks and 7 mutation tests.
```

```text
node scripts/cargo-with-local-perl.mjs clippy \
  --manifest-path crates/candor-core/Cargo.toml \
  --features sqlcipher-vault -- \
  -A clippy::result-large-err -D warnings

passed
```

The narrow Clippy allowance covers the two existing large `RpcResponse` findings
in `main.rs`. No deletion finding is suppressed.

## Boundaries

- Test deletions use isolated temporary roots. No user recording was deleted.
- Forced termination is represented at each durable boundary through deterministic
  fixtures. Task Manager and power-loss testing remain release-gate work.
- The operation is permanent. Candor does not present a trash or undo workflow.
