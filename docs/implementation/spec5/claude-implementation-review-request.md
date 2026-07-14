# Claude implementation review request: SPEC-5

Date: 2026-07-14

## Review role

Perform an adversarial code review of the uncommitted working tree in `C:\Claude_Config\candor`. Codex owns all edits and will validate each finding. Do not edit files. Do not assume passing tests prove data safety.

Prioritize correctness, security, capture safety, restart semantics, trust claims, privacy, regressions, missing tests, and deviations from the accepted plan. Report findings first, ordered by severity. Every finding must include:

- severity: critical, high, medium, or low;
- exact file and tight line range;
- observed evidence;
- concrete failure scenario;
- recommended fix;
- whether a focused rereview is required.

Clearly separate defects from optional improvements. State explicitly if no actionable defect is found in an area.

## Governing objective

Advance Candor toward a release-ready local-only Electron and Rust meeting recorder without weakening durable capture, encrypted local storage, sandboxing, privacy claims, or fail-closed release gates.

## Accepted plan and status

Read:

- `docs/implementation/spec5/implementation-plan.md`
- `docs/implementation/spec5/acceptance-status.md`
- `docs/implementation/spec5/verification.md`
- `docs/implementation/spec5/claude-plan-review.md`

The supplied ZIP contains specifications only. No production Whisper model, GGUF model, dictionary package, signing key, or trusted installer was added. Strict Standard and Maximum Accuracy package commands must continue to fail before packaging.

## Implemented areas

### Persistent Rust jobs

- `crates/candor-core/src/job_manager.rs`
- `crates/candor-core/src/background_jobs.rs`
- `crates/candor-core/src/main.rs`

The job store is an encrypted atomic snapshot derived from Candor's OS-backed key material. Descriptor-backed transcription, recap, Ask, export, dictionary import, and dictionary indexing recover after restart. States include queued, running, paused, cancelling, completed, failed, and cancelled. Recording priority preempts restartable inference. Successful verified durable stop queues transcription, which chains a fast recap.

Review especially:

1. cancellation followed by close and restart;
2. duplicate follow-up recap creation;
3. persistence corruption and interrupted writes;
4. recording priority release on every start/stop/recovery branch;
5. deterministic scheduling and starvation;
6. whether questions, transcript content, results, or paths can escape logs/events or plaintext storage;
7. races among cancel, completion, retry, pause, and acknowledgement;
8. whether a failed queue operation can affect durable stop.

### Signed dictionaries

- `crates/candor-core/src/dictionary_package.rs`
- `crates/candor-core/src/terminology_dictionary.rs`
- `electron/ipc/terminology-ipc.ts`
- `electron/security/validate-dictionary-package-input.ts`
- `v3/renderer/src/features/terminology/`

The `.candordict` archive permits exactly `manifest.json`, `terms.jsonl`, `LICENSE.txt`, and `signature.json`. Rust enforces path, symlink, count, size, ratio, UTF-8, schema, digest, Ed25519 signature, and minimum Candor version constraints. Drag-and-drop sends bounded bytes through a narrow IPC method and never exposes a filesystem path to the renderer. Unknown self-signed packages are labelled `Community pack - unverified`; only a bundle already verified by Candor's asset manifest is labelled `Verified by Candor`.

Review especially:

1. ZIP parser ambiguities and archive-bomb bypasses;
2. time-of-check/time-of-use and duplicate-name behavior;
3. signature canonicalization and whether integrity is confused with identity;
4. content or key exposure through status/events/errors;
5. idempotency and package version updates;
6. whether original transcript text and decisions remain preserved;
7. whether pharmaceutical, numeric, concentration, dosage, or unit changes can auto-apply.

### Electron and renderer

- `electron/ipc/jobs-ipc.ts`
- `electron/preload.cts`
- `electron/window/capture-close-guard.ts`
- `v3/renderer/src/features/jobs/BackgroundActivity.tsx`
- `v3/renderer/src/features/startup/useRuntimeStatus.ts`
- `v3/renderer/src/components/DesktopShell.tsx`

Review especially:

1. exact preload surface and renderer-controlled input validation;
2. close choices during capture and during jobs;
3. cancel-all versus pause-all semantics;
4. stale renderer updates after navigation or reload;
5. accessibility, focus, details-panel behavior, and sensitive copy;
6. raw job data or meeting content accidentally reaching notifications.

### Packaging and identity

- `package.json`
- `third_party/model-lock.json`
- `scripts/spec3-verify-ai-bundle.mjs`
- `scripts/verify-product-identity.mjs`

Review that Standard includes Turbo, Small, one selected LLM, and terminology only when real assets are present; Maximum adds full Large; incomplete source-interface builds cannot be confused with Standard; product version 0.4.0 stays consistent; and no code path can turn pending assets into release-ready claims.

## Verification evidence before review

- Rust format: passed.
- Rust clippy with `-D warnings`: passed.
- Rust tests: 144 passed.
- Vitest: 155 passed across 42 files.
- Renderer typecheck: passed.
- Full Electron build: passed.
- Electron, axe, scaling, and visual tests: 5 passed.
- GUI evidence: 24 states across 5 desktop configurations, 120 screenshots.
- Source security: 138 checks and 7 mutation tests passed.
- Architecture and product identity checks: passed.
- AI verifier self-test and source-interface verification: passed.
- Standard and Maximum package commands: expected fail-closed result because production assets/evidence are absent.
- `git diff --check`: passed.

## Known external blockers, not source defects

- Production Turbo, Small, Qwen, and general dictionary files.
- Final LLM conversion, quality benchmark, legal, and redistribution approval.
- Production publisher and installer keys.
- Physical capture, duration, inference-load, sleep/resume, device-switch, and hardware-tier evidence.
- Signed clean-machine install and upgrade receipts.

Do flag source code that falsely claims those blockers are complete or makes bypassing them possible.
