# Candor Application Icon

The Candor application icon uses the selected **Keep Tab** mark in the Soft
Signal palette. The canonical SVG source is:

- `assets/icons/candor-app-icon-master.svg`

Generated desktop assets are produced from the same deterministic geometry in:

- `scripts/generate-v3-icons.mjs`

## Visual System

- Warm Black field: private desktop ownership.
- Document Cream open C: Candor, continuity, and a record that can be reviewed.
- Candor Coral tab: the kept note, action, or proof point that remains useful
  after the meeting.
- Transparent outer corners: native presentation on each desktop OS.

The icon intentionally avoids microphones, waveform bars, locks, clouds, bots,
speech bubbles, AI sparkles, and purple gradients. Recording state is shown by
app controls, not by the brand mark.

## Generated Assets

- `assets/icons/candor-app-icon-{size}.png`: approved raster family.
- `assets/platform/candor.ico`: multi-resolution Windows package icon.
- `assets/platform/candor.icns`: macOS package icon family.
- `build/icon.ico`, `build/icon.icns`, and `build/icon.png`: builder-compatible
  copies.
- `build/icons/*.png`: Linux desktop icon sizes.
- `v3/renderer/public/candor-mark.png`: in-app mark asset.

Regenerate and verify:

```powershell
npm run v3:icons
npm run v3:icons:check
npm run v3:icon-proof
```
