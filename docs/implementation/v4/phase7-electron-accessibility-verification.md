# Phase 7 Electron and Accessibility Verification

## Scope

This checkpoint adds conventional Electron integration and automated accessibility coverage without changing packaged production behavior.

- Playwright launches the built Electron main process with an isolated temporary data directory.
- A synthetic local meeting is seeded through the same Rust JSONL protocol used by Electron.
- The test renderer remains sandboxed and receives the production preload bridge.
- The E2E-only data and scale switches are accepted only when Electron is not packaged and `CANDOR_E2E=1`.
- CI runs the suite on Windows, macOS, and Linux. Linux uses the existing Xvfb dependency.

## Security assertions

The Electron test verifies:

- `contextIsolation: true`;
- `sandbox: true`;
- `nodeIntegration: false`;
- `webSecurity: true`;
- no renderer `require`, `process`, or `Buffer` globals;
- the exact `window.candor` top-level and nested method allowlists;
- no generic invoke, filesystem, path, or process method;
- popups are denied;
- a main-process session request to a resolvable external origin is blocked;
- renderer-initiated external navigation emits `will-navigate`, is marked
  `defaultPrevented`, and leaves the local document loaded.

Core startup faults, malformed protocol output, restart denial during capture, close guarding, and navigation policy also remain covered by focused Electron unit tests.

## Accessibility assertions

`@axe-core/playwright` runs the axe engine inside the real Electron renderer
using WCAG 2 A, WCAG 2 AA, WCAG 2.1 A, and WCAG 2.1 AA tags. Legacy injection
mode is required because Electron exposes one sandboxed document and cannot
create axe's second browser target; Candor has no iframe surface.

Screens scanned:

- activation;
- Home;
- live meeting;
- Meetings;
- meeting detail;
- Review;
- Export;
- Settings.

The test also verifies keyboard focus leaves the document body after Tab.

The first runs found and fixed:

1. Invalid `tablist` descendants caused by close buttons inside visual session tabs. The strip now uses navigation semantics with `aria-current` while retaining the same visual behavior.
2. Warning-action text below 4.5:1 contrast.
3. Settings group-label text below 4.5:1 contrast.

Automated axe coverage does not replace manual screen-reader or inclusive-user testing.

## Scale and layout

Playwright launches at 1366 by 768 with forced scale factors of 1.25 and 1.5. Each run asserts:

- the requested device pixel ratio is active;
- Start recording and Meetings remain visible;
- document width and height do not overflow the viewport;
- a screenshot is captured from the actual Electron renderer.

Evidence:

```text
release-v3/proofs/playwright-home-scale-125.png
release-v3/proofs/playwright-home-scale-150.png
```

Both screenshots were visually inspected for clipping, overlap, and primary-action visibility.

## Verification run

```text
npm test -- --run
  34 files, 105 tests passed

npm run electron:v3:typecheck-renderer
  passed

npm run test:electron:build
  4 Playwright Electron tests passed

npm run m3:product-surface-smoke
  passed

npm run electron:v3:pack
  passed on Windows x64

$env:CANDOR_M0_SCREENSHOT_LABEL='v4-playwright'; npm run m0:packaged-smoke
  passed on Windows x64
```

Packaged proof:

```text
release-v3/proofs/m0-packaged-runtime-smoke-v4-playwright-win32-x64.json
```

Claude's final adversarial review returned **GO WITH REQUIRED FIXES**. The
two-way release package binding, deterministic navigation observer, and
session-request probe were corrected and focused re-review confirmed the fixes.
The complete disposition is in `claude-phase7-review-reconciliation.md`.

## Remaining manual gates

- Physical microphone and system-audio recording matrix.
- 5-, 30-, 60-, and 180-minute hardware recordings.
- Sleep/resume and device switching.
- Clean-machine installer and upgrade testing.
- Production signing, notarization, and Linux detached signatures.
- Manual screen-reader and high-contrast assessment.
