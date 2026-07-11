# M1 Capture Service Proof

## Purpose

This proof covers the v3 Rust core capture service boundary.

The core now has a `cpal` microphone capture service that can write PCM chunks
directly into the durable local recording store. On Windows, it also exposes a
WASAPI loopback system-audio capture lane by using a `cpal` output device as an
input stream. On Linux, it can use PipeWire or PulseAudio monitor-style input
devices through `cpal` as the system-audio source. Windows and Linux builds can
start microphone plus system capture in one recording through a serialized core
writer, preserving separate durable `mic` and `system` tracks without concurrent
manifest mutation. On macOS 13 and later, system audio uses ScreenCaptureKit and
validates CoreMedia float PCM before converting it to Candor's durable 16-bit
`system` track. The macOS microphone remains a separate `cpal` CoreAudio stream,
and both sources use the same serialized writer for combined capture. The
renderer can request capture status, list input/output
devices, start mic capture, start implemented system capture, start implemented
combined capture, and stop capture through typed IPC. It still cannot access raw
paths, key material, arbitrary process execution, or arbitrary filesystem APIs.

The M1 smoke harness also calls the core-only `capture.proofSerializedWriter`
method. That proof starts two synthetic producers, sends interleaved `mic` and
`system` chunks through the same serialized writer shape used by combined
capture, and verifies the replay manifest still contains separate durable
tracks.

Native callbacks feed bounded queues so they never block the OS audio thread.
Queue overflow, device invalidation, and stream failures are captured as the
first session integrity error, stop the shared mic plus system session, and
flush audio that had already entered the queue. Candor does not silently discard
callback audio and then label the recording complete. `capture.status` exposes
the queue capacity, fail-session overflow policy, runtime-error propagation,
and no-silent-drop contract for proof and UI use.

`npm run m1:capture-crash-smoke` uses the related core-only
`capture.proofInterruptedSerializedWriter` method. It writes separated mic and
system chunks through the capture-service serialized writer, force-kills the
sidecar before finish, starts a new sidecar with the same local data root, and
verifies startup recovery marks the recording `needsRecovery` while preserving
the separated replay tracks.

The renderer also gates mic recording on the core-owned consent state proven in
`docs/proofs/M1_CONSENT_PROOF.md`.

## Commands

```powershell
npm run m1:capture-service-smoke
npm run m1:capture-proof-audit
npm run m1:real-capture-readiness
npm run m1:real-capture-proof:record
npm run m1:capture-crash-smoke
```

To require a proof artifact where real mic, real system audio, and real combined
capture were intentionally run, use the explicit-consent orchestrator:

```powershell
$env:CANDOR_M1_REAL_CAPTURE_CONSENT='1'
npm run m1:real-capture-proof
```

Without `CANDOR_M1_REAL_CAPTURE_CONSENT=1` or the
`--i-understand-this-records-local-audio` flag, the orchestrator writes a
missing-consent proof and does not start recording.

Consented real-device proof runs are intentionally short and bounded. The
default capture duration is 1200 ms per real branch. Operators can set
`CANDOR_M1_REAL_CAPTURE_DURATION_MS`, but the harness clamps the value to 500
through 5000 ms and records both requested and actual branch durations in the
proof artifact.

To attempt a real microphone start/stop in addition to the synthetic durable proof:

```powershell
$env:CANDOR_CAPTURE_REAL_DEVICE='1'
npm run m1:capture-service-smoke
```

To attempt a real system-audio start/stop on the current platform:

```powershell
$env:CANDOR_CAPTURE_REAL_SYSTEM='1'
npm run m1:capture-service-smoke
```

To attempt a real microphone plus system-audio start/stop in one recording on
the current platform:

```powershell
$env:CANDOR_CAPTURE_REAL_BOTH='1'
npm run m1:capture-service-smoke
```

The real-device branch acknowledges the core-owned mic consent items before it
calls `capture.startMic`; without that consent, `capture.startMic` is rejected by
the Rust core with `CONSENT_REQUIRED`.

The real system branch acknowledges local storage plus system-audio consent
before it calls `capture.startSystem`; without that consent, the Rust core
rejects the call with `CONSENT_REQUIRED`.

The real combined branch acknowledges all required mic plus system consent items
before it calls `capture.startMicAndSystem`; without that consent, the Rust core
rejects the call with `CONSENT_REQUIRED`.

The smoke writes a machine-readable proof artifact:

```text
release-v3/proofs/m1-capture-service-smoke-<platform>-<arch>.json
```

