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

The hosted Ubuntu and macOS runners initially exposed a timing race in the
oversized-line test harness. The deterministic replacement passed six
consecutive focused runs, the Electron main build, and the complete staged
verification. Claude independently reviewed that final fix and returned
`approve`.

The replacement hosted run then passed Windows and Ubuntu but exposed one
macOS proof-parser edge: PKTAP emitted three processless, zero-length TCP reset
records on a flow already owned by `nsurlsessiond`. The hardened parser now
requires a nonzero PKTAP flow ID, exact IP/TCP endpoint tuple, an earlier named
non-Candor owner packet, zero payload, and a reset flag. Conflicting owners,
future-only ownership, Candor ownership, missing metadata, data-bearing packets,
and incomplete correlation evidence all fail closed. The proof retains complete
evidence for every accepted correlation and refuses more than 25 correlations.

Verification for the final proof change:

- `node scripts/m0-network-deny-macos.mjs --validate-only`: passed.
- `npm run m0:proof-audit:self-test`: passed.
- `npm run m0:ci-contract-smoke`: passed.
- `npm run v3:verify`: passed after one isolated M2 timeout was reproduced by
  neither the focused M2 smoke nor the clean full rerun.
- `npm run test:electron`: 5 tests passed.
- `npm run v3:dependency-audit`: 0 vulnerabilities and 2 allowed unmaintained
  warnings for `rustybuzz` and `ttf-parser`.
- `git diff --check`: passed.

Claude independently reviewed the macOS correlation rule and returned
`approve` with no required findings. Its optional regression suggestions were
implemented and recorded in `claude-macos-proof-review-reconciliation.md`.
Claude then reviewed the complete reconciled diff and again returned `approve`
with no required defects.

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
