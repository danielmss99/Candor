# Candor V4 Electron Consolidation Baseline

Date: 2026-07-12

## Branch And Revision

- Branch: `codex/electron-consolidation`
- Baseline revision: `b29061334cff9c52654ad0f0528fee179151ed47`
- Source: current `origin/main` after the Candor production brand update merged

## Active Architecture

The production path is already:

```text
React renderer
  -> hardened Electron preload
  -> Electron main
  -> JSONL RPC over stdio
  -> Rust core
```

Active source roots are `electron/`, `v3/renderer/`, and
`crates/candor-core/`. The active package configuration is
`electron-builder.v3.yml`.

## Baseline Measurements

| File | Lines | Bytes |
|---|---:|---:|
| `electron/main.ts` | 1,763 | 60,248 |
| `electron/preload.cts` | 177 | 7,320 |
| `v3/renderer/src/CandorApp.tsx` | 1,372 | 57,454 |
| `package.json` | 136 | 9,914 |
| `README.md` | 63 | 3,793 |

`CandorApp.tsx` owns more than 80 local state values plus startup, capture,
library, transcript, notes, AI, review, export, settings, privacy, and licensing
coordination. `electron/main.ts` owns the core process, request registry,
handshake, security policy, window creation, smoke harness, domain IPC, file
dialogs, licensing registration, and app lifecycle.

## Legacy Surface Still Active

- Root `dev` and `build` scripts still target the legacy Vite/Tauri renderer.
- `build:all`, `build:store`, `tauri`, `tauri:dev`, and `tauri:release` are active
  package scripts.
- `@tauri-apps/api` and `@tauri-apps/cli` remain installed.
- `.github/workflows/tauri-build.yml` remains active.
- `src-tauri/`, the root `src/` renderer, `scripts/tauri-dev.ps1`,
  `scripts/tauri-release.ps1`, and `public/tauri.svg` remain in the default tree.
- The root README documents Tauri as the normal architecture.
- `scripts/audit-source-security.ps1` and
  `scripts/v3-source-security-proof.mjs` still inspect Tauri calendar sources.
- `scripts/audit-release-artifacts.ps1` still includes a Tauri target path.

The V4 consolidation must replace these active assumptions with Electron/Rust
checks before removing the legacy source. Tauri removal must not weaken source or
release auditing.

## Existing Strengths To Preserve

- Electron uses `contextIsolation: true`, `sandbox: true`, and
  `nodeIntegration: false`.
- Navigation, popup, permission, and network restrictions are already tested.
- The Rust core enforces bounded JSONL frames and returns protocol metadata.
- The renderer has runtime response parsers and a handshake-aware client.
- Durable capture, crash recovery, SQLCipher, OS key storage, local exports,
  model hash checks, and pathless privacy receipts have passing proof coverage.
- The v2 importer reads legacy Markdown and managed audio without modifying the
  originals.
- The approved Keep Tab brand and warm GUI token system are current.
- Licensing is activation-based, main-process-owned, and does not require a
  persistent account for normal use.

## Baseline Verification

All commands passed from the baseline revision:

| Command | Result |
|---|---|
| `npm ci` | passed, 437 packages installed, 0 known npm vulnerabilities |
| `npm test` | passed, 6 files and 29 tests |
| `npm run electron:v3:typecheck-renderer` | passed |
| `npm run core:v3:build` | passed |
| `npm run v3:verify` | passed |

The staged verifier also passed:

- deterministic brand asset checks;
- 62 Rust core tests;
- Electron hardening and stdio smoke;
- SQLCipher vault smoke;
- durable capture and crash recovery;
- local library, replay, transcription, and model boundaries;
- product surface and renderer typecheck;
- heuristic and local-instruct AI boundaries;
- v2 import smoke;
- updater and source-security proofs.

The SQLCipher smoke intentionally emits failed-HMAC messages while testing that
the wrong key is rejected. The test passed and those messages are not a baseline
failure.

## Baseline Risks

1. Removing `src-tauri/` before replacing Tauri-specific source audits would
   either break CI or silently reduce coverage.
2. Removing the root `src/` tree must not be confused with deleting legacy user
   data. Runtime data locations and the Rust v2 importer are separate and must
   remain untouched.
3. The current Electron protocol has useful checks but does not yet implement the
   complete V4 envelope, cryptographic IDs, duplicate rejection, method-specific
   timeouts, lifecycle state model, or exact typed preload surface.
4. Main-process smoke automation is embedded in `electron/main.ts`; extracting
   production lifecycle code must preserve the packaged proof harness without
   keeping it in the production composition root.
5. Renderer modularization must preserve stale-request protection, smoke-mode
   onboarding, license data access rules, and core-backed privacy wording.
6. Schema migration, backup, rollback, disk-full, and long-recording claims need
   real tests before V4 can be called data-safe or release-ready.

## Baseline Status

Phase 0 is reproducible and green. No current baseline failure is being carried
forward as accepted debt. Hardware capture, long-duration recording,
clean-machine upgrade, production signing, and notarization remain future proof
gates rather than baseline claims.
