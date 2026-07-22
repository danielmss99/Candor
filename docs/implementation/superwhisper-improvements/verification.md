# Verification Record

Date started: 2026-07-19
Last updated: 2026-07-20

## Status summary

The approved Superwhisper-inspired implementation is present and the final
automated Windows checks pass. Candor is still a local-first, meeting-first,
account-optional application. Meeting data remains behind pathless IPC and the
renderer receives neither raw paths nor key material.

This is not a production-release claim. The current package is an unsigned
Source Interface installer with no bundled AI model. Physical hardware,
consented real-audio, elevated firewall, live traffic, signing, clean-source
provenance, and macOS and Linux release proof remain open.

## Review gates

- User approval of the implementation plan: yes.
- Local adversarial review: completed throughout implementation. Findings in
  setup routing, media identity, encrypted search cleanup, Windows key
  creation, child-process cleanup, quit lifecycle, recursive V4 custody,
  forged renderer frames, protected-term approval, diarization licensing,
  combined audio, Source Interface bundle inventory, core network denial,
  persistent media cleanup, and packaged companions were resolved and retested.
- Claude plan, implementation, and final reviews: not performed. The earlier
  proposed sanitized transmission was rejected before repository material left
  the workspace. Claude authentication was not tested. Fresh informed user
  approval is required before any external transmission.
- Files whose first line is `CLAUDE INVOCATION NOT PERFORMED` are status
  artifacts, not Claude-authored review evidence.

## Final automated evidence

The production-code snapshot is branch `main`, head
`b37b6c98d02d5f6da5623b12e69fc91d1b184939`, with a dirty working tree because
the implementation was not committed. The final custody, setup accessibility,
single-instance, Source Interface inventory, media cleanup, and companion-proof
changes affected production or release code, so the Windows installer and all
package proofs were rebuilt after those changes.

