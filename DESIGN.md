# Candor Design Authority

## Sources Of Truth

Use these files in this order:

1. `design/brand/CANDOR_PROJECT_BRAND_HANDOFF.md`
2. `design/figma/style-guide.md`
3. `design/figma/token.json`
4. `v3/renderer/src/tokens.css`

The approved identity is Keep Tab / Soft Signal. The canonical mark is
`assets/icons/candor-app-icon-master.svg`. Earlier blue, violet, scales, and
recording-ring marks are not production assets.

## Product Hierarchy

The primary journey is:

```text
Record -> Review -> Export
```

The normal sidebar contains Home, Meetings, and Settings. Recording is a
persistent primary action rather than an equal navigation destination. Model,
runner, hash, vault, network, migration, and proof controls belong in Advanced
Settings.

Live Meeting prioritizes recording state, elapsed time, sources, transcript,
notes, and Stop. Technical details are collapsible and cannot compete with the
live workflow.

## Color Roles

- Warm app canvas: `#F4F0E8`
- Cream work surface: `#FFFCF6`
- Quiet grouping: `#ECE7DE`
- Charcoal navigation: `#161616`
- Primary ink: `#1B1A18`
- Candor Coral action: `#FF6B5E`
- Active recording: `#C93434`
- Confirmed local success: `#287A55`
- Warning: `#A46612`
- Focus and neutral information: `#356A8A`
- Error and destructive state: `#B93636`

Coral uses dark text. Red is reserved for recording, destructive actions, and
errors. Blue is focus and neutral information. Green means a confirmed fact.
Color never communicates state alone.

Production component CSS consumes semantic variables from `tokens.css`. Raw
color literals do not belong in feature CSS.

## Type, Shape, And Density

- Inter is the interface family.
- Letter spacing is zero.
- Cards and controls use radii of 8px or less.
- Controls are 38px tall by default and 44px for the primary record action.
- Use borders and surface changes before shadows.
- Do not nest cards or make page sections float as cards.
- Keep one dominant primary action per screen.

## Desktop Behavior

- Reference viewport: 1440 by 900.
- Supported compact baseline: 960px desktop width.
- At 1180px and below, Transcript, Notes, and AI become a segmented single-pane
  view rather than a horizontally scrolling three-column canvas.
- Test 1366 by 768 at 125 and 150 percent display scaling.
- Stable controls and fixed-format elements use explicit dimensions so dynamic
  labels cannot shift layout.

## Accessibility

All actions use native controls where possible. Every icon-only button has an
accessible name and tooltip. Keyboard order follows DOM order. Focus uses the
blue focus token with visible offset. Status changes include text and use the
appropriate live-region or alert semantics. Reduced motion and high contrast
are release requirements.

## Honesty Rule

Privacy and custody UI is evidence, not marketing. A claim appears only when the
Rust core reports the supporting fact. Optional activation and update behavior
is disclosed separately from local recording and processing.
