# Candor live recording and bundled AI implementation review

Review the current uncommitted implementation in `C:\Claude_Config\candor` as a senior Electron, Rust, and local-AI security engineer.

## User-visible failures being fixed

1. A real microphone recording was durably written, but the live timer remained at zero because `capture.status.activeSession` omitted `durationMs`.
2. Candor reported that Local AI was not installed because `build/ai-bundle` contained no usable Whisper or llama.cpp assets.

## Scope to inspect

- `crates/candor-core/src/capture_service.rs`
- `electron/core/runtime-schema.ts`
- `electron/core/runtime-schema.test.ts`
- `electron/core/core-client.test.ts`
- `electron/test-core/controllable-core.mjs`
- `scripts/m1-capture-service-smoke.mjs`
- `scripts/install-development-ai-bundle.mjs`
- `scripts/spec3-verify-ai-bundle.mjs`
- `crates/candor-core/src/bundled_ai_assets.rs`
- `third_party/runtime-lock.json`
- `third_party/model-lock.json`
- `.gitignore`
- `package.json`

## Intended behavior

- `capture.status.activeSession.durationMs` is a measured, nonnegative, monotonically increasing integer while recording.
- Electron rejects malformed capture status responses before renderer state changes.
- The development installer is Windows x64 only and requires explicit acknowledgement.
- It downloads only immutable, pinned HTTPS assets, enforces exact byte size and SHA-256, validates ZIP entry names, extracts only the pinned llama CLI and companion DLLs, stages the complete bundle, verifies it, then atomically promotes it.
- It installs Whisper `large-v3-turbo` as Balanced, multilingual `small` as fallback, official Qwen3 4B Q4_K_M, and pinned llama.cpp.
- It never marks this local workstation bundle release-ready. Non-strict verification must pass and strict release verification must fail closed.
- Download cache, partial files, model weights, and runtime binaries remain ignored by Git.
- No runtime download, renderer-selected executable, Ollama dependency, or localhost inference server is introduced.

## Evidence already run

- Full optimized application build passed.
- Full Vitest suite passed: 172 tests in 45 files.
- Full Rust suite passed serially: 185 tests.
- Focused timer and bundle tests passed.
- Real microphone smoke passed: 1.5 seconds, 7 durable chunks, active timer reported 506 ms, finalized state `finished`.
- Electron Playwright suite passed: 7 tests, including accessibility and desktop scaling.
- Product surface smoke and AI bundle verifier self-test passed.

## Review format

Return findings first, ordered Critical, High, Medium, Low. Include exact file and line references. Focus on correctness, security, data safety, fail-closed release behavior, TOCTOU risks, archive extraction safety, model/runtime discovery, timer semantics, and missing tests. Do not spend space on unrelated GUI changes already in the worktree.

If there are no Critical or High findings, state that explicitly. Distinguish release blockers requiring external signing or hardware evidence from defects in this code.
