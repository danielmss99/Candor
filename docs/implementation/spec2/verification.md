# SPEC-2 verification

Date: 2026-07-13

## Automated verification

The reviewed source passed:

- `npm run v3:verify`
  - 87 Rust tests passed.
  - 40 Vitest files and 134 tests passed.
  - M0 through M5 smoke and proof clients passed with versioned envelopes.
- `cargo fmt --manifest-path crates/candor-core/Cargo.toml --all -- --check`
- `cargo clippy --manifest-path crates/candor-core/Cargo.toml --all-targets --all-features -- -D warnings`
- `npm run test:electron:build`
  - 5 Playwright Electron tests passed.
  - Sandbox and exact preload-surface checks passed.
  - Keyboard Record to Review to Export and axe checks passed.
  - 125 percent and 150 percent scaling checks passed.
  - The GUI evidence matrix covered 20 states across 5 desktop viewports.
- Source-security proof passed.
- Product-surface smoke passed.
- `git diff --check` passed.

## Independent review

Claude Code reviewed the implementation and returned six findings. Codex fixed
five and rejected one only after repository tracing and a proving regression
test. Claude then reviewed the complete reconciliation and returned `APPROVE`
with no new defects. See `claude-review-reconciliation.md`.

## Release evidence still required

The source is not declared public-beta ready until these environment-dependent
gates are complete:

- Authenticode signing with the production certificate.
- Elevated Windows network-deny capture for the final packaged candidate.
- Clean-machine install and upgrade from the retained legacy application ID.
- Real microphone and system-audio device validation.
- Real 5, 30, 60, and 180 minute recording runs.
- Sleep, resume, and device-switch validation.
- macOS and Linux capture, packaging, and network proof where applicable to the
  cross-platform milestone.

Automated checks must not substitute for these manual or hardware proofs.
