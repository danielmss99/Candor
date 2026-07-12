# M4 Real Local Instruct Proof

## Purpose

This is the strict quality gate for Candor's local llama.cpp recap and Ask path.
It requires a user-installed native llama.cpp binary and a real, hash-pinned
GGUF model. It does not download either asset.

The fixture proof validates process invocation and citation parsing. This proof
adds evidence that a real local model can produce useful, cited output from a
deterministic synthetic meeting transcript.

## Configuration

Set these environment variables to local files before running the strict gate:

```powershell
$env:CANDOR_LOCAL_LLM_BINARY = "C:\path\to\llama-completion.exe"
$env:CANDOR_LOCAL_LLM_MODEL = "C:\path\to\model.gguf"
$env:CANDOR_LOCAL_LLM_BINARY_SHA256 = (Get-FileHash $env:CANDOR_LOCAL_LLM_BINARY -Algorithm SHA256).Hash.ToLowerInvariant()
$env:CANDOR_LOCAL_LLM_MODEL_SHA256 = (Get-FileHash $env:CANDOR_LOCAL_LLM_MODEL -Algorithm SHA256).Hash.ToLowerInvariant()
$env:CANDOR_LOCAL_LLM_CONTEXT_TOKENS = "4096"
```

Current llama.cpp Windows releases use a small native launcher plus adjacent
implementation DLLs. `llama-completion` is preferred because it provides clean
one-shot stdout for Candor's pathless subprocess boundary. For a modular runner,
also configure the verified upstream distribution archive:

```powershell
$env:CANDOR_LOCAL_LLM_DISTRIBUTION_ARCHIVE = "C:\path\to\llama-windows-x64.zip"
$env:CANDOR_LOCAL_LLM_DISTRIBUTION_SHA256 = (Get-FileHash $env:CANDOR_LOCAL_LLM_DISTRIBUTION_ARCHIVE -Algorithm SHA256).Hash.ToLowerInvariant()
```

The proof rejects script fixtures, runners smaller than 4,096 bytes, invalid
PE/ELF/Mach-O headers, incomplete or malformed modular runtime libraries,
unverified modular distribution archives, models smaller than 1,000,000 bytes,
files without the `GGUF` signature, and configured SHA-256 mismatches. Every
required companion library is fingerprinted into the proof artifact.

## Commands

Run the strict real-model proof:

```powershell
npm run m4:real-local-instruct-proof
```

Record an explicit missing-prerequisite artifact without failing the command:

```powershell
npm run m4:real-local-instruct-proof:allow-missing
```

Exercise the deterministic quality checks without a model:

```powershell
npm run m4:real-local-instruct-proof:self-test
```

The allow-missing command never satisfies the strict gate. Its artifact has
`ok: false`, `prerequisiteMissing: true`, and
`strictRealModelSatisfied: false`. The command exits successfully only so an
audit pipeline can record the known gap.

The self-test is part of routine `npm run m4:verify`. It proves known-good
cited output passes, uncited or irrelevant output fails, and artifact path
redaction remains active. It does not count as real inference evidence.

## Quality Gate

The script starts `candor-core` over stdio JSON-RPC with an isolated data root,
seeds a synthetic four-segment meeting, and invokes both `ai.recapInstruct` and
`ai.askInstruct`.

Passing requires:

- a real native local binary and a real GGUF model
- a complete native runtime bundle, with an upstream archive SHA-256 when the
  entrypoint is a modular launcher
- a verified model SHA-256 pin
- no cloud AI, network attempt, download, or background download
- deleted temporary prompt files and no path exposure
- boundary-framed generated text, with llama.cpp banners and performance
  diagnostics excluded before the sensitive-path check
- an idle scheduler after each run with Whisper and LLM concurrency denied
- recap output with deterministic section, fact, and citation checks
- Ask output that answers the Priya validation question and cites segment `s1`
- citation verification accepts bare references such as `[s1]` and the richer
  transcript form `[s1 | 1600 ms | system | Priya]`, but resolves both against
  the core-owned segment list before returning evidence
- the Rust core grounds each factual claim using lexical overlap and speaker
  constraints, attaches the core-owned segment id, and removes unsupported
  claims before recap or Ask output reaches the renderer

The JSON artifact is written to:

```text
release-v3/proofs/m4-real-local-instruct-proof-<platform>-<arch>.json
```

The mission audit only accepts this artifact when
`strictRealModelSatisfied: true`, `realModel: true`, `realGguf: true`, and both
quality checks pass.

The `networkAttempted` field is core-level evidence. This M4 command does not
claim an OS firewall boundary, so it records `networkBoundaryVerified: false`.
OS-level zero-egress evidence remains the separate M0 network-deny gate.

## Windows Execution Record

The strict Windows x64 gate passed on 2026-07-11 with:

- llama.cpp `b9959` modular Windows CPU runtime
- distribution SHA-256
  `e7b44f74a8413b96fc79551cebae517d1f5371ca4aec28d40d0a5589db0783b0`
- `llama-completion.exe` SHA-256
  `0defc322616c9a4c6e8196c682cf136cda62fcde312c26e4a483643c3cbcfa25`
- Qwen2.5 1.5B Instruct Q4_K_M GGUF, 1,117,320,736 bytes
- model SHA-256
  `6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e`

The resulting artifact has `strictRealModelSatisfied: true`, passing recap and
Ask quality checks, verified source citations, no raw path exposure, no
inference-time network or download attempt, deleted prompt files, and an idle
post-run model scheduler.

## Boundary

This proof uses synthetic transcript text, not private meeting audio. It proves
real local recap and Ask inference. Embeddings and cross-meeting semantic search
remain a separate, intentionally later decision.
