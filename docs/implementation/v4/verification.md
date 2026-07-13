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

## Known Non-Passing Or Unproven Gates

- signed production prerelease;
- clean-machine install and upgrade;
- production licensing verifier;
- physical cross-platform microphone/system capture;
- 5/30/60/180-minute real recording matrix;
- sleep/resume and device switching;
- final data migration and rollback proof;
- macOS notarization and production Windows signing.
