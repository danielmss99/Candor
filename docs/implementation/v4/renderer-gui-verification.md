# V4 Renderer And GUI Verification

Tracked before/after workspace captures are available in
[`screenshots/README.md`](screenshots/README.md).

Date: 2026-07-13

Status: passed for the implemented Phase 4 and Phase 5 scope

## Implemented Boundary

- `v3/renderer/src/CandorApp.tsx` is a one-line compatibility export.
- `v3/renderer/src/app/CandorApp.tsx` is a 10-line composition root.
- `v3/renderer/src/app/CandorWorkspace.tsx` is 179 lines.
- `electron/main.ts` is 126 lines.
- Renderer state is split across startup, meetings, capture, jobs, licensing,
  local AI, review/export, onboarding/settings, and notes modules.
- Typed `AppRoute` state owns navigation.
- Critical startup facts load before independent diagnostics, which use
  `Promise.allSettled` and cannot block the local meeting library.
- Existing meetings open without activation. License state cannot block opening,
  reviewing, exporting, or deleting existing local data.
- Normal navigation is Home, Meetings, and Settings. Record is the persistent
  primary action. Export is reached through Review rather than a competing
  top-level destination.
- Model, vault, transport, network, and proof details are under Advanced
  Settings.

## Claude Review Gate

The first broad renderer review request exceeded the external CLI timeout and
produced no review. It is not counted as evidence.

The focused request in `claude-phase4-focused-review-request.md` produced
`claude-phase4-focused-review.md` with a verdict of **Go with required fixes**.

| Finding | Disposition |
|---|---|
| Concurrent edits could be marked clean after an asynchronous note save | Accepted. `NotesDraftTracker` now uses recording ID and revision snapshots. Only the exact saved revision can become clean. |
| A save for Meeting A could complete after Meeting B was selected | Accepted. Cross-meeting completion returns `different-recording` before changing status or dirty state. |
| Review accept/reject state persisted across meetings | Accepted. Review state uses a reducer and resets on recording ID change. |
| The onboarding effect depended on state it mutated | Accepted. It now uses a functional state update and no self-mutating dependency. |

The focused fix review in `claude-phase4-fix-review.md` returned **Go**. It
confirmed every required fix and found no remaining Critical, High, or required
Medium defect in the reviewed renderer safety surface.

## Automated Verification

| Check | Result |
|---|---|
| `npm run v3:verify` | passed in 71.7 seconds |
| Rust core tests | 66 passed |
| Vitest | 29 files and 86 tests passed |
| renderer typecheck and production build | passed |
| M0 through M5 staged smoke suites | passed |
| Electron hardening audit | passed |
| unpacked Windows production package | passed |
| packaged runtime smoke | passed twice after harness alignment |

The packaged smoke proves:

- existing local data opens while the license is inactive;
- activation and first-run setup do not cover existing recordings;
- the exact preload surface is sandboxed and pathless;
- renderer and session network requests are denied;
- external navigation and popups are denied;
- the Rust sidecar handshakes and restarts under supervision;
- native editable Word and searchable PDF reports are generated locally;
- Home, Meetings, Meeting, Review, Export, Settings, and Advanced Settings are
  reachable through the V4 workflow;
- local notifications can be triggered and dismissed;
- every captured screen is nonblank.

## Visual Verification

Reference viewport: 1440 by 900 logical pixels on Windows.

Stable packaged proof:

`release-v3/proofs/m0-packaged-runtime-smoke-v4-after-recheck-win32-x64.json`

Screenshots:

- `m3-product-surface-v4-after-recheck-win32-x64-local-data-access.png`
- `m3-product-surface-v4-after-recheck-win32-x64-home.png`
- `m3-product-surface-v4-after-recheck-win32-x64-library.png`
- `m3-product-surface-v4-after-recheck-win32-x64-detail.png`
- `m3-product-surface-v4-after-recheck-win32-x64-review.png`
- `m3-product-surface-v4-after-recheck-win32-x64-export.png`
- `m3-product-surface-v4-after-recheck-win32-x64-settings.png`
- `m3-product-surface-v4-after-recheck-win32-x64-advanced.png`

The visual inspection found no clipping, overlap, blank canvas, remote image,
or brand-token drift at the reference viewport. A first Meetings capture briefly
showed a stale count during navigation; a complete second packaged run settled
to `Showing 1 of 1` and passed with identical runtime assertions.

## Remaining Scope

This gate does not claim V4 completion. Still required are the Phase 6 data
safety and reliability gate, Playwright and axe coverage, compact and scaled
viewport evidence, real long-duration capture, sleep/resume and device switching,
clean-machine installation and upgrade, and production signing evidence.
