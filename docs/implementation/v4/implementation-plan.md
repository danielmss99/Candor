# Candor V4 Accepted Implementation Plan

Status: active

Baseline revision: `b29061334cff9c52654ad0f0528fee179151ed47`

Branch: `codex/electron-consolidation`

## Mission Alignment

V4 is the active consolidation subgoal under the unfinished Candor mission. It
does not replace the original local-first objective. It narrows the next work to
making the existing Electron/Rust application the only active architecture,
then improving maintainability, fault handling, data safety, and release proof
without adding cloud services or changing user data formats casually.

The goal service could not replace the prior goal because that mission is still
unfinished. The old goal therefore remains the governing constraint and this
file is the explicit V4 subgoal record.

## Completion Definition

V4 is complete only when:

- Electron and the Rust core are the sole active architecture on `main`;
- root commands, docs, CI, security audits, and packaging agree;
- `electron/main.ts` and `v3/renderer/src/CandorApp.tsx` are composition roots at
  or below 250 lines, unless a documented final review proves a slightly larger
  file has one coherent responsibility;
- the renderer has an exact typed preload surface and runtime-validated protocol;
- core and capture failures are explicit, recoverable, and capture-aware;
- the normal workflow makes Record, Review, and Export obvious;
- technical controls remain available without dominating normal use;
- existing data survives migrations, failures, and license states;
- conventional unit, renderer, Electron, Rust, and accessibility tests complement
  proof scripts;
- a signed Windows prerelease passes clean-machine installation and upgrade;
- real capture, long-recording, sleep/resume, and device-switch evidence is
  recorded rather than inferred.

## Claude Review Disposition

Source: `docs/implementation/v4/claude-plan-review.md`

### Accepted Findings

1. Replace Tauri-dependent security and release audits before deleting Tauri
   source. This avoids both a hard PowerShell failure and a vacuous green JSON
   proof.
2. Split Phase 1 into root-command, audit, deletion, and documentation commits.
3. Archive Tauri with the immutable `archive/tauri-v2` tag and remove it from the
   active tree. Do not keep a second buildable copy under `legacy/`.
4. Fix the current `recording.durable.status` allowlist mismatch during the
   protocol/preload work.
5. Prove or block restart during active capture before extracting the core
   supervisor. The Rust `core.shutdown` handler currently exits immediately and
   does not consult capture state.
6. Extract production dependencies before the smoke harness, then dynamically
   import the harness only in smoke mode.
7. Use `crypto.randomUUID()` for collision-resistant, non-predictable request
   IDs. Do not add signing, HMAC, or key management to local stdio RPC.
8. Introduce request IDs compatibly, then make them mandatory with a protocol
   version bump in a later buildable commit.
9. Extract startup loading before the largest renderer feature because startup
   currently has the broadest unisolated failure surface.
10. Audit and strengthen smoke selectors before changing navigation or screen
    structure.
11. Add migration, rollback, quarantine, and interrupted-write tests before any
    persistence migration implementation.
12. Add method-specific WAV/export timeouts and bounded core stderr handling.

### Adjusted Findings

- Claude called Playwright optional. V4 retains it as a Phase 7 requirement
  because the user explicitly requested Electron integration coverage. The
  existing packaged smoke remains authoritative for native packaging and visual
  proof; Playwright complements rather than replaces it.
- Claude called Advanced Settings reorganization cosmetic. V4 retains it as a
  product requirement, but model setup may move only after onboarding and error
  recovery retain a direct path for users who need a local model.
- Claude suggested a temporary main-process target of 350 lines. The plan allows
  intermediate extraction commits above 250 lines, but the final V4 target stays
  at 250.

### Rejected Suggestions

- None of Claude's observed defects were rejected after source validation.
- A `legacy/tauri-v2` directory is rejected in favor of a tag because it would
  preserve accidental dependency and audit ambiguity in the active tree.
- Cryptographic request signing is rejected. UUID4 correlation and exact response
  matching satisfy this local transport threat model without new secrets.

## Review Gates

Claude is used at high-risk boundaries, not for mechanical moves:

1. **Plan gate:** complete. Review is recorded and reconciled here.
2. **Electron-authority gate:** after Phase 1, independently verify that Tauri is
   absent, Electron/Rust audits are substantive, runtime data paths are unchanged,
   and the v2 importer remains.
