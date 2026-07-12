# M1 Consent Proof

## Purpose

This proof covers the local consent boundary for recording. Consent state is owned
by `candor-core`, stored locally under the app data root, and exposed to the
renderer only as pathless facts.

The renderer can request `consent.status` and acknowledge allowlisted consent
items through `consent.acknowledge`. It cannot choose arbitrary policy names,
write raw files, read paths, access key material, or bypass the typed IPC
allowlist.

## Commands

```powershell
npm run m1:consent-smoke
```

The full M1 proof also runs it:

```powershell
npm run m1:verify
```

The macOS privacy packaging contract is checked by:

```powershell
npm run m1:macos-privacy-contract-smoke
```

## Expected Result

The smoke script starts `candor-core` over stdio JSON-RPC with an isolated
`CANDOR_V3_DATA_DIR`, then verifies:

- a fresh consent store is not ready for mic or system-audio recording
- `capture.startMic` fails with `CONSENT_REQUIRED` before mic consent is saved
- `localOnlyStorage` plus `micRecording` unlocks mic recording only
- mic consent does not imply system-audio consent
- unknown consent items are denied with `CONSENT_ITEM_UNKNOWN`
- consent survives a sidecar restart using the same local data dir
- all responses keep `rawPathExposed: false`
- all key material exposure flags remain `false`

Passing output:

```text
M1 consent smoke passed.
```

## Boundary

Implemented:

- `consent.status`
- `consent.acknowledge`
- core-owned local consent persistence
- renderer mic recording gate based on `readyForMicRecording`
- core-enforced `CONSENT_REQUIRED` gate before microphone capture starts
- pathless consent facts for the custody rail
- macOS app bundle includes `NSMicrophoneUsageDescription` through
  `electron-builder.v3.yml`
- macOS app bundle includes `NSScreenCaptureUsageDescription` for the
  ScreenCaptureKit system-audio adapter
- macOS consent model includes `macosScreenCaptureSystemAudio` before
  ScreenCaptureKit system audio capture can start
- macOS package contract pins macOS 13, signs the embedded Rust sidecar, and
  applies the audio-input entitlement

Still pending:

- OS-native permission prompts and proof artifacts
- macOS TCC mic prompt proof from a packaged app
- macOS Screen & System Audio Recording permission proof from a packaged app
- Linux portal or desktop-environment permission proof where available
- Windows Settings permission proof where required by device policy

## macOS Notes

Apple's media-capture guidance requires a microphone purpose string when an app
uses microphone APIs. Apple's ScreenCaptureKit material also states that screen
and audio capture require consent that is stored in the Screen Recording privacy
setting. Candor keeps those as separate facts: the app bundle carries the
microphone and Screen & System Audio Recording purpose strings, while the actual
TCC grant remains a runtime proof gate. Static packaging checks do not claim that
the user granted either permission.
