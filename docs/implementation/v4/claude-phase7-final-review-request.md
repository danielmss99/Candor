# Claude Phase 7 Final Adversarial Review Request

## Role

Act as an independent senior security, Electron, release, and test reviewer.
Do not edit the repository. Review the committed Phase 7 changes after
`a85b5a3` through `cb0a504` and report evidence-backed findings only.

Codex remains responsible for validating and implementing any feedback. Do not
approve work because the request says tests passed.

## Parent mission

Candor is a local-first Electron/React desktop meeting recorder with a Rust
sidecar. The renderer is sandboxed, Node.js is disabled, the preload is an exact
product allowlist, and all meeting data and AI processing stay on the device.
The normal workflow is Record -> Review -> Export.

The full mission is not release-ready until physical cross-platform capture,
network-denial, clean-machine, signing, and notarization evidence exists. This
review must flag any code or wording that hides or bypasses those boundaries.

## Review scope

Inspect the actual repository and diff, especially:

- `electron/main.ts`
- `playwright.electron.config.ts`
- `tests/e2e/candor-electron.ts`
- `tests/e2e/candor-electron.spec.ts`
- `vitest.config.ts`
- `package.json`
- `.github/workflows/v3-m0.yml`
- `scripts/v3-release-checksums.mjs`
- `scripts/v3-release-readiness-audit.mjs`
- `scripts/m0-ci-contract-smoke.mjs`
- `docs/testing/MANUAL_RELEASE_PROOF_RUNBOOK.md`
- `docs/proofs/V3_RELEASE_READINESS_AUDIT.md`
- `docs/implementation/v4/phase7-electron-accessibility-verification.md`
- `docs/implementation/v4/verification.md`

Run or inspect `git diff a85b5a3..cb0a504` as needed.

## Required review questions

1. Can `CANDOR_E2E` or the isolated user-data/scale test controls affect a
   packaged production app or weaken sandboxing?
2. Do the Playwright tests genuinely verify the real Electron security surface,
   denied navigation/popups, keyboard behavior, axe results, and scaled compact
   layouts, or can they pass while those behaviors are broken?
3. Can checksum verification be fooled by stale packages, a stale M0 manifest,
   dirty source, malformed package names, symlinks, path disclosure, duplicate
   entries, or a source/package commit mismatch?
4. Does the release-readiness validator adequately validate the checksum receipt
   without turning missing external evidence into success?
5. Is CI ordering portable and fail-closed on Windows, macOS, and Linux?
6. Do the release runbook and verification ledger overclaim any hardware,
   signing, network, migration, accessibility, or cross-platform result?
7. Did Phase 7 introduce a correctness, security, privacy, data-loss, or release
   regression elsewhere in the V4 architecture?

## Verification already run by Codex

- `npm test`: 33 files, 101 tests passed.
- `npm run test:electron`: 4 tests passed.
- `npm run m0:ci-contract-smoke`: passed.
- `npm run v3:verify`: passed before the checksum slice; rerun is scheduled after
  this review and any fixes.
- `npm run electron:v3:dist:win`: passed at commit `cb0a504`.
- `npm run v3:release-artifact-smoke`: passed.
- `npm run m0:artifact-manifest`: passed and records `cb0a504`.
- `npm run v3:release-checksums` and `:verify`: passed with installer, manifest,
  and source commit hashes aligned.
- `npm run m0:packaged-smoke`: passed.
- `npm run v3:release-signing-proof`: ran and correctly reports unsigned Windows
  binaries plus missing macOS/Linux packages.
- `npm run v3:release-readiness-audit`: checksum gate passed; physical capture,
  cross-OS M0, and signed release gates remain failed or missing.

## Known external blockers

- no consented real mic plus system-audio proof in this run;
- Windows network-deny proof needs administrator authority;
- macOS and Linux packaged/network receipts are absent locally;
- Windows Authenticode credentials are absent;
- macOS notarization and Linux signing artifacts/credentials are absent;
- clean-machine install/upgrade and 5/30/60/180-minute hardware runs remain
  manual release gates.

## Output contract

Start with one verdict: `GO`, `GO WITH REQUIRED FIXES`, or `NO-GO`.

Then provide findings ordered Critical, High, Medium, Low. Every finding must
include:

- severity;
- observed defect versus optional improvement;
- exact file and line;
- evidence and realistic failure mode;
- concrete minimum fix;
- test that proves the fix.

End with:

- required fixes before push or PR;
- optional backlog suggestions;
- assumptions and files not fully inspected;
- whether a focused re-review is required.

Do not treat a proof receipt as proof unless its producer and validator support
the claim. Do not recommend weakening a strict gate to make the release look
ready.