3. **Process/protocol gate:** after Phases 2 and 3, adversarially review lifecycle,
   validators, timeouts, duplicate IDs, logging, capture-aware restart, and exact
   preload operations.
4. **Renderer/GUI gate:** after Phases 4 and 5, review startup partial failure,
   stale requests, capture transitions, accessibility, smoke selectors, compact
   layouts, and license-independent data access.
5. **Data-safety gate:** after Phase 6, review migration SQL, pre-write backups,
   rollback, quarantine, disk-full handling, and v2 importer isolation.
6. **Release gate:** before completion, compare implementation to this plan,
   inspect strict proofs, and identify remaining security or test gaps.

Claude output is review input. Codex validates each finding against source,
implements accepted fixes, and reruns repository verification.

## Phase 0: Baseline

### Commit

`chore: capture Electron v4 baseline`

### Work

- Record SHA, measurements, active Tauri references, strengths, and risks.
- Run `npm ci`, tests, typecheck, Rust build, and full staged verification.
- Record the plan request, Claude review, accepted plan, and verification log.

### Acceptance

- Baseline is reproducible and green.
- Current defects and unresolved manual gates are explicit.

## Phase 1: Electron Is Authoritative

### P1a: Root Commands And Dependencies

Commit: `chore: make Electron v4 the default build`

- Make `dev`, `build`, `start`, `dist`, and `preview` Electron v3 operations.
- Add a repository-owned Electron/Vite development launcher rather than relying
  on a legacy root Vite entry.
- Remove Tauri package scripts and Tauri npm dependencies.
- Remove obsolete Store aliases rather than implying an Electron Store package
  exists.
- Confirm no active Electron/Rust source imports Tauri before dependency removal.

Acceptance:

- `npm ci`, `npm run build`, and root Electron startup/build commands pass.
- Tauri npm packages are absent from lockfile and `node_modules` dependency tree.
- Every commit remains buildable before legacy source deletion.

### P1b: Replace Tauri-Specific Audits

Commit: `security: make source audits Electron authoritative`

- Rewrite `audit-source-security.ps1` around Electron window flags, preload
  surface, blocked external opening, secret scanning, and Rust path/secret rules.
- Rewrite `v3-source-security-proof.mjs` so every check names an existing
  Electron/Rust source and fails if required sources are absent.
- Remove the Tauri target fallback from release artifact auditing.
- Add tests that prove the source checks fail when a required Electron security
  switch or source file is missing.

Acceptance:

- Source audit and machine-readable proof pass while Tauri still exists.
- No check can pass because a source file disappeared.

### P1c: Archive And Remove Tauri

Commit: `chore: archive legacy Tauri application`

- Create and publish `archive/tauri-v2` at the last Tauri-active revision.
- Delete `src-tauri/`, legacy root `src/`, Tauri scripts/configs/icon, and the
  Tauri workflow from the active tree.
- Preserve `crates/candor-core/src/v2_importer.rs`, runtime vault paths, and all
  user data behavior.
- Update CI contract checks for the Electron-only workflow set.

Acceptance:

- No tracked Tauri source or active workflow remains.
- Only explicit archive/migration prose may mention Tauri.
- Full staged verification and Electron CI pass.

### P1d: Documentation

Commit: `docs: make Electron Rust architecture authoritative`

- Rewrite root README.
- Add root `ARCHITECTURE.md` with trust boundaries, commands, data ownership,
  network policy, archive tag, and proof paths.
- Change product window title from `Candor v3 M0` to `Candor` only after updating
  every package/proof path that depends on the current executable name.

## Phase 2: Main Process And Core Lifecycle

### Extraction Order

1. `electron/core/protocol.ts` and structured errors.
2. `electron/core/request-registry.ts`.
3. `electron/core/core-process.ts` and capture-aware lifecycle.
4. `electron/security/network-policy.ts` and sender/input checks.
5. `electron/window/create-main-window.ts` and navigation policy.
6. Domain IPC modules.
7. Export/model/import file-dialog handlers.
8. `electron/smoke/smoke-harness.ts`, dynamically imported in smoke mode.
9. App lifecycle composition root.

Required behavior:

- explicit NotStarted/Starting/Ready/Busy/Disconnected/Recovering/Failed states;
- bounded stderr and maximum JSONL line handling;
- startup timeout and retry budget;
- no blind restart during capture, finalization, import, migration, or export;
- structured renderer-facing errors with no raw panic or sensitive paths;
- method-specific timeouts including long WAV/report export;
- `electron/main.ts` final target at or below 250 lines.

