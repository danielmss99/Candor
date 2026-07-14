# SPEC-3 Claude Code Review Reconciliation

Claude reviewed the live working tree through the authenticated local CLI. The
raw review is preserved in `claude-code-review.md`.

## Fixed

1. **Private prompt transport**
   `local_instruct_model.rs` no longer uses a truncating `fs::write` in the
   shared temporary directory. It creates a new file atomically, retries name
   collisions, uses mode `0600` on Unix, removes partial writes, and has a
   permissions regression test.
2. **Corrupt managed speech override**
   A present but unverified managed model now blocks execution with its measured
   verification error. Rust no longer silently substitutes the packaged model
   after `models.verifyLocal` reported the override as corrupt.
3. **Decision-lock binding in source mode**
   A manifest that claims `releaseReady` or `release-selected` now triggers the
   same model/runtime lock binding checks even when the verifier was not invoked
   with `--require-ready`.

## Rejected as defects

- Leaving an independently verified language capability ready when only speech
  fails its compiled trust anchor is intentional. The accepted plan requires
  corruption to disable only the affected capability, and aggregate readiness
  remains false.
- Refreshed bundle-status failures are not silent. `SettingsView` renders the
  unavailable state with `role="alert"`. It does not prescribe reinstall for an
  unknown or transient RPC failure.
- The canonical-path race requires write access to installed resources. The
  specific scenario also requires replacement content to retain the approved
  digest. Signed, read-only installation remains the release control. Fully
  eliminating the later verify-to-spawn race requires an OS-specific execution
  design and is not a source-wave patch.
- A model filename is not a raw filesystem path. Runner banners are already
  removed before generated output is accepted, while full configured paths are
  explicitly withheld.
- Client-side rejection of an unverified selected model is optional UX hardening.
  The Rust boundary is authoritative and rejects the request, which prevents an
  integrity bypass even when renderer state is stale.

## Deferred improvements

- Combine bundled status and language resolution into one immutable inspection
  snapshot to avoid duplicate manifest parsing. Digest reads are already cached,
  and signed production resources are read-only.
- Consolidate the three internal SHA-256 helpers into a shared module when a
  common no-follow file-opening policy is introduced.

## Post-review verification

- `cargo test --manifest-path crates/candor-core/Cargo.toml`: 99 passed.
- `cargo test --manifest-path crates/candor-core/Cargo.toml --features local-whisper`:
  103 passed.
- `cargo clippy --manifest-path crates/candor-core/Cargo.toml --all-targets --features local-whisper -- -D warnings`:
  passed.
- `npm run spec3:ai-bundle:verify:self-test`: passed.
- `npm run spec3:ai-bundle:verify`: passed in source-interface mode.
