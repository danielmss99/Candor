# Claude Plan Request: SPEC-3 Bundled Local AI

Act as an independent architecture, supply-chain, security, and release reviewer.
Do not edit the repository. Inspect the current branch in
`C:\Claude_Config\candor` and refine the implementation plan for the user-provided
`SPEC-3-Candor-Bundled-Local-AI-Release` handoff.

## Objective

Move Candor from user-imported local models toward a zero-setup offline package:

```text
Install Candor
-> Record
-> Transcribe locally
-> Generate a source-linked local recap
```

The architecture must remain Electron renderer -> exact preload API -> Electron
main -> versioned JSONL RPC -> Rust core. Recordings must remain accessible when
AI assets are missing, corrupt, incompatible, or unlicensed.

## Existing repository evidence

- Branch: `codex/bundled-local-ai`, based on reviewed commit
  `adfe573b15e89add9345b53da463d5902487335a`.
- `crates/candor-core/src/transcription_service.rs` already performs local
  transcription through `whisper-rs`, which directly integrates whisper.cpp.
- `crates/candor-core/src/model_manager.rs` already hash-verifies managed Whisper
  model imports and maintains a verification cache.
- `crates/candor-core/src/local_instruct_assets.rs` already imports and verifies a
  local llama runner and GGUF model under the data directory.
- `crates/candor-core/src/local_instruct_model.rs` directly spawns a verified
  executable with `Command`, bounded output, fixed arguments, and no shell or HTTP.
- Existing async jobs provide cancellation and renderer-reload recovery.
- Existing `LocalModelScheduler` serializes Whisper and LLM work.
- The renderer and preload already use an exact product-domain API rather than a
  generic invoke bridge.
- `electron-builder.v3.yml` currently packages only `candor-core` as an extra
  resource.
- `scripts/v3-release-sbom.mjs` inventories npm and Cargo locks but not bundled
  runtime/model assets.
- Current normal and Advanced Settings UI still assumes user-imported model
  setup in some paths.

## Handoff non-negotiables

- No Python, Ollama, LM Studio, developer tools, HTTP model server, shell spawn,
  or first-run download for required baseline features.
- Trusted packaged paths and allowlisted arguments only.
- Build-time and first-use SHA-256 verification.
- Missing or corrupt AI assets disable only affected AI features.
- Repair must not delete or lock recordings.
- Runtime paths, hashes, GGUF, and runner terminology stay out of normal UI.
- Licenses, notices, model cards, provenance, and SBOM entries are required.
- Recording and finalization outrank inference.
- A default LLM cannot be selected until redistribution, quantization provenance,
  hardware performance, and meeting-quality evidence are documented.

## Current hard limits

The ZIP contains specifications and example manifests, not runtime binaries or
model weights. This machine cannot prove 8/16/32 GB hardware tiers, macOS/Linux
signing, clean-machine offline installation, or 5/30/60/180-minute physical
sessions in a single source-only implementation pass. Do not recommend fake
hashes, placeholder assets presented as ready, or an unreviewed default LLM.

## Decisions to refine

1. Should Whisper remain direct `whisper-rs` integration with only the model file
   packaged, while runtime provenance is recorded from locked Cargo sources?
2. What shared bundled-asset manifest and Rust resolver should replace normal
   user-import setup without exposing paths to the renderer?
3. How should development fixtures differ from production manifests so synthetic
   files can never be reported as a release-ready bundle?
4. Which protocol operations, preload methods, renderer states, packaging checks,
   SBOM records, and corruption tests are required now?
5. What exact gates must stay blocked until real candidate binaries, licensing,
   benchmarks, signing, and clean-machine evidence exist?
6. How should a future signed installer repair be represented without adding an
   updater or network path in this phase?

## Requested output

Provide:

1. A phase-aligned implementation plan grounded in the current files.
2. Required changes versus optional improvements.
3. Assumptions and unresolved questions.
4. Likely correctness, security, packaging, and data-safety failure modes.
5. Focused tests and acceptance checks.
6. A conservative completion boundary for this source implementation wave.

Do not select a default LLM or claim release readiness. End with a clear plan
verdict.