| Command or proof | Outcome | Scope and notes |
|---|---|---|
| `npm test` | PASS, 79 files and 463 tests | The final standalone suite and the aggregate Vitest stage passed all 463 tests. The aggregate stage completed in 10.329 seconds. |
| `npm run electron:v3:typecheck-renderer` | PASS | Current renderer and `CandorApiV4` surface. |
| `npm run electron:v3:build-main` | PASS | Current Electron main process and bundled preload. |
| `npm run electron:v3:build` | PASS | Release core, companions, main/preload, renderer, icon, bundle-policy, and publication-policy stages passed. |
| `npm run core:v3:build` | PASS | Normal desktop core enables `sqlcipher-vault,local-whisper`. |
| Current normal core suite | PASS, 31 library and 339 binary tests | This is the current post-latch Rust regression proof. `npm run core:v3:build` also passed in the final aggregate. |
| Earlier four-feature Rust matrices | SUPERSEDED HISTORICAL EVIDENCE | All-features, SQLCipher-only, local-Whisper-only, and no-default matrices passed before the final persistent cleanup-latch changes. Their old exact counts are not claimed as current proof. |
| Core Clippy, all features and targets, warnings denied | PASS | A fresh post-latch run completed without accepting a Rust warning. |
| `npm run tools:v3:test` | PASS, 28 tests | Read-only CLI and MCP allowlists, bounds, sanitization, pagination, partial-result propagation, timeouts, denial, and shutdown. |
| Tools Clippy, all targets, warnings denied | PASS | Automation companions are warning-free. |
| Core and tools `cargo fmt --check` | PASS | Final Rust formatting. |
| `npm run audit:source` | PASS, 213 checks and 36 mutation tests | Includes core Cargo lockfile and production network API denial, Electron and renderer network-call denial, companion network denial, alias and dynamic-import mutations, and tested comment, string, and test-only exclusions. |
| `npm run m1:verify` | PASS within final aggregate | Durable recording, crash recovery, consent, native capture, capture proof, and cleanup passed. |
| `npm run m3:verify` | PASS within final aggregate | Product surface, core build, and renderer typecheck passed. |
| `npm run v3:verify` | PASS, 13 of 13 stages | Generated `2026-07-21T00:55:40.635Z`, completed `2026-07-21T01:00:38.942Z`, 298.307 seconds proof wall time and 298.058 seconds summed stage time. Proof: `release-v3/proofs/v3-local-verification-win32-x64.json`. |
| Focused setup and process Playwright reruns | PASS | Existing-user migration, reduced-motion setup, 200 percent keyboard navigation, contrast remediation, and second-instance behavior passed before the final suite. |
| `npm run test:electron` | PASS, 12 of 12 | Final run completed in 415.1 seconds. It covers a real Electron process, exact preload custody, sandboxing, all six setup steps, persisted direct and Back navigation, the existing-user nonblocking prompt, reduced motion, 200 percent keyboard and axe coverage, 125 and 150 percent layouts, dark theme, licensing formatting, visual evidence, safe enabled-shortcut second-process handling, and exact process cleanup. A separate OS query found no retained Electron or core process. |
| `npm run electron:v3:dist:win` | PASS in 143.6 seconds | Final Source Interface installer built from the current production code. Exact bundle inventory passed and the expected no-default-model warning remained. |
| `npm run v3:release-artifact-smoke:strict` | PASS | Seven of seven required extracted entries existed and matched unpacked SHA-256 hashes. No artifact gap was recorded. |
| `npm run v3:icon-proof` | PASS | Packaged Windows icon proof passed. |
| `npm run spec3:packaged-ai-smoke` | PASS | The Source Interface package contains exactly the reviewed no-default-model bundle inventory and no orphan AI payload. |
| `npm run m0:packaged-smoke` | PASS in 65.2 seconds | Packaged app and core started, renderer path audit found zero issues, external navigation and windows were denied, and the deliberate external request was blocked. |
| `node scripts/packaged-companion-runtime-smoke.mjs` | PASS | Real packaged `candorctl` and `candor-mcp` executed all six read-only operations. Mutation-shaped requests were denied, recursive custody checks and stderr scanning passed, process enumeration failed closed, exact complete-tree hashes matched before and after, and temporary data was removed. The harness has 19 passing tests. |
| `npm run v3:sbom` and `npm run v3:sbom:verify` | PASS | SPDX document contains 846 packages and verifies. It intentionally contains zero bundled-AI packages because this is a Source Interface package. |
| `npm run m0:artifact-manifest` | PASS | Artifact manifest was regenerated and honestly records `git.dirty: true`. |
| `npm run v3:verify-main-architecture` | PASS for architecture, not release provenance | Working-tree and `origin/main` Electron architecture passed. No release commit was requested because the implementation is uncommitted, so the readiness gate correctly rejects release reachability. |
| `npm run v3:release-signing-proof` | RECORDED, `releaseReady: false` | Audit consistency passed and the current signing and platform gaps were recorded. |
| `npm run v3:release-readiness-audit` | RECORDED, `releaseReady: false` | Current missing and failed release gates were recorded. This is an evidence report, not release approval. |
| `npm run m0:proof-audit` | EXPECTED EXIT 1, `exitReady: false` | Windows staging, smoke, artifact, and manifest passed. Ten Linux or macOS gates are missing and the Windows network gate needs an elevated session. No firewall rule was left behind. |
| `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\m0-network-deny-windows.ps1 -ValidateOnly` | PASS as preflight only | The current package identity resolved correctly and NetSecurity was available, but the result explicitly reported `validateOnlyIsNotNetworkProof: true`, `administrator: false`, and `canCreateFirewallRules: false`. No firewall rule was created. |
| `npm run v3:goal-audit` | RECORDED, `missionComplete: false` | Audit execution passed and external or physical gates remain explicitly incomplete. |
| Final `git diff --check` | PASS | No whitespace error. Git emitted only LF-to-CRLF notices. |

