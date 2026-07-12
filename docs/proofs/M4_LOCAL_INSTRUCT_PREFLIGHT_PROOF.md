# M4 Local Instruct Preflight Proof

## Purpose

This proof covers the first guarded lane for a local llama.cpp-compatible
instruct model. It proves the core can inspect local-only configuration, refuse
cloud fallback, refuse background downloads, and reserve the local LLM scheduler
lane without exposing raw paths.

## Command

```powershell
npm run m4:local-instruct-preflight
```

Strict readiness mode requires a configured local binary and GGUF model:

```powershell
npm run m4:local-instruct-preflight:strict
```

The full M4 proof runs the non-strict preflight too:

```powershell
npm run m4:verify
```

## Configuration

The core reads only local configuration from environment variables:

- `CANDOR_LOCAL_LLM_BINARY`: local llama.cpp-compatible executable
- `CANDOR_LOCAL_LLM_MODEL`: local GGUF model file
- `CANDOR_LOCAL_LLM_MODEL_SHA256`: optional expected SHA-256 for the model
- `CANDOR_LOCAL_LLM_CONTEXT_TOKENS`: optional context budget

Renderer-facing responses show which variables are supported, but never return
their raw values.

## Expected Result

The smoke script starts `candor-core` over stdio JSON-RPC with an isolated
`CANDOR_V3_DATA_DIR`, then verifies:

- `ai.instructStatus` reports `localOnly: true`
- `ai.instructStatus` reports `cloudAi: false`
- `ai.instructStatus` reports `downloadPolicy: manual-install-only`
- `ai.instructStatus` reports `backgroundDownloads: false`
- `ai.instructStatus` reports `generationImplemented: true`
- `ai.proofInstructPreflight` attempts no network and no downloads
- `ai.proofInstructPreflight` reserves and releases the LLM scheduler lane
- `ai.proofInstructPreflight` keeps `whisperLlmConcurrent: false`
- `core.capabilities` exposes only the allowlisted instruct preflight methods
- no response leaks the data root, configured model paths, raw paths, or key
  material

Passing output:

```text
M4 local instruct preflight passed. ready=false proof=...
```

The non-strict proof may pass with `ready=false`; that is intentional. It proves
Candor fails closed until a user supplies local model assets. Strict mode is the
future gate for a real local instruct setup.

## Boundary

Implemented:

- `ai.instructStatus`
- `ai.proofInstructPreflight`
- `ai.recapInstruct`
- `ai.askInstruct`
- optional local GGUF SHA-256 verification
- pathless renderer-facing configuration status
- scheduler proof that LLM work cannot run beside Whisper work
- JSON proof artifact under `release-v3/proofs/`

Still pending:

- strict proof with a real llama.cpp binary and real local GGUF model
- embeddings and cross-meeting semantic search
