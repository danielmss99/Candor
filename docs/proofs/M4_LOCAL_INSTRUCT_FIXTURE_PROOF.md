# M4 Local Instruct Fixture Proof

## Purpose

This proof covers the local instruct-model invocation path for recap and Ask. It
uses a temporary local fixture executable and a temporary local GGUF placeholder
so the test can run without downloading a model or recording private audio.

This is not a real model quality proof. It proves the core can:

- verify local binary and model configuration
- reserve the shared LLM scheduler lane
- build prompts from durable transcript records
- pass prompts through a local temporary prompt file
- launch only a local executable
- parse bracketed transcript citations from output
- delete the prompt file after the run
- return pathless renderer-facing results
- expose only typed instruct status, recap, and Ask methods through Electron
- render a Quality/Fast mode with explicit fallback and cited model output

## Command

```powershell
npm run m4:local-instruct-fixture
```

The full M4 proof runs it too:

```powershell
npm run m4:verify
```

## Expected Result

The smoke script starts `candor-core` over stdio JSON-RPC with an isolated
`CANDOR_V3_DATA_DIR`, `CANDOR_LOCAL_LLM_BINARY`, `CANDOR_LOCAL_LLM_MODEL`, and
`CANDOR_LOCAL_LLM_MODEL_SHA256`. Then it verifies:

- `ai.instructStatus` reports `ready: true` for the fixture
- `ai.instructStatus` reports `generationImplemented: true`
- `ai.recapInstruct` invokes the local fixture executable
- `ai.askInstruct` invokes the same local fixture executable
- both results report `localOnly: true` and `cloudAi: false`
- both results report `networkAttempted: false`
- both results report `downloadsAttempted: false`
- both results return citations parsed from `[s0]` style output
- both results delete the local prompt file after execution
- no response leaks the data root, fixture paths, model paths, raw paths, or key
  material
- Electron main, preload, renderer API types, and the workspace all expose the
  same three typed instruct methods
- the renderer has keyboard-accessible Quality/Fast mode controls, explicit
  fallback status, and cited Markdown output rendering

Passing output:

```text
M4 local instruct fixture passed. Proof written to ...
```

The JSON artifact is written to:

```text
release-v3/proofs/m4-local-instruct-fixture-<platform>-<arch>.json
```

## Boundary

Implemented:

- `ai.recapInstruct`
- `ai.askInstruct`
- local prompt-file transport
- scheduler-backed local LLM execution
- local fixture recap and Ask proof
- bracketed citation parsing from local model output
- typed Electron and preload renderer bridge
- Quality mode with model-unavailable heuristic fallback
- pathless cited model result rendering

Still pending:

- strict proof with a real llama.cpp binary and real local GGUF model, tracked
  by `M4_REAL_LOCAL_INSTRUCT_PROOF.md`
- quality validation for local model recap and Ask output, enforced by that
  strict proof
- embeddings and cross-meeting semantic search
