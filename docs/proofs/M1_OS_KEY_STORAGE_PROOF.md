# M1 OS Key Storage Proof

Status: **DPAPI, Keychain, and Linux Secret Service key custody implemented; core passphrase fallback proof implemented; passphrase fallback UX pending**

## Requirement

Candor v3 must keep vault key material under operating-system custody where
available. The renderer must not receive vault keys, wrapped key paths, or
arbitrary filesystem authority.

## Implemented Baseline

- Windows uses DPAPI through `CryptProtectData` and `CryptUnprotectData`.
- A 32-byte local vault key is generated with Windows CNG
  `BCryptGenRandom`.
- The DPAPI-wrapped key is stored under the local Candor data root.
- Reopening the key proves persistence and same-user unwrap behavior.
- macOS uses the native Keychain through the Rust keyring stack.
- Linux uses the native Secret Service protocol, the same OS key-storage
  family commonly reached through libsecret-compatible desktop keyrings.
- macOS and Linux key records are scoped by a hash of the local Candor data
  root, so test roots and product roots do not reuse each other's vault key.
- The DPAPI-managed key opens the production SQLCipher vault through the Rust
  sidecar without requiring a renderer-visible passphrase.
- `vault.openWithOsKeyProof` reopens that same production vault to verify the
  OS-managed key is stable after reopen when native key storage is available.
- The proof result reports only booleans and backend facts. It does not include
  key bytes, fingerprints, or raw filesystem paths.
- If a native OS key store is unavailable, for example on a headless Linux CI
  runner without Secret Service, `vault.status` reports explicit unavailable
  key-storage facts and `vault.openLocal` is skipped by smoke tests without
  exposing keys or raw paths.
- The core-only `vault.proofPassphraseFallback` method proves the fallback
  SQLCipher path can create, reopen, and reject a wrong key without exposing a
  passphrase, key material, or raw path through the renderer bridge.

## Core RPC Method

- `vault.proofOsKeyStorage`
- `vault.openLocal`
- `vault.openWithOsKeyProof`
- `vault.proofPassphraseFallback`

`vault.openLocal` is the product-shaped local vault open method. It is exposed
through the typed preload bridge, takes no key, passphrase, or path parameters,
and returns only custody facts. The proof methods are allowed by `candor-core`,
but they are not exposed by the Electron preload renderer bridge.

## Verification Commands

```powershell
npm run m1:verify
npm run m1:verify:sqlcipher
```

`npm run m1:verify:sqlcipher` runs `scripts/m1-vault-smoke.mjs`, which calls
`vault.proofOsKeyStorage`, `vault.openLocal`,
`vault.openWithOsKeyProof`, and `vault.proofPassphraseFallback`, then verifies
when native key storage is available:

- backend is `dpapi`, `keychain`, or `secret-service`
- native OS key storage is available
- the generated key is persisted
- reopening returns the same key material inside the core
- the OS-managed key opens the production encrypted SQLCipher vault
- the SQLCipher vault reopens with the same OS-managed key
- no renderer-visible passphrase is required
- no key material is exposed
- no raw path is exposed

It also verifies the core-owned passphrase fallback proof can reopen the
fallback SQLCipher vault and reject a wrong key without exposing secrets.

Packaged smoke verifies the same `vault.openLocal` path through the typed
renderer bridge whenever native storage is available. On a runner where the
native store is unavailable, packaged smoke must report
`native-os-key-storage-unavailable` without exposing keys or raw paths.

## Remaining M1 Work

- Add passphrase fallback UX and user recovery story.
- Add direct clean-machine proof artifacts for macOS Keychain and Linux Secret
  Service availability.
