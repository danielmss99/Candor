# M3 Product Surface Proof

Status: **implemented color-handoff-aligned desktop surface with packaged Windows visual proof**

## Purpose

M3 turns the walking skeleton into a desktop meeting workspace where transcript,
notes, evidence, capture state, review, and local export remain connected. The
surface follows `Candor GUI Color System Handoff v2` and the verified Candor
Figma layouts while replacing cloud or public sharing behavior with core-backed
local custody facts.

## Design Source

- Primary color source: `Candor GUI Color System Handoff v2`
- Primary identity source: `design/brand/CANDOR_PROJECT_BRAND_HANDOFF.md`
- Canonical Keep Tab mark: `assets/icons/candor-app-icon-master.svg`
- Figma file key: `wUT5Ai8170LZAmUqMfo2CI`
- Review Mode: `3:2`
- Dashboard: `6:2`
- Live Meeting: `6:83`
- Recording Library: `6:231`
- Meeting Detail and Summary: `6:317`
- Settings: `6:413`
- Export Flow: `6:494`
- Local tokens: `design/figma/token.json`
- Runtime tokens: `v3/renderer/src/tokens.css`
- Implementation rules: `design/figma/style-guide.md`

The color handoff supersedes all earlier GUI color values. The Figma file did not
expose variables, local styles, components, or component sets through the
inspected API. Approved values are therefore codified through primitive,
semantic, and component roles instead of claiming a formal Figma library exists.

## Commands

```powershell
npm run m3:verify
npm run v3:icon-proof
$env:CANDOR_M0_SCREENSHOT_LABEL='brand-handoff'; npm run m0:packaged-smoke
$env:CANDOR_M0_SCREENSHOT_LABEL='brand-handoff-compact'; $env:CANDOR_M0_SMOKE_WIDTH='1080'; $env:CANDOR_M0_SMOKE_HEIGHT='720'; npm run m0:packaged-smoke
$env:CANDOR_M0_SCREENSHOT_LABEL='brand-handoff-scale-125'; $env:CANDOR_M0_SMOKE_SCALE_FACTOR='1.25'; npm run m0:packaged-smoke
$env:CANDOR_M0_SCREENSHOT_LABEL='brand-handoff-scale-150'; $env:CANDOR_M0_SMOKE_SCALE_FACTOR='1.5'; npm run m0:packaged-smoke
$env:CANDOR_M0_SCREENSHOT_LABEL='brand-handoff-scale-200'; $env:CANDOR_M0_SMOKE_SCALE_FACTOR='2'; npm run m0:packaged-smoke
```

## Implemented Surface

- Desktop shell with a maximum of three visible meeting tabs, an overflow menu,
  Current meeting, Meetings, Exports, and Settings navigation, local-only status,
  and a reusable record action whose neutral idle state is visually distinct from
  its filled active-recording state
- Warm-neutral hierarchy with warm-black navigation, a muted warm-gray app
  canvas, cream transcript and notes surfaces, and quiet secondary groupings
- Candor Coral reserved for primary branded actions, with separate semantic red
  recording, green success, amber warning, blue information/focus, and red error
  roles
- Approved Keep Tab / Soft Signal app icon across the Electron shell, Windows
  package, macOS package, Linux icon family, and deterministic build outputs
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
- the approved v2 palette matches `token.json` and the runtime token layer
- the approved Keep Tab master contains only Warm Black, Document Cream, and
  Candor Coral; retains its pointed tab; and contains no gradient, filter, remote
  image, or exploratory purple palette
- Windows ICO, macOS ICNS, Linux PNGs, and the in-app mark are reproducible from
  the approved deterministic geometry
- primary and secondary light-surface text, dark-navigation text, coral primary
  actions, informational links, success states, and recording states maintain at
  least 4.5:1 contrast on their intended backgrounds
- production component CSS contains no raw hex, RGB, HSL, or gradient values
- recording uses its own semantic token and the Keep Tab is never used as a
  recording or notification symbol
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

- `m3-product-surface-brand-handoff-win32-x64-activation.png`
- `m3-product-surface-brand-handoff-win32-x64-onboarding.png`
- `m3-product-surface-brand-handoff-win32-x64.png` for Live Meeting
- `m3-product-surface-brand-handoff-win32-x64-home.png`
- `m3-product-surface-brand-handoff-win32-x64-library.png`
- `m3-product-surface-brand-handoff-win32-x64-detail.png`
- `m3-product-surface-brand-handoff-win32-x64-review.png`
- `m3-product-surface-brand-handoff-win32-x64-export.png`
- `m3-product-surface-brand-handoff-win32-x64-settings.png`
- `m3-product-surface-brand-handoff-win32-x64-proof.png`

The capture path forces a full window repaint and discards a compositor warm-up
frames and keeps the richest PNG before hashing it. This prevents stale
software-compositor tiles from being accepted as visual proof. Every final image
was also inspected for clipping, overlapping controls, unreadable text, blank
regions, incomplete shell rendering, flattened surface hierarchy, and excessive
coral use.

The same packaged smoke can set `CANDOR_M0_SMOKE_WIDTH` and
`CANDOR_M0_SMOKE_HEIGHT`. A second run at 1080 by 720 verifies the desktop
layout below the compact breakpoint and writes screenshots with a
`brand-handoff-compact` label. The compact Home, Live Meeting, Review Mode, Export,
Settings, and privacy captures were manually inspected after the automated pixel
checks. The record actions remain stable, the meeting workspace exposes one
readable selected pane, Review Mode keeps its columns and `Edit` action visible,
and notifications do not cover controls or report content. Strict response
validation also caught and fixed a quote-only citation compatibility defect during
this visual pass.

The same packaged workflow was run at forced device scale factors 1, 1.25, 1.5,
and 2. Each pass captured activation, onboarding, live meeting, Home, library,
detail, review, export, settings, and privacy views. All four scaling passes
retained readable text, stable record controls, visible focus/state boundaries,
and complete workflow content without overlap or clipping.

Machine-readable evidence is stored at:

```text
release-v3/proofs/m0-packaged-runtime-smoke-color-v2-win32-x64.json
release-v3/proofs/m0-packaged-runtime-smoke-color-v2-compact-win32-x64.json
release-v3/proofs/m0-packaged-runtime-smoke-color-v2-scale-125-win32-x64.json
release-v3/proofs/m0-packaged-runtime-smoke-color-v2-scale-150-win32-x64.json
release-v3/proofs/m0-packaged-runtime-smoke-color-v2-scale-200-win32-x64.json
release-v3/proofs/v3-local-verification-win32-x64.json
release-v3/proofs/v3-release-artifact-smoke-win32-x64.json
```

## Still Pending

- block-style notes editor and full command palette
- automated WCAG browser audit and keyboard traversal proof
- named-speaker correction workflow
- packaged visual proof on macOS and Linux
