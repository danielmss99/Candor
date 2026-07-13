# Claude Review Request: Candor V4 Phase 1

You are reviewing completed Phase 1 work in the Candor repository. Do not edit
files. Perform an adversarial implementation review and return findings for
Codex to validate and implement.

## Objective

Phase 1 makes Electron plus the Rust core the sole active application without
losing data access, weakening security evidence, or leaving contradictory build,
CI, packaging, product-name, or documentation paths.

Accepted plan:

`docs/implementation/v4/implementation-plan.md`

Verification log:

`docs/implementation/v4/verification.md`

Baseline revision:

`b29061334cff9c52654ad0f0528fee179151ed47`

Review revision:

`3c4004f`

Branch:

`codex/electron-consolidation`

## Commits

```text
c34674b chore: capture Electron v4 baseline
1980ec9 chore: make Electron v4 the default build
a3759ca security: make source audits Electron authoritative
15bf982 chore: archive legacy Tauri application
3c4004f docs: make Electron Rust architecture authoritative
```

The former application is preserved at the pushed annotated tag
`archive/tauri-v2`, pointing to
`b29061334cff9c52654ad0f0528fee179151ed47`.

## Implemented Work

1. Root `dev`, `build`, `start`, `preview`, and `dist` now target Electron.
2. A repository-owned launcher distinguishes a loopback Vite renderer from a
   built renderer, selects debug or staged release core, and rejects non-loopback
   dev URLs.
3. Tauri npm dependencies and package scripts are removed.
4. Tauri source, legacy root renderer, launch scripts, root Vite entry/config,
   stale workflow, and stale handover/store files are removed from the branch.
5. `m0-ci-contract-smoke.mjs` forbids the legacy paths, requires the Electron
   workflow to be the sole active workflow, and verifies the v2 importer remains.
6. Source security auditing now uses one portable Electron/Rust evaluator. It
   requires source files to exist and runs five in-memory mutation tests.
7. Release artifact auditing defaults to Electron artifacts.
8. The release Rust core builds under a stable system root, remaps repository and
   home prefixes, stages under ignored `build/core-bin`, and is packaged from
   there. The rebuilt sidecar passed byte scans for the checkout and user profile.
9. The `recording.durable.status` main/preload/declaration mismatch is fixed.
10. Product display identity is now `Candor` across package, window, renderer,
    workflow, process fixtures, and proof tooling. `com.candor.v3` is unchanged to
    avoid redirecting existing app-data and key-storage identity.
11. README, architecture, security, design, product, environment, third-party,
    release, and source-proof docs now describe Electron/Rust and the approved
    warm Keep Tab brand.

## Verification That Passed

- `npm ci`, 435 packages, zero known npm vulnerabilities
- `npm test`, 6 files and 29 tests
- `npm run build`
- `npm run dev` under the isolated Electron smoke harness
- `npm run start` under the isolated Electron smoke harness
- `npm run audit:source`, 72 checks and 5 mutation tests
- `npm run v3:source-security-proof`
- `npm run m0:ci-contract-smoke`
- `npm run m0:proof-audit:self-test`
- `npm run electron:v3:dist:win`
- `npm run v3:release-artifact-smoke`
- `npm run m0:packaged-smoke` for `release-v3/win-unpacked/Candor.exe`
- `npm run m0:artifact-manifest`
- `scripts/audit-release-artifacts.ps1`, 12 current artifacts after stale output cleanup
- `npm run v3:verify`, including 62 Rust tests and the v2 importer smoke

Current local Windows artifacts:

```text
release-v3/Candor Setup 2.0.0.exe
release-v3/win-unpacked/Candor.exe
release-v3/win-unpacked/resources/bin/candor-core.exe
```

## Known Limits

- This is Phase 1 only. `electron/main.ts` and `CandorApp.tsx` remain large.
- The exact V4 protocol, lifecycle, capture state machine, renderer split,
  migration/rollback, and GUI simplification are later phases.
- Cross-OS CI has not run for this branch yet.
- Windows installer and binaries are not production-signed.
- Clean-machine install/upgrade, real long recording, sleep/resume, and device
  switching remain unproven.
- No persisted schema or runtime data path was intentionally changed.

## Review Questions

1. Did removal of the old application accidentally remove anything needed to
   access existing data or perform v2 import?
2. Are root commands, CI, packaging, docs, and process names genuinely
   Electron-authoritative, or is an active legacy path still present?
3. Can the new source audit pass vacuously, miss a high-impact Electron/Rust
   regression, or expose sensitive values in its proof output?
4. Is the stable release-core build/staging approach safe and portable across
   Windows, macOS, and Linux? Look for races, stale binary risks, flag handling,
   code-signing impact, and path leakage.
5. Did the `Candor` product-name change break an expected artifact, process,
   signing, network, or proof path?
6. Do the rewritten documents overclaim implementation or release readiness?
7. Identify any data-loss, security, build, packaging, or verification flaw that
   should block Phase 2.

## Required Response Format

Start with findings ordered by severity. Every observed defect must include:

- severity: Critical, High, Medium, or Low;
- file and line;
- evidence from current source;
- concrete impact;
- a minimal fix;
- a focused test.

Separate observed defects from optional improvements. State explicitly when a
concern is uncertain or requires another operating system to verify. End with a
Phase 2 go/no-go recommendation and the exact blockers, if any.
