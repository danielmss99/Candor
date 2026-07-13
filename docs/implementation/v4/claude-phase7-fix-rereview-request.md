# Claude Phase 7 Focused Fix Re-Review

Review only the fixes made after `cb0a504` for findings H1 and H2 from
`claude-phase7-final-review.md`. Do not edit the repository.

Inspect:

- `scripts/release-artifacts.mjs`
- `scripts/m0-artifact-manifest.mjs`
- `scripts/v3-release-checksums.mjs`
- `scripts/release-checksum-validation.mjs`
- `scripts/release-checksum-validation.test.mjs`
- `scripts/v3-release-readiness-audit.mjs`
- `tests/e2e/candor-electron.spec.ts`
- `docs/implementation/v4/claude-phase7-review-reconciliation.md`

Also inspect the removal of the unused `CANDOR_NETWORK_POLICY` environment entry
from `electron/core/core-client.ts` and `tests/e2e/candor-electron.ts`.

Questions:

1. Does the producer and validator now require exact two-way package
   name/hash/count agreement, including the Windows blockmap, without allowing
   stale, duplicate, path-shaped, or manifest-only files?
2. Does the Electron test deterministically prove that an external navigation
   emitted `will-navigate` and was prevented, without relying on a fixed sleep or
   an immediately satisfied URL assertion?
3. Does the session-fetch assertion exercise Electron request hardening rather
   than renderer CSP alone?
4. Did the fixes introduce any new High or Critical defect?

Verification already run:

- `npm test`: 34 files, 105 tests passed.
- `npm run test:electron`: 4 tests passed after a fresh Electron build.
- `npm run m0:ci-contract-smoke`: passed.

Start with `GO`, `GO WITH REQUIRED FIXES`, or `NO-GO`. Report only observed
defects with severity, exact file/line, evidence, minimum fix, and proving test.
State whether another focused re-review is required.
