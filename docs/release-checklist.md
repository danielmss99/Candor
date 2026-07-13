# Candor Release Checklist

Use this before publishing any installer.

## Source And Tests

- [ ] `npm ci` reports no unresolved high-severity npm vulnerability.
- [ ] `npm test` passes.
- [ ] `npm run v3:verify` passes.
- [ ] `npm run audit:source` passes with its mutation suite.
- [ ] Rust tests, formatter, and lints pass for release features.
- [ ] No unresolved high-severity dependency advisory remains.

## Package

- [ ] `npm run dist` creates the current-OS Electron artifacts.
- [ ] `npm run v3:release-artifact-smoke:strict` passes.
- [ ] `npm run m0:packaged-smoke` passes.
- [ ] `npm run m0:artifact-manifest` records final hashes.
- [ ] `npm run audit:release` finds no profile path, checkout path, or secret.
- [ ] The renderer has no Node.js globals and exposes the exact preload surface.
- [ ] Navigation, popups, webviews, and unauthorized network attempts are blocked.

## Data And Reliability

- [ ] Existing recordings open, export, and delete with license services offline.
- [ ] v2 import leaves source files untouched.
- [ ] Interrupted capture recovers within one flushed chunk.
- [ ] Low-disk and disk-full states are actionable.
- [ ] Failed migration preserves a verified backup and restores the old schema.
- [ ] Corrupt records are quarantined without hiding the healthy library.
- [ ] Uninstall does not delete the user vault or recordings without explicit
  user choice.

## Real Device Matrix

- [ ] Fresh Windows install starts and records microphone audio.
- [ ] System-audio consent and capture work on supported Windows hardware.
- [ ] 5-, 30-, 60-, and 180-minute recordings pass.
- [ ] Sleep and resume behavior is verified.
- [ ] Microphone and output-device switching is verified.
- [ ] Permission denial and recovery are understandable.
- [ ] 1366 by 768 at 125 and 150 percent scaling is usable.
- [ ] Keyboard-only and accessibility checks pass.

## Signing And Distribution

- [ ] Windows executable, sidecar, and installer have valid Authenticode
  signatures.
- [ ] macOS app and DMG are signed, notarized, stapled, and Gatekeeper-accepted.
- [ ] Linux package signatures or checksums meet the selected distribution policy.
- [ ] SHA-256 checksums are published for final artifacts.
- [ ] A clean-machine install and upgrade from the previous release pass.
- [ ] A rollback installer is retained.
- [ ] Privacy, terms, support, and third-party notices are current.

## Stop Conditions

Do not publish when migration rollback, capture recovery, data access under
license failure, artifact identity, signing, or clean-machine behavior is
unverified.
