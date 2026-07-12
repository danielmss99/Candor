# Candor Desktop Style Guide

## Source Of Truth

`design/brand/CANDOR_PROJECT_BRAND_HANDOFF.md` and `Candor GUI Color System
Handoff v2` are the production identity and color sources of truth. They
supersede every earlier exploratory mark and GUI color value. The selected
identity is **Keep Tab / Soft Signal**. This guide combines those approved
foundations with the verified `Candor UX Design v1` layouts for the Electron v3
production surface. The Figma file contains seven 1440 by 900 desktop frames:

1. Dashboard
2. Live Meeting
3. Recording Library
4. Meeting Detail and Summary
5. Settings
6. Export Flow
7. Review Mode

The Figma file currently has no variables, local styles, components, or component
sets. `token.json` records the approved primitive, semantic, and component roles,
while `v3/renderer/src/tokens.css` is their runtime representation. Raw color
values are not permitted in production component CSS.

The canonical mark is `assets/icons/candor-app-icon-master.svg`. Every packaged
desktop icon and the in-app mark is generated from its open cream C and pointed
coral Keep Tab geometry. The legacy purple recording-ring mark is not an
approved production asset.

## Product Principles

- The default working view is the live meeting workspace, not a marketing or
  onboarding page.
- Transcript and manual notes remain visible together during a meeting.
- AI suggestions stay quiet and visually distinct from user-authored notes.
- Every privacy or custody statement must map to a fact returned by the Rust core.
- No account, public sharing, remote image, cloud AI, telemetry, or background
  network feature may appear in the product surface.
- Unsupported export formats are shown as unavailable, never as working actions.

## Desktop Shell

- Reference viewport: 1440 by 900.
- Top session rail: 58px tall.
- Expanded navigation: 240px wide.
- Main content padding: 28px at the reference viewport, 18px on compact desktop.
- Show at most three open meeting tabs, then place additional local meetings in
  the overflow menu.
- At 1180px and below, the live workspace becomes a Transcript, Notes, and AI
  segmented view. It does not require horizontal content scrolling.
- At 960px, the app remains a desktop layout with stable controls and one readable
  meeting pane at a time.

## Color

- App canvas: `#F4F0E8`
- Transcript, notes, settings, and dialog surfaces: `#FFFCF6`
- Secondary groupings and quiet controls: `#ECE7DE`
- Navigation and window chrome: `#161616`
- Primary and secondary text: `#1B1A18` and `#67625B`
- Dark-surface text: `#FFF9EE` and `#BDB7AE`
- Candor Coral brand action: `#FF6B5E`, with `#F55E52` hover and `#E95247` pressed
- Active recording only: `#C93434`
- Saved, exported, and locally verified: `#287A55`
- Permission and attention states: `#A46612`
- Links, neutral information, and keyboard focus: `#356A8A`
- Errors and destructive states: `#B93636`
- Default, subtle, and strong borders: `#D8D1C7`, `#E7E1D8`, and `#BDB5AA`

The shell has four visible levels: dark navigation, warm app canvas, cream work
surface, and warm-gray secondary grouping. Candor Coral frames the work and is
reserved for the single highest-priority branded action in a typical view.
Recording never uses the coral accent.

Color never communicates status alone. Every status also includes readable text.

## Typography

- Inter is the only interface family.
- Screen titles: 24px, semibold.
- Section titles: 15 to 17px, semibold.
- Primary content: 13 to 14px.
- Controls and metadata: 11 to 12px.
- Captions: 10px minimum.
- Letter spacing is always zero.

## Shape And Density

- Production radius is capped at 8px for cards and controls. The Figma file uses
  10 to 14px inconsistently; production normalizes those values for a quieter,
  more operational desktop surface.
- Controls are 38px tall by default and 44px for the primary record action.
- Use borders and surface shifts instead of large shadows.
- Do not nest cards. Interior groups use dividers or unframed spacing.

## Core Components

### Record Action

