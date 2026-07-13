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

## Phase 2c: Native IPC Modules

Date: 2026-07-12

- Split core/shell, report export, model import, local-AI asset import, v2 import,
  and licensing handlers into focused modules with one registration entrypoint.
- Every native handler validates that the caller is the active Candor main frame.
- Added shared input limits and opaque ID validation. File and folder picker
  results are canonicalized only in Electron main and never returned as paths.
- Whisper imports accept `.bin`; local instruct models accept `.gguf`; Windows
  runners accept `.exe`; all imported model assets remain hash-verified by the
  Rust core before commit.
- Moved native Word/PDF/Markdown decoding and custody validation into a shared,
  tested report module.

| Check | Result |
|---|---|
| `npm test` | passed; 14 files and 50 tests |
| `npm run electron:v3:build-main` | passed |
| Electron and source-security audits | passed; 90 checks and 5 mutation tests |
| unpacked Electron package plus `npm run m0:packaged-smoke` | passed with sender-frame validation active |

`electron/main.ts` decreased from 1,410 to 986 lines. The renderer still receives
only basenames and custody facts from native import/export operations.

## Phase 2d: Composition Root And Smoke Harness

Date: 2026-07-12

- Moved the packaged runtime, renderer, document, navigation, screenshot, and
  path-leak proof harness to `electron/smoke/m0-smoke.ts`.
- `electron/main.ts` now owns only early command-line policy, dependency wiring,
  IPC registration, window creation, and application lifecycle.
- The smoke harness receives explicit core, window, license, network, and output
  dependencies; it no longer creates a second application composition root.
- Retargeted the sandbox mutation test to the actual window-policy module so the
  source audit remains non-vacuous after extraction.

| Check | Result |
|---|---|
| `npm test` | passed; 14 files and 50 tests |
| `npm run electron:v3:build-main` | passed |
| Electron hardening audit | passed |
| source-security audit | passed; 91 checks and 5 mutation tests |
| unpacked Electron package plus `npm run m0:packaged-smoke` | passed after module relocation |

`electron/main.ts` is now 126 lines, below the V4 target of 250 lines.

## Phase 3a: Exact Renderer Core Channels

Date: 2026-07-13

- Replaced the generic `candor-core:call` IPC route with 43 fixed product
  channels. The preload still exposes named product functions, never a generic
  channel or Rust method selector.
- Main owns the immutable channel-to-method and timeout table. A parity test
  reads the preload source and fails if its fixed channel set differs from main.
- Updated modular source and product proofs so extracted runtime files remain
  substantively audited.

| Check | Result |
|---|---|
| `npm test` | passed; fixed-channel parity included |
| Electron and source-security audits | passed; generic core channel is banned and mutation-tested |
| local instruct fixture | passed against the named AI channels |
| unpacked Electron package plus `npm run m0:packaged-smoke` | passed |

Commit: `ee2afc6`

## Phase 3b: Renderer Input Validation

Date: 2026-07-13

- Added method-specific runtime validation before any renderer payload reaches
  the Rust process. Validators reject unknown fields, unsafe recording/model
  identifiers, oversized notes/questions/JSON, unsupported export formats,
  invalid consent identifiers, and out-of-range pages, chunks, and token counts.
- A coverage fixture provides one valid payload for every renderer core
  operation, so adding a channel without an input contract fails tests.
- The packaged proof caught a real 200-row transcript request against the new
  100-row contract. Renderer and preload pagination were corrected to the
  specified limit before the package was accepted.

| Check | Result |
|---|---|
| `npm test` | passed; 15 files and 57 tests at validator closure |
| `npm run electron:v3:typecheck-renderer` | passed |
| Electron and source-security audits | passed; 95 checks and 6 mutation tests |
| unpacked Electron package plus `npm run m0:packaged-smoke` | passed after transcript page correction |

Commit: `36fb977`

## Phase 3c: Enforced Rust Envelope

Date: 2026-07-13

