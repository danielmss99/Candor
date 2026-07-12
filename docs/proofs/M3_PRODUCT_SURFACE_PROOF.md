# M3 Product Surface Proof

Status: **implemented Figma-aligned desktop surface with packaged Windows visual proof**

## Purpose

M3 turns the walking skeleton into a desktop meeting workspace where transcript,
notes, evidence, capture state, review, and local export remain connected. The
surface follows the verified Candor Figma file while replacing cloud or public
sharing behavior with core-backed local custody facts.

## Design Source

- Figma file key: `wUT5Ai8170LZAmUqMfo2CI`
- Review Mode: `3:2`
- Dashboard: `6:2`
- Live Meeting: `6:83`
- Recording Library: `6:231`
- Meeting Detail and Summary: `6:317`
- Settings: `6:413`
- Export Flow: `6:494`
- Local tokens: `design/figma/token.json`
- Implementation rules: `design/figma/style-guide.md`

The Figma file did not expose variables, local styles, components, or component
sets through the inspected API. Repeated verified values were therefore
codified locally instead of claiming a formal Figma component library existed.

## Commands

```powershell
npm run m3:verify
$env:CANDOR_M0_SCREENSHOT_LABEL='gui-review'; npm run m0:packaged-smoke
$env:CANDOR_M0_SCREENSHOT_LABEL='gui-review-compact'; $env:CANDOR_M0_SMOKE_WIDTH='1080'; $env:CANDOR_M0_SMOKE_HEIGHT='720'; npm run m0:packaged-smoke
```

## Implemented Surface

- Desktop shell with a maximum of three visible meeting tabs, an overflow menu,
  Current meeting, Meetings, Exports, and Settings navigation, local-only status,
  and a reusable record action whose neutral idle state is visually distinct from
  its filled active-recording state
- Live workspace with transcript and manual notes visible together
- Compact audio evidence timeline, timestamp markers, playback controls, and
  timestamp-linked `Mark moment`
- Separate manual notes and quiet AI suggestions views, with model-quality
  controls kept out of the writing view on compact desktop windows
- Transcript, Notes, and AI segmented panes at compact desktop widths, without
  horizontal workspace scrolling
- Home, library, meeting summary, Review Mode, local export, Settings, and
  custody proof views
- First-run activation and setup screens that support a local trial without a
  persistent account
- Core-backed notes, retention, consent, model, capture, privacy, and scheduler
  facts
- Per-meeting, core-backed privacy receipts with encrypted chunk, channel,
  transcript, model integrity, export, retention, and network capability facts
- Progressive settings with Local AI and diagnostics behind Advanced disclosure
- Quality/Fast local AI control with an explicit heuristic fallback when no
  verified local instruct model is installed
- Structured report preview with native editable Word, searchable PDF, and
  Markdown enabled through a pathless OS save-dialog flow
- Letter/A4 controls plus summary, decisions, actions, risks, questions, manual
  notes, transcript, and timestamp section controls
- Rejected review items omitted from exports and unsaved manual notes persisted
  locally before document generation
- No public links, cloud AI, cloud storage, remote images, or background model
  downloads

## Static and Core Checks

`scripts/m3-product-surface-smoke.mjs` verifies:

- all seven Figma-derived product views exist in the renderer
- feature-owned renderer modules, typed protocol client, capture and local-job
  state hooks, stale-response coordination, and paged library reads are present
- transcript, notes, session tabs, record action, evidence timeline, and marked
  moments are present and accessible by labeled controls
- `recording.notes.save` and `recording.notes.read` persist notes through the
  Rust core without raw path exposure
- notes are searchable and included before the transcript in Markdown export
- retention remains manual-delete-only
- privacy capability and per-meeting receipt RPCs are pathless and report zero
  external calls in the smoke fixture
- local AI asset import is pathless at the renderer boundary
- local document saving is pathless at the renderer boundary; Electron main
  owns the save dialog and returns only a basename plus verification facts
- Word and PDF controls are enabled only because their native renderers and
  structured document tests pass
- the verified palette matches `token.json`
- violet text and link tokens maintain at least 4.5:1 contrast on canvas,
  surface, and raised-surface backgrounds
- responsive desktop rules exist for 1280px, 1180px, and 1080px widths
- compact Review Mode removes its inherited minimum width and keeps navigation,
  editing, and report preview columns inside the 1080px desktop viewport
- verified custody text cannot use scrambling or interval-driven fake glyphs
- informational status messages are dismissible, auto-dismiss after five
  seconds, and never change the geometry of transcript, notes, review, or export
- renderer code does not use `localStorage`, `sessionStorage`, or remote Figma
  asset URLs

## Packaged Visual Proof

The packaged smoke captures and pixel-checks these 1440 by 900 Windows views:

- `m3-product-surface-gui-review-win32-x64-activation.png`
- `m3-product-surface-gui-review-win32-x64-onboarding.png`
- `m3-product-surface-gui-review-win32-x64.png` for Live Meeting
- `m3-product-surface-gui-review-win32-x64-home.png`
- `m3-product-surface-gui-review-win32-x64-library.png`
- `m3-product-surface-gui-review-win32-x64-detail.png`
- `m3-product-surface-gui-review-win32-x64-review.png`
- `m3-product-surface-gui-review-win32-x64-export.png`
- `m3-product-surface-gui-review-win32-x64-settings.png`
- `m3-product-surface-gui-review-win32-x64-proof.png`

The capture path forces a full window repaint and discards a compositor warm-up
frame before hashing each PNG. This prevents stale software-compositor tiles
from being accepted as visual proof. Every final image was also inspected for
clipping, overlapping controls, unreadable text, blank regions, and incomplete
shell rendering.

The same packaged smoke can set `CANDOR_M0_SMOKE_WIDTH` and
`CANDOR_M0_SMOKE_HEIGHT`. A second run at 1080 by 720 verifies the desktop
layout below the compact breakpoint and writes screenshots with a
`gui-review-compact` label. The compact Home, Live Meeting, Review Mode, Export,
Settings, and privacy captures were manually inspected after the automated pixel
checks. The record actions remain stable, the meeting workspace exposes one
readable selected pane, Review Mode keeps its columns and `Edit` action visible,
and notifications do not cover controls or report content. Strict response
validation also caught and fixed a quote-only citation compatibility defect during
this visual pass.

Machine-readable evidence is stored at:

```text
release-v3/proofs/m0-packaged-runtime-smoke-gui-review-win32-x64.json
release-v3/proofs/m0-packaged-runtime-smoke-gui-review-compact-win32-x64.json
release-v3/proofs/v3-local-verification-win32-x64.json
release-v3/proofs/v3-release-artifact-smoke-win32-x64.json
```

## Still Pending

- block-style notes editor and full command palette
- automated WCAG browser audit and keyboard traversal proof
- named-speaker correction workflow
- packaged visual proof on macOS and Linux
