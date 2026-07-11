# Candor Application Icon

The Candor application icon is generated from one deterministic geometry source
in scripts/generate-v3-icons.mjs.

## Visual system

- Deep indigo and violet squircle: the private desktop workspace.
- Open white C-shaped recording ring: Candor and transparent capture.
- Coral center dot: an unmistakable recording state.
- Three white waveform bars: transcription and meeting audio.
- Transparent outer corners: native-looking presentation on every desktop OS.

The icon intentionally remains legible at 16 pixels and does not communicate
security through a decorative lock. Local custody is proven in the product UI
and core audit facts.

## Generated assets

- build/icon.ico: multi-resolution Windows executable and installer icon.
- build/icon.icns: modern macOS icon family.
- build/icon.png: 512 pixel fallback.
- build/icons/*.png: Linux desktop icon sizes.
- v3/renderer/public/candor-mark.png: in-app wordmark asset.

Regenerate and verify:

    npm run v3:icons
    npm run v3:icons:check