The aggregate stage durations were: icons 4.002 seconds, identity 1.063,
M0 CI contract 0.975, M0 local verification 70.751, source security 10.510,
updater policy 4.975, M1 capture 46.185, M1 SQLCipher 25.175, M2 60.683,
M3 16.769, M4 36.210, M5 10.431, and Vitest 10.329.

## Current Windows artifact

- Installer: `release-v3/Candor Source Interface Setup 0.4.0.exe`
- Built: `2026-07-21T00:49:15.3167899Z`
- Size: 131,879,700 bytes
- SHA-256: `AC6931CED3E197F2CD6CD6A1D472D7AF44375FB612B64995AA00D2D56BEA86D8`
- Blockmap SHA-256: `CC9CDB87E27BEB30441776777BD6EA0D40F934182BED50C0D27A22CA503114E2`
- Authenticode: `NotSigned`
- Package profile: Source Interface, `releaseReady: false`,
  `no-default-selected`, and zero bundled AI assets

Packaged identities:

| Entry | Bytes | SHA-256 |
|---|---:|---|
| `Candor.exe` | 225,448,960 | `AFDFC4A92EAC6D36E87B784365A7BA6E3C77BDD6A990E1697CED2EDEBA0D77A3` |
| `app.asar` | 154,686,012 | `09E3D4713CED2E1727D061700F5D3E6502FC7C509A36DD33CE00E3E4DDDA6D82` |
| `candor-core.exe` | 18,410,496 | `40698ADBF644D1AF4B8805F52B9B8A9E01488921407CAE9E4CECDCADB85B056F` |
| `candorctl.exe` | 524,800 | `443C2516E6D751046C7E4F0D501DB7EFBB21900BB2026307D02137D6D9E84E26` |
| `candor-mcp.exe` | 566,272 | `7B9BB9F94DC2977D62E7EFAF12943EB21AA73A13698136ECFC4814AF1E7AB120` |

The installer and four executable payloads are unsigned. `app.asar` is an
unsigned package archive, not an executable.

## SBOM and packaged automation

The verified SBOM is `release-v3/Candor-0.4.0-SBOM.spdx.json`, 697,038
bytes, SHA-256
`97939C9ABA9EB5B13E0D8A81A8A58398CBE9D491B10D045FFFB186EEC83803D5`.
Its 846 packages are one Candor application package, 490 npm packages, 353
Rust packages, and two companion packages. It contains zero bundled-AI
packages.

The packaged companion proof executed list, search, summary, transcript,
export, and statistics through both `candorctl` and MCP. It verified the exact
six-tool allowlist, unknown-method and mutation denial, 30-second and
4,000,000-byte bounds, recursive path and key custody, fail-closed process
enumeration, and removal of its isolated data root. Before and after hashes
matched for the complete tree, SQLCipher vault, key sidecars, recording
sidecars, and other sidecars; WAL and SHM were explicitly `notPresent`. Its
plaintext scan is deliberately scoped to one fixture text chunk and two
fixture transcript payloads and excludes meeting labels, speaker labels, and
manifest metadata.

## Focused implementation proof

### Setup, microphone, and shortcut

- Six separately rendered steps persist schema version, completed steps,
  deferrals, last step, and the one-time existing-user prompt through serialized
  atomic JSON writes.
- Restart routing resumes the first not-completed step, including a deferred
  step. Direct and Back navigation use the bounded `setup.visit` operation so
  the active step also survives restart. Current-session navigation is not
  pulled backward by persistence updates. A seeded existing-user Electron test
  proves that meetings remain reachable while the one-time prompt and
  nonblocking warnings are persisted.
- Native microphone proof covers enumeration, unique fingerprint matching,
  OS-default fallback, denied access, silence, clipping, disconnect, RMS and
  peak levels, bounded 16 kHz mono memory, bounded WAV return, zeroing, Blob URL
  revocation, and mutual exclusion with recording. Changing the preferred
  microphone stops and zeroes an active probe before applying the preference.
  Back and defer actions remain available while discovery is slow or hung. The
  probe creates no meeting or filesystem audio artifact.
