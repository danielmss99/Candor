# Claude Phase 6 Implementation Review Request

## Role

Act as an adversarial reviewer for Candor V4 Phase 6. Do not edit the repository. Review the implementation and report observed defects, not general preferences.

## Repository state

- Repository: `C:\Claude_Config\candor-v3-m0`
- Branch: `codex/electron-consolidation`
- Review range: `7d4e3b1..def10f5`
- Design review: `docs/implementation/v4/claude-phase6-data-safety-plan-review.md`
- Reconciliation: `docs/implementation/v4/phase6-design-reconciliation.md`

Inspect the real files and diff in the repository. The review range includes these Phase 6 implementation commits:

```text
677bf1d feat(storage): add data-safe SQLCipher migrations
9db6191 chore(core): clean feature-gated vault branches
750ff1d feat(recovery): quarantine incompatible recordings
dc80724 feat(storage): guard recording disk headroom
f5f8ed8 feat(recordings): add confirmed permanent deletion
def10f5 feat(recovery): surface persistent local failures
```

## Product invariants

1. Existing recordings always open, export, and delete regardless of license state.
2. No user data is deleted or modified because a manifest or future schema cannot be understood.
3. Failed or interrupted migrations preserve the original vault and a verified encrypted backup.
4. A recording is never reported as saved before durable finalization.
5. Disk pressure blocks unsafe writes and remains visible without blocking access to existing meetings.
6. Renderer code receives no raw paths, keys, generic filesystem authority, generic process authority, or private core methods.
7. Deletion is explicit, confirmed, permanent, retryable, and does not claim completion early.
8. Privacy claims must come from measured core facts.

## Implementation areas

### SQLCipher migration

Inspect `crates/candor-core/src/sqlcipher_vault.rs` and related tests for:

- future-schema immutability;
- transaction and lock boundaries;
- WAL consistency;
- encrypted backup verification and atomic promotion;
- rollback after injected failure;
- invariant verification;
- backup retention until a different successful launch;
- path or secret leakage in receipts and errors.

Evidence: `docs/implementation/v4/phase6-vault-migration-verification.md`.

### Manifest quarantine and recovery

Inspect `crates/candor-core/src/recording_store.rs` for:

- schema detection before typed parsing;
- future manifests left byte-for-byte untouched;
- safe rebuild conditions for supported corrupt manifests;
- quarantine isolation during list, search, and recovery;
- pathless receipts;
- accidental fallback from a future manifest to older backup/chunk data.

Evidence: `docs/implementation/v4/phase6-manifest-quarantine-verification.md`.

### Disk pressure and durable writes

Inspect free-space checks, write ordering, partial-file cleanup, and capture writer error handling for:

- fail-closed unavailable checks;
- new-capture threshold and active-capture reserve behavior;
- payload plus metadata headroom;
- preserving committed manifest state when a new write fails;
- avoiding a false finished or saved state after write failure.

Evidence: `docs/implementation/v4/phase6-storage-pressure-verification.md`.

### Permanent deletion

Inspect Rust deletion, private Electron IPC, preload exposure, confirmation dialog, and renderer actions for:

- exact recording ID handling;
- finished-only policy;
- same-volume rename into a tombstone;
- synced intent and deterministic startup retry;
- partial failure behavior;
- SQLCipher index cleanup ordering;
- license independence;
- inability for a compromised renderer to invoke arbitrary core or filesystem operations;
- UI claims that match actual completion.

Evidence: `docs/implementation/v4/phase6-permanent-deletion-verification.md`.

### Recovery and storage UI

Inspect:

- `v3/renderer/src/features/recovery/system-alerts.ts`
- `v3/renderer/src/features/startup/useRuntimeStatus.ts`
- `v3/renderer/src/features/capture/useCaptureActions.ts`
- `v3/renderer/src/app/AppRouteOutlet.tsx`
- `v3/renderer/src/components/DesktopShell.tsx`

Verify that active write failures become persistent, new recording starts are blocked when measured storage is unsafe, active capture can still stop, existing meeting access stays available, and runtime response validation fails visibly rather than coercing critical values.

Evidence: `docs/implementation/v4/phase6-renderer-recovery-verification.md`.

## Verification already completed

```text
Rust default tests: 81 passed
Rust sqlcipher-vault tests: 96 passed
npm test -- --run: 33 files, 99 tests passed
npm run electron:v3:typecheck-renderer: passed
npm run m3:product-surface-smoke: passed
npm run electron:v3:pack: passed
npm run m0:packaged-smoke: passed on Windows x64
node scripts/m0-audit-electron.mjs: passed
source security audit: 114 checks and 7 mutation tests passed
M1 durable recording, crash recovery, capture service, and capture crash smokes: passed
```

Do not treat these as proof that the implementation is correct. Identify missing or invalid test assumptions.

## Known limitations

- Physical disk exhaustion during real audio capture is not yet tested.
- Long physical recordings and sleep/resume are not yet tested.
- macOS and Linux packaged builds are not proven in this Windows workspace.
- True cancellation of currently synchronous transcription and local LLM work is not claimed.
- Forced OS termination remains recoverable through durable chunks, not preventable by the close guard.
- Signing and clean-machine release proof remain Phase 7 work.

## Required response format

1. Verdict: `GO`, `GO WITH REQUIRED FIXES`, or `NO-GO`.
2. Findings first, ordered Critical, High, Medium, Low.
3. Every finding must include severity, file and line, evidence, user impact, and a concrete fix.
4. Distinguish observed defects from optional improvements.
5. Explicitly assess data-loss risk, downgrade safety, deletion recovery, trust-boundary exposure, license data access, storage-state truthfulness, and test gaps.
6. List any design-review requirement that the implementation missed or contradicted.
7. End with the smallest required fix set and exact re-review scope.

Do not recommend cloud features, Tauri, schema-format replacement, or unrelated product expansion.
