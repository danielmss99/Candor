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

## Phase 1d: Documentation And Product Identity

Date: 2026-07-12

| Check | Result |
|---|---|
| Root documentation | README, architecture, security, design, product, release, environment, source-proof, and third-party docs now describe Electron/Rust only |
| Product identity | window, renderer title, package product, workflow, process fixtures, and proof tools use `Candor` |
| `npm run m0:proof-audit:self-test` | passed after updating exact Windows and macOS process identities |
| `npm run electron:v3:dist:win` | passed; created `release-v3/Candor Setup 2.0.0.exe` and `release-v3/win-unpacked/Candor.exe` |
| `npm run v3:release-artifact-smoke` | passed; installer payload matched unpacked app, archive, and sidecar hashes |
| `npm run m0:packaged-smoke` | passed for `release-v3/win-unpacked/Candor.exe` |
| `scripts/audit-release-artifacts.ps1` | passed for 13 artifacts before stale old-name outputs were removed |
| `npm run v3:verify` | passed; full staged proof chain after the rename and documentation rewrite |

The application ID remains `com.candor.v3` deliberately. Changing it during
this consolidation could redirect OS application-data and key-storage identity,
which would risk making existing local data appear missing. Product display
names changed without changing that persistence identity.

## Claude Phase 1 Implementation Gate

Date: 2026-07-12

- Request: `docs/implementation/v4/claude-phase1-review-request.md`
- Review: `docs/implementation/v4/claude-phase1-implementation-review.md`
- Verdict: **Go** with no data-loss, existing-data-access, or active Tauri-path
  regression.

| Validated finding | Disposition and evidence |
|---|---|
| Production allowed any `file:` navigation | Fixed. Production accepts only the packaged renderer document. Packaged smoke separately attempts an arbitrary local file and records two denied navigations. |
| Core stderr was unbounded | Fixed. Packaged content is suppressed. Development diagnostics are redacted and capped at 64 KiB per core process. |
| Supervisor exposed an absolute executable path | Fixed. Renderer receives only `executableName`; independent recursive proof scanning found zero absolute paths. |
| Secret audit excluded most scripts | Fixed. All tracked `scripts/` files are scanned, and the mutation test injects a synthetic credential into a proof script. |
| `rawPathExposed` was self-declared | Fixed for M0 renderer evidence. The smoke recursively scanned 302 renderer-facing strings with zero findings, and the proof auditor independently recomputes the scan. |
| Shutdown response is intentionally untracked | Documented. Process exit is the fire-and-forget shutdown acknowledgement. |
| Rust remap flags could split on spaces | Fixed. Release builds use `CARGO_ENCODED_RUSTFLAGS` exclusively. |

The smoke initially caught its own raw local-file probe URL in diagnostic
samples. Navigation diagnostics now retain only the denial category, never the
target URL. A second negative run exposed a false positive where `https:/` was
misread as a Windows drive; the matcher now requires a valid drive boundary and
still detects paths embedded inside longer diagnostic strings.

Deferred to later planned phases:

- warn when unpackaged `--start` uses a stale staged core;
- remove `style-src 'unsafe-inline'` when renderer styling allows it;
- namespace the stable release-core target for concurrent local worktrees;
- add the substitute-core 2 MiB stderr stress test during process extraction.

### Committed Phase 1 Closure

Revision: `50f2b3e`

| Command | Result |
|---|---|
| `npm run electron:v3:dist:win` | passed; rebuilt `Candor Setup 2.0.0.exe` and the unpacked app from the committed revision |
| `npm run m0:packaged-smoke` | passed; exact renderer and arbitrary local-file navigation controls exercised |
| `npm run m0:artifact-manifest` | passed; current app, archive, and core hashes recorded |
| `npm run v3:release-artifact-smoke` | passed; installer payload matched unpacked artifacts |
| `scripts/audit-release-artifacts.ps1` | passed for 12 Electron release artifacts |
| `npm run v3:verify` | passed; 62 Rust tests, 29 frontend tests, SQLCipher, recovery, transcription, local AI, export, and importer proof chain |

The packaged renderer scan inspected 302 strings and found no absolute path.
The supervisor payload contained `candor-core.exe` as a basename and no
`executable` field. The network probe recorded two denied navigations: one
external URL and one arbitrary local file.

## Phase 2a: Window And Network Policy Extraction

Date: 2026-07-12

- Extracted JSON boundary primitives, renderer navigation policy, Chromium
  network enforcement, and main-window construction into focused modules.
- Security auditors now inspect the complete Electron runtime module set and
  require each extracted security source explicitly.
- Added unit coverage for packaged renderer pinning, loopback-only development,
  blocked remote requests, and pathless denial diagnostics.

| Check | Result |
|---|---|
| `npm test` | passed; 8 files and 35 tests |
| `npm run electron:v3:build-main` | passed with recursive Electron TypeScript compilation |
| `node scripts/m0-audit-electron.mjs` | passed |
| `node scripts/audit-source-security.mjs --self-test` | passed; 76 checks and 5 mutation tests |
| unpacked Electron package plus `npm run m0:packaged-smoke` | passed |

`electron/main.ts` decreased from 1,909 to 1,750 lines without changing preload,
vault, recording, importer, or application-data behavior.

## Phase 2b: Rust Core Process Client

Date: 2026-07-12

- Extracted the Rust process supervisor, bounded JSONL parser, request registry,
  structured core errors, method allowlists, and protocol types.
- Requests now carry the protocol version, a cryptographically random UUID in
  both compatibility `id` and typed `requestId` fields, and an ISO timestamp.
- Responses are runtime-validated; malformed JSON, incompatible envelopes,
  oversized lines, unknown IDs, duplicate responses, process exits, and timeouts
  reject pending work instead of silently degrading.
- The smoke restart checks `capture.status` and refuses to restart an active
  capture. Timeouts do not kill a core known to be capturing.

| Check | Result |
|---|---|
| `npm test` | passed; 11 files and 45 tests |
| fake-core process tests | passed for UUID correlation, malformed output, active-capture restart denial, and hung request handling |
| `npm run electron:v3:build-main` | passed |
| Electron and source-security audits | passed; 80 checks and 5 mutation tests |
| unpacked Electron package plus `npm run m0:packaged-smoke` | passed against the real Rust sidecar |

`electron/main.ts` decreased from 1,750 to 1,410 lines. The Rust request parser
already accepts JSON-valued IDs and ignores additive request metadata, so this
upgrade remains compatible with the existing core while moving the active
Electron transport to UUID correlation.

## Known Non-Passing Or Unproven Gates

- signed production prerelease;
- clean-machine install and upgrade;
- production licensing verifier;
- physical cross-platform microphone/system capture;
- 5/30/60/180-minute real recording matrix;
- sleep/resume and device switching;
- final data migration and rollback proof;
- macOS notarization and production Windows signing.
