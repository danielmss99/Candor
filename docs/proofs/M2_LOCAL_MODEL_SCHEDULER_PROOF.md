# M2 Local Model Scheduler Proof

## Purpose

This proof covers the Rust-owned local model scheduler. The scheduler is the
shared gate for local Whisper, future local LLM recap or Ask jobs, and later
embedding jobs.

Candor must never run Whisper and LLM inference at the same time. The scheduler
therefore allows one local model job at a time and reports RAM and VRAM budgets
as core facts. Renderer-visible status is pathless and does not expose model
paths, vault paths, key material, or process authority.

## Command

```powershell
npm run m2:local-model-scheduler-smoke
```

The full M2 proof runs it too:

```powershell
npm run m2:verify
```

## Expected Result

The smoke script starts `candor-core` over stdio JSON-RPC with an isolated
`CANDOR_V3_DATA_DIR`, then verifies:

- `ai.schedulerStatus` reports `singleLocalModelJob: true`
- `ai.schedulerStatus` reports `whisperLlmConcurrent: false`
- scheduler RAM and VRAM budget facts are present
- `ai.proofSchedulerBusy` starts a synthetic Whisper job and denies a synthetic
  LLM job with `LOCAL_MODEL_JOB_ACTIVE`
- the scheduler is idle after the proof
- `transcription.status` reports the same shared scheduler facts
- no response leaks the data root, raw paths, or key material

Passing output:

```text
M2 local model scheduler smoke passed.
```

## Boundary

Implemented:

- `ai.schedulerStatus`
- core-only `ai.proofSchedulerBusy`
- shared scheduler use by `transcription.runLocal`
- packaged smoke assertion that renderer-visible scheduler status is pathless

Still pending:

- local LLM recap and Ask jobs wired into the same scheduler
- embedding jobs wired into the same scheduler
- user-configurable RAM or VRAM budgets
