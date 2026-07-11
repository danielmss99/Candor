# M2 Local Whisper Preflight Proof

Status: **strict gate implemented; Windows feature check and unit tests passed**

## Purpose

M2 requires real local transcription, not only synthetic transcript segments.
`transcription.runLocal` is already implemented behind the Rust `local-whisper`
feature, but the feature must compile on the release toolchain before Candor can
claim the walking skeleton transcribes with Whisper. The preflight also runs
targeted Rust unit tests for the audio preparation helpers that feed Whisper.

## Commands

Strict gate:

```powershell
npm run m2:whisper-preflight
```

Record current readiness without failing the caller:

```powershell
npm run m2:whisper-preflight:record
```

Both commands write:

```text
release-v3/proofs/m2-local-whisper-preflight-<platform>-<arch>.json
```

The M2 transcription audit consumes that artifact after the boundary smoke:

```powershell
npm run m2:transcription-proof-audit
```

## Required Evidence

The proof records:

- `cargo --version`
- `cmake --version`
- `cargo check --features local-whisper`
- `cargo test --features local-whisper transcription_service::tests`
- `localOnly: true`
- `cloudAi: false`
- no raw path or key exposure flags
- the downstream audit sees the preflight artifact as ready before M2 claims
  local Whisper implementation readiness

Strict mode fails unless CMake is present, the `local-whisper` feature check
passes, and the local Whisper transcription helper tests pass. Record-only mode
writes the same proof but exits successfully so local proof refreshes can capture
the blocker without claiming M2 Whisper readiness.

The audit is stricter about claims than the preflight itself. A passing preflight
means the Rust feature and audio-prep helpers are ready. It still does not mean a
verified model is installed or real audio has been transcribed. That final claim
requires `npm run m2:transcription-proof-audit:real` to pass against a boundary
artifact that records an actual local `whisper-rs` inference run.

To produce that real-inference boundary artifact without any cloud dependency,
provide a local verified Whisper model file and a local PCM 16-bit WAV fixture,
then run:

```powershell
$env:CANDOR_M2_REAL_WHISPER_CONSENT="1"
$env:CANDOR_M2_REAL_MODEL_PATH="C:\path\to\ggml-base.en.bin"
$env:CANDOR_M2_REAL_AUDIO_WAV="C:\path\to\local-fixture.wav"
npm run m2:real-whisper-proof
```

The command uses the core's streamed model import and hash verification path
after explicit operator consent. It does not download models, accept raw model
paths from the renderer, or mark the strict real gate as passing unless Whisper
writes transcript segments.

Record the top-level real Whisper proof state without reading local inputs or
running inference:

```powershell
npm run m2:real-whisper-proof:record
```

Before the heavy release build, validate the operator-local inputs with:

```powershell
npm run m2:real-whisper-inputs
```

Generate a local WAV fixture first when you do not already have one:

```powershell
npm run m2:local-wav-fixture
```

That preflight writes `release-v3/proofs/m2-real-whisper-inputs-<platform>-<arch>.json`
with model id, expected SHA-256, actual SHA-256, WAV format, duration, and missing
input failures. It does not record source file paths.

If `CANDOR_M2_REAL_AUDIO_WAV` is unset and the generated fixture exists, the
input preflight uses `release-v3/fixtures/m2-real-whisper-fixture-<platform>-<arch>.wav`.

The consent-gated orchestrator writes
`release-v3/proofs/m2-real-whisper-proof-<platform>-<arch>.json`.

## Current Result

On this Windows machine, `cargo check --features local-whisper` now passes after
the Cargo wrapper pins the discovered CMake executable through the `CMAKE`
environment variable. The preflight also runs unit coverage for PCM 16-bit audio
frame validation, stereo to mono downmixing, sample-rate conversion to 16 kHz,
channel-based speaker labels, and Whisper timestamp conversion. This proves the
Rust local Whisper feature compiles here and its local audio prep contract is
covered, but it does not prove a real model is installed or that a real meeting
has been transcribed yet.
