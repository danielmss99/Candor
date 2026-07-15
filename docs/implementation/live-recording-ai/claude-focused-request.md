# Focused Candor review

Review only the current uncommitted timer and development AI-bundle changes in these files:

- `crates/candor-core/src/capture_service.rs`
- `electron/core/runtime-schema.ts`
- `electron/core/runtime-schema.test.ts`
- `scripts/m1-capture-service-smoke.mjs`
- `scripts/install-development-ai-bundle.mjs`
- `scripts/spec3-verify-ai-bundle.mjs`
- `crates/candor-core/src/bundled_ai_assets.rs`
- `third_party/runtime-lock.json`

Do not run builds or tests. Inspect the files and relevant diff only.

The change adds measured `activeSession.durationMs` for a live recording and a Windows x64 development installer for exact pinned Whisper Turbo, multilingual Small, Qwen3 4B Q4_K_M, and llama.cpp assets. The installer must verify HTTPS source, exact bytes, SHA-256, safe ZIP names, all extracted files, non-strict bundle validity, and expected strict-release failure before atomic promotion. The installed bundle must remain `releaseReady:false`, and all payload/cache paths must remain out of Git.

Evidence already passing: real microphone timer probe, optimized build, 172 Vitest tests, 185 Rust tests, 7 Electron tests, accessibility, product smoke, and verifier self-tests.

Return only actionable findings ordered Critical, High, Medium, Low with exact file and line references. Focus on a defect that could break recording, accept a corrupt or unsafe asset, expose a path, lose an existing bundle, or claim false readiness. If there are no Critical or High findings, state that explicitly.