- Electron sends UUIDv4 `id`/`requestId`, protocol version, method, parameters,
  and an ISO UTC timestamp. Rust validates complete versioned metadata, exact ID
  equality, UUID shape, timestamp shape, and protocol compatibility.
- Rust rejects replayed IDs with a bounded 1,024-entry recent-ID registry and
  echoes `requestId` on versioned responses. Electron requires matching `id` and
  `requestId`, a valid protocol version, and structured errors with retryability.
- The handshake now validates core version, schema version, capabilities, build
  target, and enabled features.
- Replaced `BufRead::lines()` with a bounded frame reader that never allocates
  beyond the 4,000,000-byte request boundary and drains an oversized frame before
  reading the next request.
- Direct proof scripts retain a legacy envelope compatibility path temporarily.
  The production Electron path always uses the enforced versioned envelope.
- Added `vitest.config.ts` so compiled tests under `dist-v3` cannot be rediscovered
  as stale duplicate tests.

| Check | Result |
|---|---|
| Rust tests | passed; 66 tests including handshake, duplicate ID, partial metadata, protocol mismatch, and bounded-reader recovery |
| `npm test` | passed; 15 files and 58 tests |
| `npm run core:v3:release` | passed; SQLCipher and local Whisper release sidecar staged |
| `npm run m0:packaged-smoke` | passed against the rebuilt release sidecar |
| `npm run v3:verify` | passed; full M0-M5 staged chain |

Commits: `a92456b`, `c615fcf`, and `6039f02`

The first two full-verifier attempts exposed proof scripts that still read only
`electron/main.ts` or expected Rust method names in preload source. The updater
and M3 product proofs now inspect the full modular Electron runtime and fixed
preload channels. Both targeted proofs and the complete staged verifier pass.

## Claude Process And Protocol Gate

Date: 2026-07-13

- Request: `docs/implementation/v4/claude-phase2-protocol-review-request.md`
- Review: `docs/implementation/v4/claude-phase2-protocol-review.md`
- Verdict: **Go with required fixes**.

| Finding | Disposition |
|---|---|
| H1 stale `captureActive` after process exit | Accepted. Exit now clears process-local capture state. Tests cover crash-after-active-capture and timeout-during-active-capture separately. |
| H2 raw Rust error messages crossed renderer IPC | Accepted. Main emits only bounded `CANDOR_CORE_ERROR:<CODE>` values. Renderer parsing preserves the code, and packaged smoke proves invalid input cannot echo its path-shaped value. |
| M1 notes counted characters but not UTF-8 bytes | Accepted. Notes have both a 2,000,000-character and 3,900,000-byte limit with multibyte coverage. |
| M2 PID reached renderer status | Accepted as defense in depth. Main retains PID for internal sidecar proof, while renderer core and supervisor views omit process identifiers. |
| M3 active-capture timeout lacked a test | Accepted. The test proves the process remains alive and capture state remains active when another request times out. |
| M4 permission source checks proved presence only | Accepted. Permission denial functions are directly tested, exact false behavior is audited, and a mutation to `callback(true)` fails the source proof. |
| L1 restart count changed before synchronous spawn | Accepted. Restart count changes only after a child object is created; synchronous failure returns a pathless `CORE_UNAVAILABLE` state. |
| L2 ping allowed arbitrary JSON | Accepted. Renderer ping is now parameterless. |
| L3 renderer supervisor returned protocol fault text | Accepted with M2. Renderer receives `hadError`, not fault text. |

The review found the temporary legacy direct-proof envelope safe because it runs
in separately spawned proof processes and cannot be mistaken for an Electron
response. That compatibility path remains tracked for later removal.

| Check after fixes | Result |
|---|---|
| `npm test` | passed; 16 files and 65 tests |
| Electron main build and renderer typecheck | passed |
| Electron/source-security/proof-audit self-tests | passed; 103 checks and 7 mutations |
| unpacked Electron package plus `npm run m0:packaged-smoke` | passed; structured invalid-input error and renderer PID omission proven |