Default runs are allowed to pass without real audio hardware, but the artifact
must say so explicitly. It records synthetic coverage under `synthetic` and the
real-device branch status under `realDevice.mic`, `realDevice.system`, and
`realDevice.combined`. A release candidate cannot use the default skipped
branches as real-device proof.

`npm run m1:capture-proof-audit` validates the default artifact and writes:

```text
release-v3/proofs/m1-capture-proof-audit-<platform>-<arch>.json
```

`npm run m1:real-capture-readiness` validates whether the current machine has
the non-recording prerequisites for a real mic plus system capture proof and
writes:

```text
release-v3/proofs/m1-real-capture-readiness-<platform>-<arch>.json
```

The `:real` variant fails unless all three real-device branches have
`requested: true`, `attempted: true`, `ok: true`, and positive audio chunk
counts. It also requires each branch to record a bounded
`durationMsRequested` value and an actual `durationMsActual` value. It does not
start recording by itself; it only audits an artifact created by an explicit
real-device smoke run.

The `:real` audit writes a separate artifact so a failed strict check cannot
overwrite the default M1 proof:

```text
release-v3/proofs/m1-capture-proof-audit-real-<platform>-<arch>.json
```

The consent-gated orchestrator writes its own top-level proof:

```text
release-v3/proofs/m1-real-capture-proof-<platform>-<arch>.json
```

## Expected Result

The default smoke script starts `candor-core` over stdio JSON-RPC with an isolated `CANDOR_V3_DATA_DIR`, then verifies:

- `capture.status` reports the mic capture service as implemented
- `capture.status.integrityPolicy` reports a 32-buffer callback queue,
  `fail-capture-session` overflow handling, propagated runtime stream errors,
  buffered-audio flushing, and `silentCallbackDropsAllowed: false`
- Windows `capture.status` reports `cpal-wasapi-loopback` system capture as
  implemented
- Windows `capture.status` reports `capture.startMicAndSystem` as the combined
  mic plus system method with a serialized writer
- Linux `capture.status` reports `cpal-linux-monitor-input` system capture as
  implemented, with PipeWire and PulseAudio monitor input adapters named
- macOS `capture.status` reports `screencapturekit-system-audio` as implemented,
  requires the OS-managed Screen & System Audio Recording permission, and defers
  the TCC-gated availability probe until capture start
- `capture.devices` returns pathless input and output device lists
- `capture.proofSynthetic` writes separate durable `mic` and `system` audio chunks
- `capture.proofSerializedWriter` writes twelve chunks from two synthetic
  producers through one serialized writer
- `release-v3/proofs/m1-capture-service-smoke-<platform>-<arch>.json` records
  whether real mic, system, and combined capture branches were attempted or
  skipped
- consented real-device runs record bounded requested and actual duration
  metadata per branch
- replay metadata contains separate `mic` and `system` tracks
- all responses keep `rawPathExposed: false`
- all key material exposure flags remain `false`
- `m1:capture-crash-smoke` preserves separated mic and system chunks after a
  forced sidecar kill and startup recovery

Passing output:

```text
M1 capture service smoke passed.
M1 capture crash recovery smoke passed.
```

## Boundary

This is a step toward M1, not the full M1 capture exit.

Implemented:

- `capture.status`
- `capture.devices`
- `capture.startMic`
- `capture.startSystem` on Windows
- `capture.startSystem` on Linux when a PipeWire or PulseAudio monitor input
  device is present
- `capture.startSystem` on macOS 13 or later through ScreenCaptureKit
- `capture.startMicAndSystem` on Windows, Linux, and macOS, with one serialized
  durable writer
- `capture.stop`
- core-only `capture.proofSynthetic`
- core-only `capture.proofSerializedWriter`
- core-only `capture.proofInterruptedSerializedWriter`
- mic capture through `cpal` default host
- fail-closed CPAL callback overflow and runtime stream-error propagation with
  first-error preservation
- Windows system audio through `cpal` WASAPI loopback
- Linux system audio through `cpal` monitor-style input devices exposed by
  PipeWire or PulseAudio
- macOS system audio through ScreenCaptureKit with explicit float PCM format
  validation, interleaved and planar conversion, and current-process audio
  exclusion
- Windows, Linux, and macOS mic plus system capture into one recording with
  separate durable `mic` and `system` tracks
- durable audio chunk writes into the encrypted local recording store when
  native OS key storage is available

Still pending:

- macOS packaged-app TCC runtime proof for the Rust sidecar's responsible-app
  attribution and the Screen & System Audio Recording prompt
- macOS real-device system and combined capture proof artifacts
- kill-9 recovery proof against a real OS audio device session
- cross-OS real-device proof artifacts
