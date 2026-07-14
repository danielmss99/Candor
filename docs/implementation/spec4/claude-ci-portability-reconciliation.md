# Claude CI Portability Reconciliation

Claude confirmed that the `cfg(test)` key and constructor are absent from production builds and that the production OS-backed key path remains fail-closed.

## Findings

1. **Fail-closed coverage gap**: accepted. Added `production_key_path_encrypts_or_fails_closed`, which exercises `TerminologyService::with_roots`. The test verifies encrypted output when the OS key store is available and verifies `TERMINOLOGY_KEY_UNAVAILABLE` with no store file when it is unavailable.
2. **Unused test key root**: no code change. The test constructor keeps the same roots as production so terminology and recording fixtures remain naturally aligned; the fixed key is intentionally isolated behind `cfg(test)`.

No P0 defect was reported. The accepted coverage addition preserves production behavior and makes the headless Linux expectation explicit.
