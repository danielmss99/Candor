# M4 Heuristic Recap Proof

## Purpose

This proof covers the first local AI layer for Candor v3. It adds extractive,
heuristic meeting recap, action extraction, and per-meeting Ask before any local
LLM is required.

The service reads the durable transcript API through `recordingId`, then returns
summary, decision, action, risk, question, answer, and citation sections. It
does not accept raw file paths, does not call network APIs, and does not require
a model.

## Command

```powershell
npm run m4:heuristic-recap-smoke
```

The full M4 proof runs it too:

```powershell
npm run m4:verify
```

## Expected Result

The smoke script starts `candor-core` over stdio JSON-RPC with an isolated
`CANDOR_V3_DATA_DIR`, then verifies:

- `ai.status` reports `engine: heuristic-local`
- `ai.status` reports `cloudAi: false`
- `ai.status` reports `modelRequiredForHeuristics: false`
- `ai.recapHeuristic` extracts decisions, actions, risks, questions, and
  citations from a local durable transcript
- `ai.askHeuristic` answers a user question from transcript citations
- core-only `ai.proofHeuristicRecap` produces the same result from synthetic
  proof data
- core-only `ai.proofHeuristicAsk` produces a cited Ask answer from synthetic
  proof data
- no response leaks the data root, raw paths, or key material

Passing output:

```text
M4 heuristic recap smoke passed.
```

## Boundary

Implemented:

- `ai.status`
- renderer-safe `ai.askHeuristic`
- renderer-safe `ai.recapHeuristic`
- local instruct-model preflight is tracked separately in
  `M4_LOCAL_INSTRUCT_PREFLIGHT_PROOF.md`
- local instruct-model fixture invocation is tracked separately in
  `M4_LOCAL_INSTRUCT_FIXTURE_PROOF.md`
- strict real-model quality validation is tracked separately in
  `M4_REAL_LOCAL_INSTRUCT_PROOF.md`
- core-only `ai.proofHeuristicAsk`
- core-only `ai.proofHeuristicRecap`
- renderer panel for local recap
- renderer panel for per-meeting Ask
- renderer Fast mode and Quality-mode fallback when no instruct model is ready
- packaged smoke assertion that renderer-visible local AI status is pathless

The strict Windows real-model artifact now passes with a hash-pinned llama.cpp
runtime and Qwen2.5 1.5B Instruct GGUF model. Embeddings and cross-meeting
semantic search remain intentionally later work.