- Shortcut proof covers strict grammar, reserved combinations, conflicts,
  register-before-unregister replacement, rollback, duplicate initialization,
  debounce, reset, disable, single-instance behavior, second-instance focus,
  and synchronous quit cleanup. The event only restores and focuses Candor and
  opens an accessible recorder modal. Capture begins only through its explicit
  Start action. The Windows process proof launches a real secondary process
  while an enabled binding is persisted, verifies primary-window restoration,
  and reaps only the exact tracked secondary identity. Conflict copy remains
  owner-neutral and never guesses which application owns a binding.

### History, profiles, replacements, and models

- Trust History has immutable revisions, encrypted raw transcript chunks,
  raw-versus-normalized comparison, processing receipts, revision selection,
  reprocessing from authenticated original audio, and bounded encrypted FTS5
  search.
- Protected-term approval is core-owned and tied to the current immutable
  revision, capture-time rule snapshot, bounded preview token, and current
  manifest state. A valid approval creates a new review revision and receipt;
  forged or stale approval is rejected.
- General, 1:1, Interview, Standup, Lecture, and Custom profiles persist as
  versioned core records. Capture snapshots language, source, model tier,
  dictionaries, replacements, recap template, and live-transcription choice.
- Deterministic replacements are separate from ASR vocabulary hints. Model
  cards expose verification, size, language, hardware, warm state, and measured
  latency without claiming a bundled default. Profile model tiers use a compact,
  keyboard-native radio selector instead of an unstyled native dropdown.

### Live and durable audio

- Trusted provisional transcription uses one bounded PCM consumer, fixed
  pathless `transcript.partial` events, deterministic replacements, bounded
  sessions and events, cancellation, and reconciliation only after a durable
  final revision commit.
- Combined live transcription retains tagged microphone and system lanes,
  aligns source watermarks, averages overlap, preserves non-overlap, and emits
  non-overlapping five-second 16 kHz mono windows.
- Final transcription and reprocessing select microphone and system tracks for
  combined capture, convert and resample each source, align by capture start,
  sum with clamping, and record the output channel as `combined`. Explicit
  single-channel requests remain single-channel.

### Imported media and diarization

- Windows import accepts verified-local PCM16 WAV, MP3, AAC-LC or ALAC in M4A
  or MP4, and Vorbis in WebM. Forged magic, traversal names, remote or mapped
  storage, device paths, reparse points, cloud placeholders, video-only MP4,
  and WebM Opus fail closed with typed errors.
- Electron uses one asynchronously read file handle, 512 KiB chunks, SHA-256
  identity, pre-read and post-read metadata checks, a five-minute monotonic
  deadline, capture checks, and buffer zeroing. Rust opens the source with a
  native Windows handle, rejects reparse and cloud attributes, resolves and
  validates the final handle path and storage type, and stages from that same
  verified handle. The staged digest is independently verified before durable
  creation.
- Media jobs are bounded, single-flight, cancellable, terminally reconciled,
  and preempted by recording according to the tested state machine. Persistent
  cleanup latches and startup recovery gates block capture until interrupted or
  failed import cleanup is safely reconciled, including after restart.
- Diarization remains a fail-closed foundation. A permit requires an available
  local engine, a verified model, reviewed matching license evidence permitting
  local use and redistribution, and a matching passing benchmark. No engine or
  model is bundled, and speaker names are explicit user-controlled metadata.

### Custody and automation

- Every async preload response is normalized through the V4 renderer custody
  contract with `rawPathExposed: false` and
  `keyMaterialExposedToRenderer: false`. A recursive structural guard rejects
  nested path, key, token, secret, or material fields while allowing reviewed
  bounded metadata and opaque transcript text.
- Forged renderer tests reject a correct webContents ID with the wrong frame, a
  wrong ID with the correct frame, a destroyed main window, and a missing main
  window across every setup, shortcut, and microphone-test IPC path.
