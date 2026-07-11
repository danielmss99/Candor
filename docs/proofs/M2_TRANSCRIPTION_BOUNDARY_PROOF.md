# M2 Transcription Boundary Proof

## Purpose

This proof covers the local transcription service boundary for the M2 walking skeleton.

The core now owns a `transcription.*` command family. Renderer input is limited to recording id, optional channel, optional model id, language, and initial prompt. The renderer cannot pass raw model paths, raw recording paths, vault keys, passphrases, arbitrary filesystem handles, or network endpoints.

## Command

```powershell
npm run m2:transcription-boundary-smoke
```

The full M2 proof runs it too:

```powershell
npm run m2:verify
```

The full M2 proof also runs the real Whisper feature preflight:

```powershell
npm run m2:whisper-preflight
```

Then it audits the generated proof artifacts:

```powershell
npm run m2:transcription-proof-audit
```

Strict real-inference audit:

```powershell
npm run m2:transcription-proof-audit:real
```

Full real local Whisper proof, using an operator-supplied local model and WAV:

```powershell
$env:CANDOR_M2_REAL_WHISPER_CONSENT="1"
$env:CANDOR_M2_REAL_MODEL_PATH="C:\path\to\ggml-base.en.bin"
$env:CANDOR_M2_REAL_AUDIO_WAV="C:\path\to\local-fixture.wav"
npm run m2:real-whisper-proof
```

Optional inputs:

```powershell
$env:CANDOR_M2_REAL_MODEL_ID="base.en"
$env:CANDOR_M2_REAL_LANGUAGE="en"
$env:CANDOR_M2_REAL_EXPECT_TEXT="known phrase from the fixture"
```

Check those local inputs without running Whisper:

```powershell
npm run m2:real-whisper-inputs
```

Generate a local PCM 16-bit WAV fixture without recording a microphone or using
cloud services:

```powershell
npm run m2:local-wav-fixture
```

Record the current missing-input state without failing:

```powershell
npm run m2:real-whisper-inputs:record
```

Record the top-level real Whisper proof state without reading local inputs or
running inference:

```powershell
npm run m2:real-whisper-proof:record
```

## Expected Result

The smoke script starts `candor-core` over stdio JSON-RPC with an isolated `CANDOR_V3_DATA_DIR`, then verifies:

- `transcription.status` reports local-only operation, no cloud AI, no renderer model paths, and the shared local scheduler that prevents Whisper plus LLM concurrency
- `models.status` and `models.verifyLocal` own the pathless model custody and hash verification contract used by `transcription.runLocal`
- `transcription.proofSynthetic` writes local timed transcript segments into durable storage
- the proof returns two channel-attributed segments and two pathless replay audio chunks
- `recording.durable.search` indexes the generated transcript segments
- `export.create` includes generated transcript segments in the Markdown export
- finished recordings can receive local transcript segments after capture stop
- default builds fail closed with `TRANSCRIPTION_ENGINE_UNAVAILABLE` when `transcription.runLocal` is called without the `local-whisper` feature
- `npm run m2:whisper-preflight` proves the Rust `local-whisper` feature
  compiles on the release toolchain and runs targeted audio-prep unit tests
- `npm run m2:transcription-proof-audit` proves the boundary smoke and
  preflight artifacts exist, are pathless, and distinguish synthetic transcript
  proof from real local Whisper inference

Passing output:

```text
M2 transcription boundary smoke passed.
```

The boundary smoke writes:

```text
release-v3/proofs/m2-transcription-boundary-smoke-<platform>-<arch>.json
```

The real local Whisper boundary smoke writes:

```text
release-v3/proofs/m2-transcription-boundary-smoke-real-<platform>-<arch>.json
```

The audit writes:

```text
release-v3/proofs/m2-transcription-proof-audit-<platform>-<arch>.json
```

The strict real-inference audit writes:

```text
release-v3/proofs/m2-transcription-proof-audit-real-<platform>-<arch>.json
```

The input preflight writes:

```text
release-v3/proofs/m2-real-whisper-inputs-<platform>-<arch>.json
```

The local WAV fixture generator writes:

```text
release-v3/proofs/m2-local-wav-fixture-<platform>-<arch>.json
release-v3/fixtures/m2-real-whisper-fixture-<platform>-<arch>.wav
```

The top-level real Whisper orchestrator writes:

```text
release-v3/proofs/m2-real-whisper-proof-<platform>-<arch>.json
```

## Runtime Boundary

`transcription.runLocal` is the product command that will run local Whisper. It validates model id, language, recording id, and channel before touching audio. Model files are resolved only inside the core-owned local model store through `model_manager.rs` and are verified against trusted SHA-256 pins when the `local-whisper` feature is enabled. It also acquires the Rust-owned local model scheduler before running so future local LLM and embedding jobs cannot run concurrently with Whisper.

Default debug builds still do not claim real Whisper inference. They prove the
pathless transcription output contract and fail closed when built without the
feature. The release packaging script builds `candor-core` with `local-whisper`,
and `docs/proofs/M2_LOCAL_WHISPER_PREFLIGHT_PROOF.md` records the stricter
toolchain, feature-build, and local audio-prep test gate. Real model install,
real audio inference, and cross-OS installer proof are still separate release
requirements.

`npm run m2:transcription-proof-audit:real` is the stricter release-style gate.
It fails until the boundary proof artifact records a real `whisper-rs` run with
a verified local model, pathless model metadata, and positive written transcript
segments. It does not download models or substitute synthetic output for real
inference.

`npm run m2:real-whisper-proof` requires explicit operator consent through
`CANDOR_M2_REAL_WHISPER_CONSENT=1` or
`--i-understand-this-processes-local-audio` before it reads the supplied local
model or WAV fixture. The orchestrator runs input validation, the local Whisper
preflight, the release `candor-core` boundary smoke with `local-whisper`, and the
strict real audit. It does not download models. The core still streams the model
through `models.importStart`, `models.importChunk`, and `models.importFinish`,
writes the WAV fixture as durable local audio, and runs `transcription.runLocal`.
The proof artifacts record model id, model SHA-256, model bytes, WAV format,
duration, written segment count, and transcript segment count, but never record
the source file paths.

If `CANDOR_M2_REAL_AUDIO_WAV` is not set, the input preflight and real boundary
smoke use the repo-local fixture generated by `npm run m2:local-wav-fixture`
when it exists. The fixture proof marks whether it is speech generated by a
local OS speech engine or a fallback tone. Only the speech fixture should be
used as evidence for the later strict inference run.
