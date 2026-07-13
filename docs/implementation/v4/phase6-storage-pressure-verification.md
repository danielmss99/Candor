# Phase 6 Storage Pressure Verification

Date: 2026-07-13

Scope: pathless local-storage health, recording-start reserve, durable chunk
headroom, and capture recovery after writer failure.

## Policy

- `ok`: at least 2 GiB is available to the current user.
- `low`: less than 2 GiB but at least the 512 MiB start reserve is available.
- `blocking`: less than 512 MiB is available. New recordings are denied.
- `unavailable`: the filesystem probe failed. New recordings fail closed.
- Active chunk writes reserve 64 MiB plus the payload and 1 MiB of manifest
  headroom.

The core uses `fs2::available_space`, which reports the bytes available to the
current non-privileged user on the filesystem containing the local Candor data
root. The health response includes byte counts and policy thresholds, but never
the root path.

## Implemented Safety Properties

- Every recording start passes the storage-reserve gate before creating a
  recording directory.
- Text, transcript, audio, and notes chunks pass the write-headroom gate before
  creating a chunk file.
- One durable writer owns create, `write_all`, and `sync_all` behavior for all
  recording chunk types.
- A failed write or flush removes its uncommitted partial chunk while leaving the
  last committed manifest unchanged.
- A chunk that was fully synced but could not be added to the manifest remains as
  recoverable evidence for startup chunk scanning.
- Capture writer failure no longer finalizes a recording as successful. Stop
  returns an integrity failure and marks the recording `needsRecovery`.
- Storage health is included in `recording.durable.status` for the renderer's
  persistent banner and blocking state.

## Verification Results

```text
node scripts/cargo-with-local-perl.mjs test \
  --manifest-path crates/candor-core/Cargo.toml

75 passed; 0 failed
```

```text
node scripts/cargo-with-local-perl.mjs test \
  --manifest-path crates/candor-core/Cargo.toml \
  --features sqlcipher-vault

90 passed; 0 failed
```

Focused coverage includes:

- real free-space probing against an isolated temporary root;
- deterministic `ok`, `low`, `blocking`, and `unavailable` states;
- blocked capture start with no recording directory created;
- blocked chunk write with byte-identical committed manifest;
- pathless probe-failure response;
- capture stop after writer failure producing `needsRecovery`.

```text
npm run m1:durable-recording-smoke
npm run m1:durable-crash-smoke
npm run m1:capture-crash-smoke

all passed
```

```text
node scripts/cargo-with-local-perl.mjs clippy \
  --manifest-path crates/candor-core/Cargo.toml \
  --features sqlcipher-vault -- \
  -A clippy::result-large-err -D warnings

passed
```

The narrow Clippy allowance covers the two existing large `RpcResponse` findings
in `main.rs`. No storage-pressure finding is suppressed.

## Boundaries

- Tests inject available byte counts and never fill a real disk.
- Free space can change after any measurement. Actual write and flush errors
  remain fail-closed and preserve the last committed manifest.
- The renderer presentation is verified after the deletion contract lands so
  low disk, quarantine, and recovery use one persistent state system.
