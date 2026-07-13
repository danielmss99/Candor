# Claude Independent Plan Review Request: Candor V4

You are reviewing an implementation plan for a local-first Electron desktop
meeting recorder. Be adversarial and evidence-driven. Do not edit the repository.
Codex remains responsible for implementation and verification.

## Objective

Consolidate Candor so Electron plus the Rust core is the sole active architecture,
then modularize and harden the process boundary and renderer while preserving all
existing data, local custody behavior, capture durability, exports, licensing
access rules, and the approved brand.

The required normal workflow is:

```text
Record -> Review -> Export
```

Completion is not a source-only claim. It ultimately requires a signed Windows
prerelease, clean install and upgrade proof, data migration/rollback proof, real
capture and long-recording proof, and green cross-platform security/release
checks.

## Repository Evidence

- Baseline revision: `b29061334cff9c52654ad0f0528fee179151ed47`
- Baseline document:
  `docs/implementation/v4/electron-consolidation-baseline.md`
- Active roots: `electron/`, `v3/renderer/`, `crates/candor-core/`
- Active packaging: `electron-builder.v3.yml`
- `electron/main.ts`: 1,763 lines
- `v3/renderer/src/CandorApp.tsx`: 1,372 lines and more than 80 local state values
- Existing baseline: 62 Rust tests, 29 frontend tests, full `npm run v3:verify`
  pass
- Root package commands, dependencies, README, `src/`, `src-tauri/`, one CI
  workflow, and three audit scripts still actively reference Tauri
- Existing Rust `v2_importer` must remain because it protects access to legacy
  user recordings; deleting Tauri source does not authorize deleting or changing
  user data

## Non-Negotiable Constraints

1. Never delete or rewrite user data without a versioned migration, backup,
   invariant verification, and rollback path.
2. Existing recordings always open, export, and delete regardless of license or
   network state.
3. Keep `contextIsolation`, sandboxing, Node disablement, blocked navigation,
   blocked popups, and explicit preload operations.
4. No generic IPC, filesystem, process, path, executable, or command-line bridge.
5. No cloud transcription, cloud AI, account requirement, behavioral analytics,
   or undisclosed background network behavior.
6. Privacy wording must derive from measured core/application state.
7. Every implementation commit must build and have proportionate tests.
8. The approved Keep Tab brand and warm tokens remain authoritative.
9. Calendar integration is out of scope.
10. Windows is first release target, but cross-platform architecture and CI must
    remain intact.

## Proposed Phase Order

### Phase 0: Baseline

Record SHA, code measurements, legacy references, and the passing verification
set. This is complete in the baseline document.

### Phase 1: Electron Authoritative

- Make root `dev`, `build`, `dist`, and `start` use Electron v3.
- Remove active Tauri dependencies, scripts, and workflow.
- Archive Tauri source on a Git tag/branch, then remove `src-tauri/`, legacy root
  `src/`, Tauri helper scripts/configs, and the legacy public icon from active
  `main`.
- Rewrite README and add root `ARCHITECTURE.md`.
- Replace Tauri-specific security/release checks with Electron/Rust checks before
  deleting the sources they currently inspect.
- Preserve the Rust v2 importer and all runtime data locations.

### Phase 2: Main Process And Core Lifecycle

- Extract window/security policy, app lifecycle, smoke harness, licensing, core
  process, request registry, protocol, and domain IPC modules.
- Keep `electron/main.ts` at or below 250 lines.
- Add explicit lifecycle states, bounded stderr, timeout and hang handling,
  version/schema/capability handshake, structured errors, and capture-aware
  restart policy.

### Phase 3: Protocol And Preload

- Add versioned request/success/failure envelopes with cryptographically strong
  request IDs.
- Add runtime request and response validators, input limits, duplicate rejection,
  one-response enforcement, method-specific timeouts, and protocol mismatch UI.
