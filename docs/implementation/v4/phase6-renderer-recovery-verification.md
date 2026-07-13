# Phase 6 Renderer Recovery Verification

## Scope

This checkpoint exposes only core-measured recovery and storage facts in the renderer.

- Durable recording status is startup-critical data.
- Active capture health refreshes every second.
- Idle storage health refreshes every 30 seconds.
- A failed capture command refreshes measured storage and capture status.
- Blocking or unavailable storage disables new recording starts.
- An active recording can still be stopped when storage blocks new starts.
- Quarantined meetings, incomplete deletion cleanup, recovered captures, and durable-write failures remain visible as persistent alerts.
- Existing meeting navigation, review, export, and deletion remain available.

## Runtime validation

- `RecordingPage` validates pathless quarantine records at runtime.
- Missing quarantine fields remain backward compatible and default to an empty collection.
- Persistent alert wording comes from measured core state rather than inferred intent.
- Storage-unavailable state fails closed for new recording starts.

## Verification run

```text
npm test -- --run
  33 test files passed
  99 tests passed

npm run electron:v3:typecheck-renderer
  passed

npm run m3:product-surface-smoke
  passed

npm run electron:v3:pack
  passed

$env:CANDOR_M0_SCREENSHOT_LABEL='v4-recovery'; npm run m0:packaged-smoke
  passed on Windows x64
```

Packaged proof:

```text
release-v3/proofs/m0-packaged-runtime-smoke-v4-recovery-win32-x64.json
```

Visual evidence:

```text
release-v3/proofs/m3-product-surface-v4-recovery-win32-x64-home.png
release-v3/proofs/m3-product-surface-v4-recovery-win32-x64.png
release-v3/proofs/m3-product-surface-v4-recovery-win32-x64-detail.png
release-v3/proofs/m3-product-surface-v4-recovery-win32-x64-review.png
release-v3/proofs/m3-product-surface-v4-recovery-win32-x64-export.png
```

The healthy packaged fixture correctly renders no recovery rail. Unit and static surface tests cover the blocking-alert layout and disabled new-recording action.

## Unverified here

- Physical disk exhaustion during a real microphone or system-audio recording.
- Windows display scaling at 125 percent and 150 percent.
- macOS and Linux packaged rendering.
- Long-duration capture on physical hardware.