- `shortcut.triggered` has one exact typed payload and no arbitrary event
  subscription surface.
- `candorctl` and `candor-mcp` expose only read-only list, search, summary,
  transcript, export, and statistics operations over child stdio. There is no
  HTTP listener, webhook, raw path, arbitrary method, or mutation surface.
  Core-owned read-only listing and search incrementally enumerate bounded
  sources, enforce manifest, descriptor, decrypted-text, segment, and response
  budgets, and preserve `sourceTruncated` and `totalCountExact` through both
  companions.

## Verification incidents resolved

- Deferred License persistence could rerun startup routing and pull the active
  wizard backward. Setup-load routing is now claimed once per real load, and
  License actions are disabled while persistence is active.
- The final setup write applies and verifies a user-only Windows ACL through a
  helper bounded at 10 seconds. Production-path samples ranged from 1.5 to 7.8
  seconds under load. The Local AI step now exposes `aria-busy`, announces
  "Saving setup locally," changes the button label, and keeps actions disabled
  until persistence settles. Playwright allows 25 seconds after every atomic
  setup transition. Focused and full sequential reruns passed.
- The 200 percent setup test exposed insufficient contrast on the step label.
  The label now uses the accessible information color, and all six steps plus
  the defer dialog pass keyboard navigation, axe, reduced-motion, focus, and
  viewport checks in the final Electron suite.
- Existing-user migration now has interactive Electron proof: a seeded meeting
  opens immediately, the one-time prompt persists, and Home and Settings retain
  nonblocking setup warnings without hiding recording or the existing library.
- One failed Playwright run left an Electron/core process tree alive after the
  root PID exited. E2E now records exact PID, creation-time, executable-path,
  and ancestry identities before quit, revalidates each exact survivor, and
  performs bounded deepest-first cleanup without name-based killing. Launch
  failures use the same cleanup path, and test profiles are selected before the
  single-instance lock is acquired. PID reuse, unrelated siblings, raced exit,
  timeout, malformed snapshots, and rejected core shutdown are covered.
- Initial full-system process snapshots created enough Windows PowerShell and
  WMI contention to expose one real setup ACL failure. Discovery was narrowed
  to the owned launcher and approved Electron/core image names, normal cleanup
  was narrowed to lightweight exact-PID checks, and the redundant pre-quit WMI
  scan was removed. The focused reproduction and final 12 of 12 suite then
  passed, followed by an OS query confirming no retained process.
- A real secondary Candor launch is now tracked by PID, creation time, image
  path, and ancestry. The final proof confirms the single-instance lock restores
  the primary without changing workspace state and that cleanup cannot kill an
  unrelated process or miss an exact surviving secondary.
- Encrypted-search invalidation could see Windows error 145 when an in-process
  background FTS builder created a sidecar during bounded cleanup. Errors 32,
  33, and 145 now use bounded retry. The exact regression and 25 of 25 stress
  attempts passed, followed at that earlier snapshot by all four Rust feature
  matrices. Their exact counts are superseded as described above.
- Windows DPAPI first-key creation is serialized inside the supported core
  process so synchronized callers receive one key identity without renderer
  key exposure.
- Child-core tools enforce total response and shutdown deadlines, close pipes,
  terminate poisoned children, and reap them on timeout and disconnect.
- Generic renderer responses previously relied too heavily on the two custody
  sentinels. Recursive field-name enforcement, exact reconstruction for
  reviewed status payloads, nested path and key mutations, public-key rejection,
  and forged-frame tests now fail closed at both runtime schema and preload
  boundaries.
- The Source Interface bundle verifier now inventories the entire tree and
  rejects orphan files and directories, symlinks or junctions, transient files,
  case collisions, and any asset under `no-default-selected`.