## Phase 3: Versioned Protocol And Exact Preload

### Compatibility Sequence

1. Add optional UUID4 `requestId` echo support in Rust and Electron.
2. Add duplicate-ID tracking and exact response matching.
3. Add request/success/failure runtime schemas and input limits.
4. Add JSON Schema contracts under `crates/candor-core/schemas/` with Rust and
   TypeScript fixture validation tests.
5. Replace generic renderer `call(method, params)` with exact product methods and
   typed event subscription.
6. Make request IDs mandatory and bump the protocol version.
7. Add protocol mismatch recovery UI.

Acceptance:

- no generic command, filesystem, process, path, executable, or IPC bridge;
- malformed, oversized, duplicate, unknown, timed-out, and mismatched responses
  fail visibly and deterministically;
- `recording.durable.status` is either exposed through the exact capture API or
  removed from the renderer allowlist deliberately;
- renderer declarations match the exact preload surface.

## Phase 4: Renderer Modules

### Extraction Order

1. App providers, typed navigation, and startup loader with partial-failure
   isolation using targeted critical loads plus `Promise.allSettled` diagnostics.
2. Capture reducer/state machine and capture recovery gate.
3. Meetings/library selection, pagination, and stale-response protection.
4. Transcript and notes autosave/conflict handling.
5. Review and export jobs.
6. Normal and Advanced settings.
7. Local AI, privacy, licensing, and onboarding ownership boundaries.
8. Reduce `CandorApp.tsx` to composition only.

Acceptance:

- features own components, hooks, API wrappers, types, tests, and state;
- startup diagnostics cannot block the meeting library;
- stale requests cannot mutate a newly selected recording;
- capture lifecycle prevents duplicate starts/stops and premature Saved status;
- license failure never blocks opening, exporting, or deleting existing data.

## Phase 5: Focused GUI

- Audit smoke DOM selectors before changing navigation.
- Make Home, Meetings, and Settings the normal sidebar.
- Keep Record as the persistent primary action.
- Make Live Meeting prioritize recording state, elapsed time, sources,
  transcript, notes, and Stop.
- Use Summary/Transcript/Notes for completed meetings.
- Use outline/editor/preview for Review with one compact panel active at a time.
- Keep PDF/Word/Markdown defaults visible; move advanced export controls under
  Options.
- Move technical diagnostics to Advanced only after onboarding and recovery
  retain direct setup paths.
- Add loading, empty, partial, permission, low-disk, disk-full, disconnected,
  incompatible, restarting, and capture-recovery states.
- Verify 1366x768 and 125/150 percent scaling, keyboard use, focus, reduced
  motion, and high contrast.

## Phase 6: Reliability And Data Protection

### Tests Before Migration Code

- migration idempotence;
- pre-migration backup byte equality;
- rollback restores schema and rows;
- corrupt record quarantine preserves the rest of the library;
- interrupted/disk-full chunk write becomes a recoverable incomplete capture.

### Implementation

- startup capture recovery gate;
- close guard for starting/recording/stopping/finalizing;
- low-disk and disk-full behavior;
- cancellable transcription, model, recap, import, and export jobs;
- inspectable diagnostic export excluding user content and secrets;
- transactional migrations, backup retention through a successful next launch,
  rollback, unknown-future-schema handling, and quarantine;
- explicit license-independent existing-data tests.

## Phase 7: Release Hardening

- Add Playwright Electron tests for launch, exact preload, no Node globals,
  navigation/popup blocking, malformed core output, timeout, restart, renderer
  reload, recovery, and close warning.
- Add renderer integration and axe coverage for primary screens and states.
- Keep packaged smoke for native runtime, visual, icon, export, and network proof.
- Run strict source, dependency, artifact, signing, goal, and readiness audits.
- Document manual proof procedures for fresh-machine install/upgrade, real
  hardware capture, 5/30/60/180-minute recording, sleep/resume, device switching,
  signing, checksums, and notarization.

## Stop Rules

Stop and report rather than guessing when:

- a migration or rollback invariant cannot be proven;
- a source deletion would reduce audit coverage;
- a restart path can interrupt capture without deterministic recovery;
- a signing, notarization, hardware, or clean-machine claim lacks real evidence;
- an implementation would expose a generic renderer capability;
- an implementation changes persisted formats without compatibility tests;
- Claude proposes a material scope expansion outside this plan.
