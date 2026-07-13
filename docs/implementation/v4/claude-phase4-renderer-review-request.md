# Claude Review Request: V4 Renderer and GUI Gate

## Role

Act as an adversarial senior reviewer. Do not edit the repository. Review the
implemented renderer refactor and GUI simplification for correctness,
regressions, security-boundary mistakes, accessibility gaps, and deviations
from the accepted Candor V4 plan.

Every finding must include:

- severity: Critical, High, Medium, or Low;
- file and line;
- observed evidence, not speculation presented as fact;
- user or system impact;
- a concrete, narrowly scoped fix;
- the verification that would prove the fix.

Separate required fixes from optional improvements. State uncertainty plainly.

## Governing product rules

- Candor is local first. Meeting content, audio, transcripts, notes, and AI
  processing stay on the device.
- The primary journey is `Record -> Review -> Export`.
- Existing meetings must remain openable, exportable, and deletable regardless
  of license state or optional network availability.
- The renderer is sandboxed and must use only the fixed preload API.
- Technical model, hash, vault, network, retention, and proof details belong in
  Advanced Settings.
- A recording must not be described as saved until durable finalization is
  confirmed by the Rust core.
- Normal navigation is Home, Meetings, and Settings. Record remains the
  persistent primary action.
- Meeting detail has Summary, Transcript, and Notes only.
- The warm cream, coral, charcoal, blue-focus, green-success, and red-recording
  token system remains authoritative.

## Review range

Review commits after process/protocol gate `90636ea` through `48043e4`.

Key files:

- `v3/renderer/src/app/CandorApp.tsx`
- `v3/renderer/src/app/CandorWorkspace.tsx`
- `v3/renderer/src/app/AppRouteOutlet.tsx`
- `v3/renderer/src/app/navigation.ts`
- `v3/renderer/src/components/DesktopShell.tsx`
- `v3/renderer/src/features/startup/useRuntimeStatus.ts`
- `v3/renderer/src/features/startup/useWorkspaceStartup.ts`
- `v3/renderer/src/features/startup/StartupState.tsx`
- `v3/renderer/src/features/meetings/useMeetingWorkspace.ts`
- `v3/renderer/src/features/meetings/useMeetingActions.ts`
- `v3/renderer/src/features/capture/useCaptureSession.ts`
- `v3/renderer/src/features/capture/useCaptureActions.ts`
- `v3/renderer/src/features/jobs/useOperationRunner.ts`
- `v3/renderer/src/features/local-ai/useLocalAiWorkspace.ts`
- `v3/renderer/src/features/export/useReportWorkflow.ts`
- `v3/renderer/src/features/licensing/access-policy.ts`
- `v3/renderer/src/features/licensing/useLicenseState.ts`
- `v3/renderer/src/features/onboarding/useOnboardingSettings.ts`
- `v3/renderer/src/features/detail/MeetingDetailView.tsx`
- `v3/renderer/src/features/settings/SettingsView.tsx`
- `v3/renderer/src/features/onboarding/ActivationFlow.tsx`
- `v3/renderer/src/styles.css`
- `scripts/m3-product-surface-smoke.mjs`

## Implemented changes

- Added the requested app composition root, AppShell, AppRouteOutlet, and typed
  AppRoute model.
- Reduced `CandorWorkspace.tsx` to 179 lines and kept both CandorApp entry
  points below 250 lines. The M3 proof now enforces the 250-line target.
- Separated critical startup from twelve independent background diagnostics
  using `Promise.allSettled`.
- Added explicit startup loading and core/protocol recovery views.
- Moved meeting selection, transcript paging, notes state, privacy receipt,
  search, audio replay, and stale-request guards into Meetings.
- Moved capture source selection, consent routing, start/stop, finalization, and
  post-save selection into Capture.
- The save notice now occurs only after a durable recording ID is returned,
  capture state reaches Saved, and the recording reloads.
- Moved model import, hash verification, transcription, local recap, Ask, and
  fallback mode into Local AI.
- Moved reviewed structured data and all Word/PDF/Markdown export parameters
  into one Report workflow.
- Enforced an access policy where existing data never shows an activation gate.
- Simplified sidebar and meeting-detail tabs; moved custody diagnostics into
  Advanced Settings.

## Verification already run

- `npm test -- --run`: 28 files, 82 tests passed.
- `npm run electron:v3:typecheck-renderer`: passed.
- `npm run electron:v3:build`: passed, including release Rust core, Electron
  main, renderer, and icon verification.
- `npm run m3:product-surface-smoke`: passed.
- `git diff --check`: passed.

The packaged Electron smoke and full `npm run v3:verify` will run after this
review gate and any validated fixes.

## Required review questions

1. Can any hook dependency or React Strict Mode behavior cause repeated license
   loads, duplicate capture actions, stale meeting writes, or state updates
   after unmount?
2. Can selecting meetings quickly allow an older transcript, notes payload,
   privacy receipt, or local AI result to overwrite the current meeting?
3. Can capture show Saved, clear capture state, or permit duplicate start/stop
   before durable finalization is actually confirmed?
4. Can inactive, expired, unavailable, or failed licensing prevent existing
   meetings from opening, exporting, or being deleted?
5. Does startup correctly distinguish critical vault/capture/library failures
   from optional diagnostic failures, including protocol mismatch?
6. Does typed navigation preserve the selected recording and prevent Review or
   Export without one?
7. Did the GUI simplification accidentally hide a necessary core workflow or
   leave technical concepts in normal use?
8. Are loading, empty, recovery, permission, low-disk, disk-full, and
   core-disconnected states sufficient at this phase? Identify only observed
   omissions.
9. Are keyboard semantics, focus behavior, labels, live regions, and compact
   layout behavior safe enough for the next accessibility gate?
10. Are the new responsibility boundaries genuine, or was complexity merely
    moved into another monolith?

## Output

End with one verdict:

- `GO`: no Critical or High defects and no required Medium fixes before the
  next reliability phase;
- `GO WITH REQUIRED FIXES`: list the blocking findings;
- `NO-GO`: state the exact unsafe condition.
