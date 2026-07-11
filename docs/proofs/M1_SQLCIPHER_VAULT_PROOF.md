# M1 SQLCipher Vault Proof

Status: **SQLCipher vault feature-gated; packaged builds use native OS-key local open when available; core passphrase fallback proof implemented**

## Requirement

Candor v3 must store structured data in an encrypted local vault. The renderer
must not receive vault keys, raw vault paths, or arbitrary filesystem authority.

## Implemented Baseline

- `candor-core` opens a local `candor-v3.sqlcipher` database under the local
  data root.
- SQLCipher is implemented behind the Cargo feature `sqlcipher-vault`.
- SQLCipher is bundled through `libsqlite3-sys` with vendored OpenSSL when that
  feature is enabled.
- `PRAGMA cipher_version` is checked before migrations run.
- A minimal `candor_meta` table stores schema version `1`.
- The proof harness rejects short passphrases.
- Wrong-key proof opens the same vault with a bad key and verifies reads fail.
- Native OS key storage opens the production SQLCipher vault using a generated
  key held only inside `candor-core`: DPAPI on Windows, Keychain on macOS, and
  Secret Service on Linux when available.
- The passphrase wrong-key harness writes to a separate proof database so it
  cannot collide with the production OS-key vault.
- The core-only passphrase fallback proof creates and reopens that separate
  fallback vault, verifies the schema, and proves a wrong key cannot read it.
- Core summaries report:
  - `backend: sqlcipher`
  - `encrypted: true`
  - `keyMaterialExposedToRenderer: false`
  - `rawPathExposed: false`
- `vault.status` reports the native OS-key backend, whether local open is
  available, and whether passphrase fallback is required.

## Core RPC Methods

- `vault.status`
- `vault.openLocal`
- `vault.openLocalProof`
- `vault.openWithOsKeyProof`
- `vault.proofWrongKeyFails`
- `vault.proofPassphraseFallback`

`vault.openLocal` is the product-shaped local vault open method. It is exposed
through the typed renderer bridge and takes no secrets. `vault.openLocalProof`,
`vault.openWithOsKeyProof`, `vault.proofWrongKeyFails`, and
`vault.proofPassphraseFallback` are proof-harness methods. They exist to prove
SQLCipher behavior, OS key custody, fallback custody, and wrong-key failure.
The renderer preload does not expose the proof methods.

## Verification Commands

```powershell
cargo test --manifest-path crates/candor-core/Cargo.toml
npm run m1:bootstrap-native-perl
npm run m1:vault-smoke
npm run m1:verify:sqlcipher
```

The default debug build reports `sqlcipherAvailable: false` and refuses to open
a vault with `SQLCIPHER_FEATURE_DISABLED`. The packaged v3 Electron build uses
the `sqlcipher-vault` feature through `npm run core:v3:release`. The SQLCipher
proof requires:

```powershell
node scripts/cargo-with-local-perl.mjs build --manifest-path crates/candor-core/Cargo.toml --features sqlcipher-vault
```

On Windows, vendored OpenSSL requires a native `MSWin32` Perl. MSYS and Git Perl
are rejected because OpenSSL does not accept their path style for the MSVC
target. `npm run m1:bootstrap-native-perl` downloads the hash-pinned Strawberry
Perl portable zip into `%LOCALAPPDATA%\CandorToolchains`, verifies SHA-256, and
extracts a user-local native Perl that `scripts/cargo-with-local-perl.mjs`
discovers automatically.

Current local proof result on Windows:

```powershell
npm run m1:verify:sqlcipher
# M1 SQLCipher vault smoke passed.
```

## Current Test Coverage

- SQLCipher vault opens without exposing key material or raw paths.
- Wrong key cannot read the encrypted vault.
- Passphrase fallback proof creates, reopens, and rejects a wrong key against a
  separate fallback SQLCipher database without exposing secrets.
- Short passphrase is rejected.
- Default feature-disabled build reports SQLCipher unavailable explicitly.
- Native OS key-storage proof persists and reopens a local generated key
  without exposing key material or raw paths when the OS store is reachable.
- `vault.openLocal` opens the production encrypted vault without exposing key
  material, raw paths, or requiring a renderer-visible passphrase when native
  key storage is available.
- Packaged smoke calls `vault.openLocal` through the preload bridge and
  verifies the renderer sees only structured custody facts. On runners where
  native key storage is unavailable, packaged smoke verifies a safe unavailable
  fallback state instead.
- SQLCipher smoke writes a durable recording and verifies metadata lands in the
  encrypted `candor_recordings` index. The index stores state, chunk counts,
  byte counts, and encrypted-at-rest facts, not raw paths or keys.
- Real sidecar smoke uses a temporary local data directory, creates a vault when
  native key storage is available, proves wrong-key failure against a separate
  proof database, and verifies `vault.status` reports no key material or raw
  paths afterward when built with `sqlcipher-vault`.

## Remaining M1 Work

- Add passphrase fallback UX and user recovery story.
- Move meeting metadata from proof tables into the encrypted schema.