- Core source auditing now requires the checked-in Cargo lockfile and rejects
  network client, server, and socket dependencies, lockfile packages, and
  production Rust networking APIs. Electron and renderer auditing also rejects
  direct, aliased, CommonJS-member, and dynamic-import network calls. The
  mutation suite proves these denials while comments, strings, and test-only
  fixtures remain accepted.
- macOS quit coalesces shutdown, preserves canceled-quit behavior, shuts down
  desktop services once, and then finalizes quit through a tested helper.
- Media import source identity, private staging, cancellation, event allowlist,
  preemption, and cleanup races were hardened and stress-tested. Persistent
  cleanup latches survive restart, recording start fails closed until safe
  recovery clears them, and panic or quarantine paths cannot silently remove
  the gate.
- Packaged companion proof now executes every CLI command and MCP tool against
  one encrypted fixture, recursively checks custody and stderr, fails closed if
  process enumeration is unavailable, and compares exact complete-tree,
  SQLCipher, key, recording, and other-sidecar hashes before and after.
- The first packaged companion run exposed that summary and statistics requested
  100-row core pages while the core read-only limit is 50. The companion now
  derives its core page size from the shared 50-row list limit. Two focused
  regressions, 28 tools tests, Clippy, formatting, the rebuilt package, and both
  packaged companion interfaces passed after the correction.
- Failed, interrupted, prerequisite-only, or stale-build runs are not counted
  as successful evidence.

## Manual and hardware checks still pending

- Built-in, USB, and Bluetooth microphone selection and audible playback
- Physical missing-default, disconnect, silence, clipping, and OS privacy block
- Global shortcut injection while another app is focused and while Candor is
  minimized
- Shortcut behavior after lock, unlock, sleep, and resume
- Real microphone, system, and combined durable capture
- Real local Whisper inference with a verified model
- Real combined live and final transcript comparison
- Interactive screen-reader and assistive-technology observation. Automated
  keyboard, axe, reduced-motion, focus-order, and 200 percent checks pass.
- Elevated Windows firewall-denial proof and live OS traffic trace
- Clean install, upgrade, long-duration, and supported-hardware matrix
- Linux and macOS package, network, hardware, and accessibility proof

No ambient microphone recording or playback was initiated without interactive
user consent.

## External and release blockers

- The scoped Claude plan, implementation, and final reviews completed through
  the real helper. The final review reports no open Critical, High, or Medium
  finding. Sensitive recordings, transcripts, vault data, credentials, and
  unrelated files were excluded from the review packets.
- The current-package Windows `-ValidateOnly` preflight passed and matched the
  current app, core, and archive identity, but it explicitly is not network
  proof and could not create firewall rules without elevation. The available
  non-admin live-proof attempt failed its administrator prerequisite and
  predates the current package. The admin-launcher receipt is also explicitly
  validate-only. No temporary firewall rule remains.
- Clean-source release checksum attestation and provenance are missing because
  the working tree is dirty. The hashes above identify this dirty-tree artifact
  exactly but are not clean-source release provenance.
- The SPDX SBOM exists and verifies, but the production SBOM gate correctly
  fails because there is no bundled speech model, language runtime, or language
  model.
- No release-ready default AI model or packaged real local-AI runtime proof is
  present.
- The Windows installer, app, core, and companions are unsigned.
- macOS DMG, signing and notarization, Linux AppImage and deb packages, and
  Linux package signing evidence are absent.
- Real hardware, real audio, real Whisper, elevated firewall, live traffic, and
  cross-platform proof remain missing.

## Residual findings and limitations

- **Medium:** Windows source reads are now bound to a natively opened and
  validated handle. The private staging destination still retains a narrow
  check-to-create or check-to-write race between validating its root and
  creating the temporary file. Exclusive creation, a user-only descriptor,
  delete-on-close, digest verification, and repeated locality checks reduce the
  risk. Full elimination needs handle-relative native destination creation and
  post-open destination identity verification.
- **Low:** A few small selection, deletion, and media acknowledgement responses
  are generic, while still bounded, schema-validated, and custody-enforced.