Commit: `214b4be`

Claude re-reviewed only that fix commit in
`docs/implementation/v4/claude-phase2-protocol-fix-review.md` and returned
**Go**. It confirmed H1 and H2 are structurally closed, found no new Critical or
High defects, and approved renderer decomposition. The remaining low-risk audit
backlog item is a second mutation case for the permission-check return path; the
behavior already has a direct unit test and an exact source check.

## Phase 4 And 5: Renderer And Focused GUI

Date: 2026-07-13

The renderer decomposition, startup isolation, license-independent data access,
typed navigation, Record -> Review -> Export information architecture, warm
brand tokens, and Advanced Settings separation are implemented. The full record,
Claude findings and dispositions, package proof, and screenshot inventory are in
`docs/implementation/v4/renderer-gui-verification.md`.

| Check | Result |
|---|---|
| `npm run v3:verify` | passed; 66 Rust tests and 86 Vitest tests |
| Claude focused renderer fix review | **Go** |
| Windows unpacked package | passed |
| packaged runtime smoke | passed twice after updating obsolete activation/navigation assumptions |
| visual inspection at 1440 by 900 | passed; stable recheck screenshots recorded |

Commits: `541f91b` through `41d2763`, plus packaged proof alignment in `5a628e3`.

## Phase 6: Reliability And Data Protection

Date: 2026-07-12

SQLCipher migrations now create and retain verified encrypted backups, restore
after transactional failure, and reject unknown future schemas without touching
the source vault. Capture manifests with unsupported schemas are quarantined
without a legacy fallback. Disk headroom, active-write reserve, permanent
deletion intent, and persistent renderer recovery states are implemented.

Focused evidence is recorded in:

- `phase6-vault-migration-verification.md`;
- `phase6-manifest-quarantine-verification.md`;
- `phase6-storage-pressure-verification.md`;
- `phase6-permanent-deletion-verification.md`;
- `phase6-renderer-recovery-verification.md`;
- `phase6-implementation-review-reconciliation.md`.

Claude separately reviewed the Rust data-safety boundary and Electron/renderer
recovery boundary. Both focused re-reviews returned **Go** after the unsupported
schema fallback and shared Record/Stop disablement defects were fixed.

| Check | Result |
|---|---|
| Rust default tests | passed; 82 tests |
| Rust SQLCipher tests | passed; 97 tests |
| `npm test` | passed; 33 files and 101 tests |
| `npm run v3:verify` | passed; full M0-M5 staged chain |

## Phase 7: Electron, Accessibility, And Release Evidence

Date: 2026-07-12

Playwright now launches the real Electron shell and verifies the exact preload
surface, missing Node globals, navigation and popup denial, primary-screen axe
results, keyboard focus, and 1366 by 768 behavior at 125 and 150 percent display
scaling. The suite runs on the three-OS CI matrix, with Xvfb on Linux.

Release packages now receive streamed SHA-256 hashes in `SHA256SUMS`. Verification
requires an exact package match and a clean committed source tree. The readiness
audit accepts only the verification-mode path-safe receipt. The manual release
runbook defines stop conditions and the clean-install, upgrade, long-recording,
sleep/resume, device, disk-pressure, network-denial, and signing evidence still
required from real machines.

| Check | Result |
|---|---|
| `npm run test:electron` | passed; 4 Electron/axe tests |
| `npm test` | passed; 33 files and 101 tests |
| `npm run m0:ci-contract-smoke` | passed |
| `npm run v3:release-checksums:verify` | passed from commit `0a2d03e` |
| `npm run v3:release-readiness-audit` | checksum gate passed; external capture, cross-OS, and signing gaps remain visible |

## Known Non-Passing Or Unproven Gates

- signed production prerelease;
- clean-machine install and upgrade;
- production licensing verifier;
- physical cross-platform microphone/system capture;
- 5/30/60/180-minute real recording matrix;
- sleep/resume and device switching;
- macOS notarization and production Windows signing.
