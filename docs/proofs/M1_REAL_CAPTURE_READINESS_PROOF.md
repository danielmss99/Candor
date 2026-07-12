# M1 Real Capture Readiness Proof

Status: **implemented non-recording readiness audit**

## Purpose

Real capture proof requires recording from the local microphone and system audio
devices. That should remain an explicit operator action.

This readiness audit checks whether the current machine appears capable of the
real capture proof without starting recording. It reads the pathless
`m1-capture-service-smoke` artifact and validates:

- M1 capture service smoke passed
- mic capture is implemented
- device counts were recorded without raw paths
- default microphone input is available
- Windows WASAPI loopback or Linux monitor-input system capture is ready
- combined mic plus system capture is ready on supported platforms
- no recording was attempted by the readiness audit

## Commands

Run the normal capture smoke first:

```powershell
npm run m1:capture-service-smoke
```

Then run readiness:

```powershell
npm run m1:real-capture-readiness
```

Record the current readiness state without failing the caller:

```powershell
npm run m1:real-capture-readiness:record
```

Run the consent-gated real capture proof orchestrator without recording, useful
for recording a missing-consent artifact:

```powershell
npm run m1:real-capture-proof:record
```

The audit writes:

```text
release-v3/proofs/m1-real-capture-readiness-<platform>-<arch>.json
```

## Boundary

This proof does not prove real audio capture happened. It proves only that the
local machine and capture adapter state look ready for an explicit real capture
run.

The release proof still requires:

```powershell
$env:CANDOR_M1_REAL_CAPTURE_CONSENT='1'
npm run m1:real-capture-proof
```

That command intentionally starts and stops local microphone, system-audio, and
combined capture. It first runs the non-recording readiness audit, then only
records if explicit operator consent is present. Each consented branch defaults
to 1200 ms, clamps `CANDOR_M1_REAL_CAPTURE_DURATION_MS` to 500 through 5000 ms,
and writes requested plus actual duration metadata. It writes:

```text
release-v3/proofs/m1-real-capture-proof-<platform>-<arch>.json
```