- **Low:** Read-only automation is bounded and reports `sourceTruncated` and
  `totalCountExact`, but it is not a transactional filesystem snapshot and does
  not claim to detect every same-length concurrent manifest rewrite. A
  concurrent same-user rewrite can yield a partial or internally inconsistent
  read without creating a write or exposing a raw path.
- **Platform limitation:** Production non-Windows media import is disabled
  because the current implementation cannot prove local filesystem ownership
  there without accepting remote mounts.
- **Platform limitation:** Diarization has complete policy and evidence gates
  but no selected, reviewed, redistributable engine and model.

## Local AI handoff final verification, 2026-07-21

### Final successful commands

- `npm run v3:verify`: passed after Claude-triggered fixes. Final aggregate
  counts were 31 Rust library tests, 353 Rust core tests, and 482 Vitest tests.
  M0 through M5, SQLCipher, durable capture and recovery, source security,
  updater policy, renderer typecheck, Electron build, model manager, local AI,
  and importer proofs passed. Proof:
  `release-v3/proofs/v3-local-verification-win32-x64.json`.
- `npm run test:electron`: 12 of 12 passed in 185.9 seconds. This covered the
  exact preload surface, six-step setup persistence and migration, 200 percent
  setup scaling, keyboard and axe checks, second-instance shortcut behavior,
  dark theme, licensing formatting, and the GUI evidence matrix.
- `npm run audit:source`: 214 checks and 37 mutation tests passed.
- `npm run electron:v3:typecheck-renderer`: passed.
- `npm run electron:v3:build-main`: passed.
- Focused model acquisition/catalog Vitest after review: 2 files and 7 tests
  passed.
- Focused cleanup lineage and recap receipt Rust tests after review: 2 passed.
- Focused original/cleaned stale-search regression: passed.
- `cargo fmt --manifest-path crates/candor-core/Cargo.toml --check`: passed at
  the final formatted state.
- `git diff --check`: passed with line-ending conversion warnings only before
  the final documentation update.

### Failures found and corrected

- The first `m3:verify` run found `electron/main.ts` at 252 lines against the
  250-line responsibility target. A multiline import was compacted and the
  rerun passed.
- The first source audit rejected the new Node HTTPS import because the old
  policy denied all Electron network modules. The exception is now limited to
  the exact verified model-acquisition broker, raw network/browser transports
  remain denied, and a raw-TLS mutation proves the exception cannot broaden.
- The first full Electron run found four new bounded preload methods missing
  from the exact-surface assertion and a visual fixture crash caused by missing
  model-catalog props. Both proof fixtures were updated. A later run found dark
  model-card contrast failures; the dark-theme labels and status colors were
  corrected. The final 12-test suite passed.
- The first aggregate verification found one inaccurate legacy-schema fixture
  and two old `transcriptText` assertions. The fixture now removes schema-5-only
  fields when simulating schema 3, and original rows assert the explicit
  `originalTranscriptText` label. Focused tests and two aggregate reruns passed.
- Claude found that an absent HTTP `Content-Length` was treated as the catalog
  size. The broker now fails closed and aborts staging before any chunk. Claude
  also found two silent cleanup-lineage defaults; both now require an explicit
  boolean and fail before response or receipt publication. Focused tests and a
  real final Claude review confirmed the fixes.
- One full Rust run executed concurrently with Electron, audit, and build load
  exceeded a 50 ms detach timing assertion. The exact test passed in isolation,
  and the serial final aggregate run passed all 353 core tests. The overloaded
  parallel attempt is not counted as successful evidence.

### Claude review proof

- `claude-implementation-review.md`: real invocation, no Critical or High
  findings, one Medium and two Low findings or notes.
- `claude-review-reconciliation.md`: every finding disposition recorded; the
  Medium and one Low were fixed, the bounded Parakeet boundary decision was
  retained intentionally.
