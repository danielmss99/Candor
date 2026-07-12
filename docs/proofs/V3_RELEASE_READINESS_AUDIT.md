# V3 Release Readiness Audit

Status: **implemented readiness matrix; current release is not ready**

## Purpose

`npm run v3:verify` proves the local staged implementation is healthy on the
current machine. It does not prove Candor v3 is ready to release across Windows,
macOS, and Linux.

This audit records the stricter release evidence required by the from-scratch
mission:

- M0 cross-OS packaged network exit proof
- local staged verification
- V3 source security proof
- V3 updater policy proof
- V3 release artifact smoke
- V3 signed release and installer proof
- M1 real capture readiness
- M1 consented real capture orchestrator proof
- M1 real mic plus system capture proof
- M2 consented real Whisper orchestrator proof
- M2 real Whisper local model and WAV input readiness
- M2 real local Whisper inference proof

## Commands

Record the current readiness matrix without failing the caller:

```powershell
npm run v3:release-readiness-audit
```

Fail unless every release-readiness gate is proven:

```powershell
npm run v3:release-readiness-audit:strict
```

Produce the M1 strict real capture artifact through the consent-gated
orchestrator:

```powershell
$env:CANDOR_M1_REAL_CAPTURE_CONSENT='1'
npm run m1:real-capture-proof
```

The M1 orchestrator records real mic, system-audio, and combined branches only
after consent. Each branch defaults to 1200 ms, clamps
`CANDOR_M1_REAL_CAPTURE_DURATION_MS` to 500 through 5000 ms, and must write
requested plus actual duration metadata for the strict release gate.

Produce the M2 strict real Whisper artifacts through the consent-gated
orchestrator:

```powershell
npm run m2:local-wav-fixture
$env:CANDOR_M2_REAL_WHISPER_CONSENT='1'
$env:CANDOR_M2_REAL_MODEL_PATH='C:\path\to\ggml-base.en.bin'
npm run m2:real-whisper-proof
```

The audit writes:

```text
release-v3/proofs/v3-release-readiness-audit-<platform>-<arch>.json
```

The source security gate is produced by:

```powershell
npm run v3:source-security-proof
```

The updater policy gate is produced by:

```powershell
npm run v3:updater-policy-proof
```

The release signing gate is produced by:

```powershell
npm run electron:v3:dist
npm run v3:release-artifact-smoke
npm run v3:release-signing-proof
```

Strict mode writes:

```text
release-v3/proofs/v3-release-readiness-audit-strict-<platform>-<arch>.json
```

## Current Expected Result

The audit is expected to record gaps until the missing release evidence exists.
Current expected gaps include:

- M0 strict exit is not ready because Windows network-deny proof needs an
  elevated firewall run and Linux/macOS packaged network proof artifacts are
  missing.
- M1 real capture readiness may pass on a machine with default mic and system
  audio devices, but it is not a substitute for the strict real capture proof.
- M1 real device capture has not been proven until
  `m1-real-capture-proof-<platform>-<arch>.json` and
  `m1-capture-proof-audit-real-<platform>-<arch>.json` passes.
  Use `npm run m1:real-capture-proof` with explicit consent to produce it.
- Signed release readiness has not been proven until
  `v3-release-signing-proof-<platform>-<arch>.json` records signed Windows
  app, sidecar, and installer artifacts plus macOS and Linux release package
  readiness. The signing proof must also match the current platform release
  artifact hashes recorded by the M0 artifact manifest and release artifact
  smoke proof. macOS readiness requires local codesign verification for any
  unpacked app bundle, Gatekeeper assessment for the app bundle and DMG, and
  `xcrun stapler validate` proof for the notarized DMG or app bundle. Linux
  AppImage/deb artifacts must have verified detached signatures.
  Use `npm run electron:v3:dist` or the platform-specific `electron:v3:dist:*`
  scripts before running the proof when release artifacts need to be created.
- Release artifact contents are proven by
  `v3-release-artifact-smoke-<platform>-<arch>.json`. On Windows this extracts
  the NSIS installer payload without installing it and checks that the packaged
  app executable, `app.asar`, and `candor-core.exe` match the unpacked output.
  On macOS and Linux, the DMG, AppImage, or deb payload entries must also
  hash-match the corresponding unpacked app payloads.
- M2 real Whisper is proven only when
  `m2-real-whisper-proof-<platform>-<arch>.json`,
  `m2-real-whisper-inputs-<platform>-<arch>.json`, and
  `m2-transcription-proof-audit-real-<platform>-<arch>.json` all pass for the
  local model and WAV fixture on this machine.

## Boundary

This audit does not download models, run network checks, or create missing
platform artifacts. It reads current proof artifacts and writes a pathless
readiness summary. Default mode is for progress tracking. Strict mode is the
release gate.
