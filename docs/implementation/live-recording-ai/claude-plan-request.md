# Candor Live Recording and Local AI Repair Review

## Objective

Review the proposed repair for two user-observed problems in the current Electron development build:

1. A real microphone recording writes durable encrypted audio chunks, but the live timer remains at zero.
2. Candor reports that the LLM is not installed because this checkout contains only AI lock files and an empty bundle manifest.

Codex remains responsible for all repository edits and verification. Provide an independent architecture and security review only.

## Repository State

- Workspace: `C:\Claude_Config\candor`
- Branch: `codex/quiet-workspace-redesign`
- Existing unrelated redesign changes must be preserved.
- Active architecture: sandboxed Electron renderer, allowlisted preload, Electron main process, versioned JSONL, Rust core.
- Current AI bundle root: `build/ai-bundle`
- Current bundle manifest has `releaseReady: false` and no assets.
- Model files and `build/ai-bundle` are ignored by Git.

## Observed Evidence

- The latest user recording produced encrypted `.cchunk` files and a finished recording manifest under the core-owned local data root.
- `capture.status.activeSession` exposes `startedAtMs` but not `durationMs`.
- The renderer reads `activeSession.durationMs`, so the timer cannot advance.
- The current source pins these official assets:
  - Whisper multilingual `small`, SHA-256 and byte count locked.
  - Whisper `large-v3-turbo`, SHA-256 and byte count locked.
  - Official Qwen3-4B-GGUF Q4_K_M, SHA-256 and byte count locked.
  - llama.cpp tag `b9637`, commit `aedb2a5e9ca3d4064148bbb919e0ddc0c1b70ab3`.
- GitHub's official b9637 Windows CPU x64 archive is `llama-b9637-bin-win-cpu-x64.zip`, 16,906,751 bytes, SHA-256 `f7783c2b8c007f95e710ac40f26a24861a80b603b0b739fc54d7c926a4716c1e`.

## Proposed Implementation

### Recording timer

- Add measured `durationMs = now_ms() - started_at_ms` to the Rust `capture.status.activeSession` object.
- Keep `startedAtMs` for recovery and diagnostics.
- Add a Rust test that proves duration is present and monotonic while active.
- Keep the renderer's existing one-second active-capture polling.

### Development Local AI installation

- Add an explicit operator-only script, never called by the app at runtime.
- Require an acknowledgement flag before network acquisition.
- Download only immutable, locked HTTPS artifacts.
- Support resumable model downloads with temporary files, exact byte checks, SHA-256 checks, and atomic promotion.
- Download and verify the pinned official llama.cpp Windows archive, then extract the CPU runtime and required sibling libraries.
- Download upstream license and model-card notices.
- Generate a non-fixture development manifest with all runtime dependencies hash-pinned.
- Keep `releaseReady: false` and a development-only selection status. This must not satisfy strict release verification.
- Use `large-v3-turbo` as the first speech model and include multilingual `small` as the lower-resource fallback.
- Use official Qwen3-4B Q4_K_M for local recap and Ask.
- Never commit model weights, runtime binaries, private keys, or generated build assets.

## Non-Negotiable Constraints

- No runtime model downloader in Electron or Rust.
- No cloud AI, Ollama, localhost inference server, or renderer-selected executable path.
- No fabricated benchmark, signing, hardware, licensing, or release receipts.
- Public release readiness remains false.
- Existing recordings remain readable during all failures.
- A failed asset install must leave the previous verified bundle intact.
- Do not weaken the preload allowlist, model digest verification, path containment, or sandbox.

## Acceptance Checks

- A real microphone recording visibly advances the timer and writes durable chunks.
- The development bundle verifier accepts the installed files in non-release mode.
- Strict release verification still fails closed.
- Candor reports verified speech and language assets after restart.
- Whisper can transcribe a local test recording.
- Qwen can produce one local recap through the pinned llama.cpp runtime.
- No network connection is required after installation.
- Focused Rust, TypeScript, Electron, security, and product-surface checks pass.

## Review Request

Return:

1. A refined implementation plan.
2. Required changes versus optional improvements.
3. Security and data-safety failure modes.
4. Tests and acceptance checks that are missing.
5. Any concern with using a non-release development manifest whose files are verified but whose release evidence remains incomplete.
