# Phase 6 Vault Migration Verification

Date: 2026-07-13

Scope: SQLCipher vault schema migration from version 1 to version 2.

## Implemented Safety Properties

- Detects the stored schema before any migration write.
- Creates new vaults directly at schema version 2.
- Rejects unknown future schemas without rewriting the database or creating a
  migration backup.
- Converts WAL vaults to rollback-journal mode and verifies `delete` mode before
  copying the encrypted main database.
- Holds SQLite's exclusive transaction lock from the raw snapshot through the
  schema commit so another process cannot write between backup and migration.
- Writes the encrypted backup to a core-owned partial file, flushes it with
  `sync_all()`, verifies byte length plus SHA-256, and atomically promotes it
  before migration writes begin.
- Preserves SQLCipher `kdf_iter`, `cipher_page_size`, and indexed recording-count
  invariants through the migration transaction.
- Updates the schema version only inside the version 1 to 2 transaction.
- Rolls back an injected mid-migration failure and verifies the original version
  1 schema and rows remain readable.
- Retains the backup for the launch that migrated the vault.
- Removes the retained backup only after a different launch verifies schema,
  SQLCipher settings, and that the indexed row count did not decrease.
- Returns pathless migration status and the actual database schema version.

## Verification Results

```text
node scripts/cargo-with-local-perl.mjs test \
  --manifest-path crates/candor-core/Cargo.toml \
  --features sqlcipher-vault vault_store::tests

14 passed; 0 failed
```

The focused tests cover:

- version 1 migration and byte-equal encrypted backup;
- current-version reopen without downgrade;
- future-version immutability;
- forced migration failure and transaction rollback;
- cleanup and replacement of an abandoned partial backup;
- same-launch backup retention;
- next-launch verification and backup removal;
- legitimate row additions between launches;
- WAL checkpoint and rollback-journal backup;
- passphrase and DPAPI-backed vault paths.

```text
node scripts/cargo-with-local-perl.mjs test \
  --manifest-path crates/candor-core/Cargo.toml \
  --features sqlcipher-vault

81 passed; 0 failed
```

```text
node scripts/cargo-with-local-perl.mjs test \
  --manifest-path crates/candor-core/Cargo.toml

66 passed; 0 failed
```

```text
npm run m1:verify:sqlcipher

M1 SQLCipher vault smoke passed.
```

```text
node scripts/cargo-with-local-perl.mjs clippy \
  --manifest-path crates/candor-core/Cargo.toml \
  --features sqlcipher-vault -- \
  -A clippy::result-large-err -D warnings

passed
```

The narrow Clippy allowance covers two pre-existing `RpcResponse` size findings
in `main.rs`. No migration finding is allowed or suppressed.

The SQLCipher test and smoke logs include expected HMAC failures from the
deliberate wrong-key rejection proof. Those lines are evidence that an incorrect
key cannot decrypt the vault, not a test failure.

## Boundaries

- Tests use isolated temporary vault roots. No user vault was opened or migrated.
- A forced process or power loss cannot be simulated deterministically by the
  unit suite. Durability is established by the synced pre-migration backup,
  SQLite transaction rollback, and next-launch verification contract.
- Cross-platform clean-machine migration remains a release-gate activity.
