# Claude CI Portability Re-review Request

Review the uncommitted change in `crates/candor-core/src/terminology_dictionary.rs` after PR #9 failed on headless Ubuntu.

## Failure

Six terminology unit tests tried to use the production Secret Service keyring and failed with `TERMINOLOGY_KEY_UNAVAILABLE`. Production behavior is intentionally fail-closed when OS-backed key storage is unavailable.

## Proposed fix

- Add `test_encryption_key: Option<[u8; 32]>` only under `cfg(test)`.
- Keep `TerminologyService::with_roots` on the production OS-backed key path.
- Add a private `cfg(test)` constructor that supplies a fixed test-only key.
- Make unit tests use the test constructor.
- Rename the round-trip test so it claims encrypted storage, not OS-key integration.

## Verification

- All 7 terminology tests pass.
- A normal production `cargo check` passes.
- `cargo fmt` passes.

## Review questions

1. Can the test-only key or constructor enter a production build or runtime path?
2. Does this preserve fail-closed production key-storage behavior?
3. Is the fixed key acceptable for unit tests that exercise serialization, encryption, corruption, concurrency, prompting, and correction decisions?
4. Is there a safer minimal design that does not require a headless desktop keyring in CI?
5. Identify any P0 or P1 correctness, security, or test-coverage defect with file and line evidence.

Do not edit the repository. Return findings only, ordered by severity. Clearly distinguish defects from optional improvements.
