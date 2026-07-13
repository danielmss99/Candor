# Candor V4 Verification Log

This file records commands that were actually run. It does not convert missing
hardware, signing, upgrade, or clean-machine evidence into passing claims.

## Phase 0 Baseline

Revision: `b29061334cff9c52654ad0f0528fee179151ed47`

Date: 2026-07-12

| Command | Result |
|---|---|
| `npm ci` | passed; 437 packages; 0 known npm vulnerabilities |
| `npm test` | passed; 6 test files; 29 tests |
| `npm run electron:v3:typecheck-renderer` | passed |
| `npm run core:v3:build` | passed |
| `npm run v3:verify` | passed |

The full staged verifier included 62 Rust tests, Electron hardening, stdio RPC,
SQLCipher, durable capture/recovery, local library/replay/transcription, local AI,
product surface, v2 import, updater policy, and source-security proof checks.

## Claude Plan Gate

- Request: `docs/implementation/v4/claude-plan-request.md`
- Response: `docs/implementation/v4/claude-plan-review.md`
- Reconciliation: `docs/implementation/v4/implementation-plan.md`
- Claude CLI completed successfully through the repository-independent helper in
  `C:/Users/danny/.agents/skills/claude-collaboration-loop/`.
- All three observed defects were validated against current source before being
  accepted.

## Phase 1a: Electron Root Commands

Date: 2026-07-12

| Command | Result |
|---|---|
| `npm install --package-lock-only --ignore-scripts` | passed; Tauri packages removed from the lockfile |
| `npm ci` | passed; 435 packages; 0 known npm vulnerabilities |
| `npm test` | passed; 6 test files; 29 tests |
| `npm run build` | passed; Rust release core, Electron main, and renderer built |
| `npm run start` with the isolated M0 smoke harness | passed; built renderer, release core handshake, exact preload, and disabled network policy |
| `npm run dev` with the isolated M0 smoke harness | passed; Vite selected free loopback port `5175`, debug core handshake, exact preload, and disabled network policy |
| `npm run v3:verify` | passed; full staged V3 proof chain |

Root `dev`, `build`, `start`, `preview`, and `dist` now target Electron. The
launcher distinguishes an explicitly configured loopback development renderer
from an unpackaged built renderer, uses the matching debug or release Rust core,
and rejects non-loopback renderer URLs. No `@tauri-apps` package remains in
`package.json` or `package-lock.json`.

## Phase 1b: Electron/Rust Source And Artifact Audits

Date: 2026-07-12

| Command | Result |
|---|---|
| `npm run audit:source:portable` | passed; 72 Electron/Rust checks and 5 mutation tests |
| `npm run audit:source` | passed through the PowerShell compatibility entry point |
| `npm run v3:source-security-proof` | passed; required-source, environment, Electron/Rust rule, and mutation evidence recorded |
| `npm run electron:v3:pack` | passed; staged path-remapped release core packaged into the unpacked Electron app |
| `scripts/audit-release-artifacts.ps1` | passed for 11 Electron package artifacts |
| `npm run m0:packaged-smoke` | passed; packaged Electron app and staged Rust sidecar completed the runtime proof |
| `npm run m0:artifact-manifest` | passed; package and sidecar hashes recorded |
| `npm run v3:verify` | passed; full staged V3 proof chain after audit replacement |

The source proof no longer reads Tauri files or treats a missing source as an
empty passing input. Its in-memory mutations prove failure for a missing main
process, disabled sandbox, generic preload filesystem operation, hardcoded
secret, and weakened v2-import originals guarantee. The previously mismatched
`recording.durable.status` operation is now present in the main allowlist,
preload operation set, and renderer declaration.

The first Electron-wide artifact scan found checkout and user-profile strings in
the Rust release sidecar. Production core builds now use a stable system build
root, remap repository and home prefixes, stage only the finished binary under
`build/core-bin`, and package that staged sidecar. A direct byte scan and the
full artifact audit confirmed that the rebuilt core contains neither the local
repository path nor `C:/Users/danny`.

## Phase 1c: Legacy Desktop Archive

Date: 2026-07-12

| Check | Result |
|---|---|
| Annotated tag `archive/tauri-v2` | created at `b29061334cff9c52654ad0f0528fee179151ed47` and pushed to `origin` |
| Legacy source removal | removed the former native shell, root renderer, root Vite entry, root TypeScript entry configs, legacy launch scripts, workflow, and stale handover/store files |
| `npm ci` | passed; 435 packages; 0 known npm vulnerabilities |
| `npm run m0:ci-contract-smoke` | passed; Electron workflow is sole active workflow and legacy paths are forbidden |
| `npm run build` | passed after making `v3/renderer/tsconfig.json` self-contained |
| `npm run v3:verify` | passed; full staged proof chain including v2 importer |

No runtime data directory, vault schema, recording store, or importer source was
deleted. `crates/candor-core/src/v2_importer.rs` remains active, canonicalizes
the selected source, constrains referenced audio to that source, copies into the
managed recording store, and continues to report `originalsUntouched: true`.

## Known Non-Passing Or Unproven Gates

- signed production prerelease;
- clean-machine install and upgrade;
- production licensing verifier;
- physical cross-platform microphone/system capture;
- 5/30/60/180-minute real recording matrix;
- sleep/resume and device switching;
- final data migration and rollback proof;
- macOS notarization and production Windows signing.
