# Phase 6 Manifest Quarantine Verification

Date: 2026-07-13

Scope: recording-manifest compatibility, recovery isolation, and pathless
quarantine receipts.

## Implemented Safety Properties

- Accepts supported manifest schemas 1 and 2 and rejects schema 0.
- Detects a future manifest schema before typed deserialization so a newer state
  or field cannot be mistaken for ordinary corruption.
- Never falls back to an older manifest copy or chunk reconstruction after a
  future-schema result.
- Validates that the manifest recording ID matches its directory.
- Validates local-only chunk names, existing chunk files, and contiguous chunk
  indices before using or rewriting a manifest.
- Reconstructs a malformed current-schema manifest only when its chunk scan is
  complete and contiguous.
- Isolates manifest, chunk-scan, recovery-write, and search-content failures to
  one opaque recording ID.
- Continues returning healthy recordings when a sibling is quarantined.
- Leaves the recording directory untouched and writes a synced, pathless receipt
  under the core-owned recovery area.
- Reports current quarantines in list, paged-list, recovery, and search results.

## Verification Results

```text
node scripts/cargo-with-local-perl.mjs test \
  --manifest-path crates/candor-core/Cargo.toml \
  recording_store::tests

17 passed; 0 failed
```

The focused tests cover:

- corrupt-primary fallback to a valid backup;
- missing-manifest reconstruction from complete chunks;
- chunk-scan failure without whole-library failure;
- future-schema immutability even when an older backup exists;
- pathless quarantine receipt shape;
- healthy search results alongside unreadable sibling content;
- version 1 privacy-event migration compatibility.

```text
node scripts/cargo-with-local-perl.mjs test \
  --manifest-path crates/candor-core/Cargo.toml

69 passed; 0 failed
```

```text
node scripts/cargo-with-local-perl.mjs test \
  --manifest-path crates/candor-core/Cargo.toml \
  --features sqlcipher-vault

84 passed; 0 failed
```

```text
npm run m1:durable-crash-smoke

M1 durable crash recovery smoke passed.
```

```text
npm run m2:local-library-smoke

M2 local library export smoke passed.
```

```text
node scripts/cargo-with-local-perl.mjs clippy \
  --manifest-path crates/candor-core/Cargo.toml -- \
  -A clippy::result-large-err -D warnings

passed
```

The narrow Clippy allowance covers the two existing large `RpcResponse` findings
in `main.rs`. No recording-store or quarantine finding is suppressed.

## Boundaries

- Tests use isolated temporary recording roots. No user recording was opened,
  migrated, quarantined, or rewritten.
- A root-level failure that prevents the recordings directory itself from being
  read remains a blocking store error because no healthy sibling can be safely
  enumerated in that condition.
- The renderer recovery banner is implemented after the disk-health and deletion
  contracts so all persistent storage states share one UI policy.