The action uses a 24px ring and 10px center dot, a clear `Start recording` label,
and a short capture-mode line. Its idle state uses a neutral work surface with a
semantic recording-red symbol and restrained edge. A filled `#C93434` surface is
reserved for active recording, where the center changes to a stop square. The
Keep Tab brand mark is never used as a recording or notification indicator. The
control remains stable at every desktop breakpoint.

### Session Tabs

Tabs preserve local meeting context and expose a close control. They are compact,
single-line, and limited to three visible sessions. Additional sessions remain
available from an overflow menu. Tabs never imply cloud sync.

### Sidebar

The default navigation contains Current meeting, Meetings, Exports, and Settings.
Review, report detail, privacy diagnostics, model integrity, and import tools open
inside their workflow or under Advanced settings instead of competing in the
primary sidebar. The Figma `Shared` destination is intentionally omitted because
Candor has no cloud sharing surface.

### Live Workspace

The waveform is a 92px confidence strip. The content below is a transcript and
notes split, with a persistent 52px transport. User notes use a real editable
textarea. AI suggestions and their model-quality control remain in a separate
panel state so the manual notes editor keeps its writing space on compact desktop
windows. Compact desktop uses a Transcript, Notes, and AI segmented control.

### Privacy Receipt

Each meeting exposes a pathless privacy receipt backed by Rust-core facts. It
shows encrypted chunk state, capture channels, transcript count, processing and
export history, model integrity fingerprints when available, retention policy,
and the capability-based network policy. Friendly facts are visible first;
technical evidence uses disclosure controls.

### Settings

General, Recording, Export, and License are the default sections. Local AI and
Privacy and diagnostics are hidden behind an explicit Advanced control. Technical
terms such as runner, GGUF, SHA-256, scheduler, and vault are supporting details,
not primary navigation labels.

### Notifications

Status and error messages appear as dismissible overlays below the session rail.
Success uses green plus direct local-save or export language; warnings use amber
plus a required action; errors use red plus a recovery action. They never change
page geometry or take height away from the live transcript, notes editor, review
surface, or export preview. Informational messages dismiss automatically after
five seconds; errors remain until the user acknowledges them.

### Review And Export

Review Mode uses three columns: section navigation, editable report content, and
document preview. The preview is a document representation, never a screenshot of
the app. Markdown, native editable Word, and searchable PDF exports are available
through a pathless local save flow. Letter and A4 use the same structured report
data, and rejected review items are omitted from the generated document.

## Accessibility

- All controls use native buttons, inputs, checkboxes, textareas, or disclosure
  elements.
- Every icon-only control has an accessible name and tooltip.
- Focus uses a 2px blue `#356A8A` outline with offset.
- Disabled controls remain legible through explicit disabled background, border,
  and text tokens instead of opacity alone.
- Every color-coded state includes text, an icon, a shape, or stable placement.
- Status messages use polite live regions; blocking errors use alert semantics.
- Selected tabs and segmented controls expose `aria-selected` or `aria-pressed`.
- Keyboard navigation follows DOM order and never depends on pointer hover.

## Code Mapping

- Figma top bar -> `.session-rail`
- Figma sidebar -> `.desktop-sidebar`
- Figma quick actions -> `.dashboard-actions`
- Figma waveform -> `.compact-waveform`
- Figma live transcript -> `.live-transcript`
- Figma notes panel -> `.meeting-notes-panel`
- Figma meeting intelligence -> `.meeting-intelligence`
- Figma review navigation -> `.review-navigation`
- Figma document page -> `.document-preview`
- Meeting custody evidence -> `.privacy-receipt`
- Compact meeting navigation -> `.compact-pane-switcher`

The implementation uses React, TypeScript, and plain CSS already present in the
Electron v3 renderer. Tailwind and remote Figma assets are not introduced.

The token architecture is primitive to semantic to component. `tokens.css` is
loaded before `styles.css`; components consume role variables and contain no raw
hex, RGB, or HSL color values.

Feature ownership is split under `v3/renderer/src/features` for capture, local AI,
onboarding, home, library, live meeting, detail, review, export, privacy, and
settings. `CandorApp.tsx` coordinates these domains through the typed core client,
feature hooks, and explicit state machines.
