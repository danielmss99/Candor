# V3 Application Icon Proof

## Purpose

This proof prevents the branded desktop package from silently falling back to
the stock Electron icon.

## Commands

    npm run v3:icons:check
    npm run v3:icon-proof -- --release-dir release-v3-design-vetted-final15

## Evidence

The icon proof verifies:

- all generated PNG assets reproduce byte-for-byte from one deterministic source
- the Windows ICO contains nine valid PNG-backed resolutions
- the macOS ICNS contains seven valid modern PNG chunks
- the Linux PNG family contains every declared size from 16 through 1024 pixels
- Electron Builder references the ICO, ICNS, and Linux icon directory
- the packaged Windows executable exposes an associated icon
- every pixel in the extracted 32px executable icon matches the generated source

Machine-readable output:

    release-v3/proofs/v3-icon-proof-win32-x64.json

Extracted executable preview:

    release-v3/proofs/candor-executable-icon-win32-x64.png

The packaged-icon comparison is currently implemented on Windows. macOS and
Linux source formats are verified here; package-native extraction remains part
of their platform runner work.
