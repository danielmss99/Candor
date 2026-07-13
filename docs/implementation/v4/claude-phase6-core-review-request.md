# Claude Phase 6 Focused Core Review

Review Candor's irreversible local-data operations. Do not edit files. Keep the response under 1,800 words.

Repository: `C:\Claude_Config\candor-v3-m0`
Branch: `codex/electron-consolidation`
Commits: `677bf1d`, `750ff1d`, `dc80724`, `f5f8ed8`

Inspect these actual files and their tests:

```text
crates/candor-core/src/sqlcipher_vault.rs
crates/candor-core/src/recording_store.rs
crates/candor-core/src/capture_service.rs
crates/candor-core/src/main.rs
```

Use these evidence files only as orientation, not as proof:

```text
docs/implementation/v4/phase6-vault-migration-verification.md
docs/implementation/v4/phase6-manifest-quarantine-verification.md
docs/implementation/v4/phase6-storage-pressure-verification.md
docs/implementation/v4/phase6-permanent-deletion-verification.md
```

Product invariants:

1. Future schemas and unsupported manifests are never modified.
2. Failed migration preserves the original SQLCipher vault and a verified encrypted backup.
3. Quarantine isolates one bad meeting without hiding healthy meetings or rebuilding unsupported data.
4. Failed chunk writes preserve the last committed manifest and never report a false finished state.
5. Permanent deletion is confirmed, exact-ID, finished-only, restart-safe, and license-independent.
6. No receipt or normal error leaks keys, user content, or full paths.

Adversarial questions:

- Can a crash, WAL state, rename failure, retry, or ordering error cause data loss or a false success?
- Can migration run on a future schema, commit without a valid backup, or discard the only usable copy?
- Can a future/corrupt manifest accidentally fall through to rebuild logic?
- Can deletion remove the recording but leave an unrecoverable index or intent state?
- Can disk checks be bypassed between preflight and write in a way the recovery model mishandles?
- Do tests assert the dangerous behavior, or merely the happy-path response shape?

Verification already passed: 81 default Rust tests and 96 `sqlcipher-vault` Rust tests. Physical disk exhaustion and long hardware recording remain unverified.

Required format:

1. Verdict: `GO`, `GO WITH REQUIRED FIXES`, or `NO-GO`.
2. Findings ordered by severity. Each finding must include file, line, evidence, user impact, and concrete fix.
3. Separate observed defects from optional improvements.
4. Explicitly assess migration downgrade safety, backup atomicity, quarantine immutability, deletion retry safety, and false-saved risk.
5. End with the smallest required fix set and exact re-review files.

Do not recommend cloud services, Tauri, format replacement, or unrelated refactors.