- Replace the generic renderer `call(method, params)` surface with exact product
  operations and typed events.
- Generate or contract-test TypeScript types against Rust schemas.

### Phase 4: Renderer Modules

- Turn `CandorApp.tsx` into a composition root at or below 250 lines.
- Add typed navigation and feature ownership for onboarding, capture, meetings,
  transcript, notes, review, export, settings, privacy, local AI, and licensing.
- Add targeted startup loading and independent background diagnostics.
- Preserve stale-request guards and license-independent existing-data access.

### Phase 5: Focused GUI

- Make Record, Meetings, and Settings the normal navigation, with Record as a
  persistent primary action.
- Make Record -> Review -> Export visually dominant.
- Move models, runner, hashes, vault internals, network policy, imports, and proof
  export under Advanced Settings.
- Add complete loading, empty, partial, permission, low-disk, disk-full,
  disconnected, incompatible, restarting, and recovery states.
- Validate keyboard use, focus, compact 1366x768, and 125/150 percent scaling.

### Phase 6: Data And Reliability

- Add capture recovery startup gate, close guard, disk handling, cancellations,
  diagnostic export, migration backup/rollback, corrupt-record quarantine, and
  explicit license data-access tests.

### Phase 7: Release Hardening

- Add Playwright Electron, renderer integration, axe, keyboard, and Rust failure
  tests.
- Prove clean install, upgrade, 5/30/60/180-minute recording, sleep/resume,
  device switching, signed prerelease, and checksums.

## Proposed Claude Review Gates

Claude should be used where an independent review can catch a high-impact defect,
not for every mechanical file move:

1. **Plan gate now:** phase order, hidden dependencies, data/CI hazards, and
   acceptance criteria.
2. **After Phase 1:** verify Tauri retirement did not remove security coverage,
   importer behavior, release commands, or cross-platform CI.
3. **After Phases 2 and 3:** adversarial security/protocol review of process
   lifecycle, validators, timeouts, logging, restart policy, and preload surface.
4. **After Phases 4 and 5:** state/race/accessibility review of capture, targeted
   loading, navigation, normal/advanced information architecture, and compact UI.
5. **After Phase 6:** data-loss and licensing review of migration, backup,
   rollback, quarantine, disk-full, recovery, and existing-data access.
6. **Before release completion:** final deviation, threat-model, test-gap, and
   proof-quality review.

## Questions For Claude

1. Is the proposed order safe and incrementally buildable? Identify any phase
   dependency that would force broken intermediate commits.
2. Should Tauri be removed directly after tagging, or temporarily moved under
   `legacy/tauri-v2`? Evaluate repository size, audit clarity, and accidental
   compilation risk.
3. Which Tauri security checks must be replaced before source deletion, and what
   Electron/Rust checks should replace them?
4. How should the current smoke harness be extracted from `electron/main.ts`
   without weakening packaged proof coverage or bloating production startup?
5. What is the smallest safe versioned RPC increment that keeps old core and new
   shell commits compatible while the protocol is being migrated?
6. Where should schemas live so Rust and TypeScript cannot silently drift without
   adding a fragile build-time generator?
7. Which restart behaviors are unsafe during capture, finalization, migration, or
   export?
8. Which renderer feature should be extracted first to reduce race risk rather
   than simply reduce line count?
9. Which tests are required before touching persistence and which tests can wait
   until Phase 7?
10. Are any stated acceptance criteria unprovable or misleading with the current
    architecture?

## Required Response Format

Return:

1. A refined implementation plan with small, buildable commits.
2. Required changes versus optional improvements.
3. Assumptions and unresolved questions.
4. Likely failure modes, ranked by severity.
5. Tests and acceptance checks per phase.
6. Specific dispositions for all six proposed Claude review gates.
7. Any recommendation you reject from this request, with evidence and a safer
   replacement.

Do not agree for politeness. Distinguish observed defects from speculative risks.