- `claude-final-review.md`: real invocation, no confirmed findings and no open
  Critical, High, or Medium issue.

### Honest remaining limitations

- Superseded on 2026-07-21 by the Parakeet availability correction below:
  Parakeet is now a pinned verified download and a real local final-transcription
  engine. The model remains an explicit user download and is not bundled.
- The local Qwen preflight reports `ready=false` on this machine because the
  verified runtime/model assets are not installed. The schema, fixture,
  scheduling, grounding, fallback, and lineage paths passed.
- Real built-in, USB, Bluetooth, disconnected, privacy-blocked, lock/unlock,
  and sleep/resume hardware checks still require supported interactive hardware.
- Clean-source provenance, production signing, installer redistribution, live
  elevated firewall/traffic proof, and cross-platform package proof remain
  release blockers and are not claimed by this implementation verification.

## Parakeet availability correction verification, 2026-07-21

### Implemented outcome

- `parakeet-tdt-0.6b-v3-int8` is `ready`, has a fixed HTTPS source, exact outer
  bytes and SHA-256, and is downloadable only by explicit user action.
- The core verifies every installed member and commits a staged package only
  after verification. Verified Parakeet is selectable for final transcription
  and becomes the recommended default for unpinned state and new custom
  profiles. Existing profiles remain unchanged.
- Final transcription dispatches to local sherpa-onnx 1.13.4 CPU inference.
  Live provisional captions use a language-appropriate Whisper Small fallback.

### Real artifact and inference proof

- Model archive: `487170055` bytes, SHA-256
  `5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf`.
- Windows x64 static `/MT` runtime archive: `119847445` bytes, SHA-256
  `d81bd1d25112540862d2387072e76b2b6843ef962918d6b5c7db5a19c6276b4c`.
- The ignored hardware-sized proof test installed the official package through
  the production parser, loaded the native CPU recognizer, and transcribed the
  official English WAV as:
  `Ask not what your country can do for you, ask what you can do for your country.`

### Successful verification

- `npm test`: final post-review run passed 82 files and 484 tests.
- `npm run electron:v3:typecheck-renderer`: passed.
- `npm run electron:v3:build-main`: passed.
- `npm run core:v3:build`: passed with
  `sqlcipher-vault,local-whisper,local-parakeet`.
- Rust local-Whisper suite: 397 tests passed.
- Combined local-Whisper and local-Parakeet check and native link: passed.
- `npm run m1:verify`, `npm run m2:verify`, and `npm run m3:verify`: passed.
- `npm run test:electron`: 12 tests passed.
- `npm run audit:source`: 214 checks and 37 mutation tests passed.
- `node scripts/v3-release-sbom.mjs`: passed with Parakeet model and runtime
  entries.
- `npm run v3:verify`: passed and wrote
  `release-v3/proofs/v3-local-verification-win32-x64.json`.
- Post-Claude hardening:
  `node scripts/cargo-with-local-perl.mjs test --manifest-path crates/candor-core/Cargo.toml parakeet_package --features local-whisper`
  passed 5 package tests;
  `npm test -- electron/models/model-acquisition-service.test.ts` passed 6
  acquisition tests; `npm run electron:v3:build-main` passed. The final
  `npm run core:v3:build` passed the combined
  `sqlcipher-vault,local-whisper,local-parakeet` build, and the final
  `npm run audit:source` passed 214 checks and 37 mutation tests.

### Claude gate

- `claude-parakeet-implementation-review.md`: real invocation, no Critical or
  High finding, two Low findings, and two informational observations.
- `claude-parakeet-review-reconciliation.md`: every finding has a disposition.
  The extracted-byte hardening and final-chunk cancellation check were fixed and
  retested. The other two findings are bounded and do not weaken verification.

### Remaining release evidence

- Production installer publication and signing were not performed in this
  correction.
- Broader language, timestamp, silence, long-audio, accuracy, cold-start,
  peak-memory, and minimum-hardware benchmarks remain to be collected.
