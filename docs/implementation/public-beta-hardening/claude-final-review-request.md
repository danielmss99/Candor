# Final Claude Review Request

## Objective

Perform an adversarial final source review of Candor's approved Windows public
beta hardening. Codex remains responsible for implementation and verification.
Do not edit files. Do not treat absent external receipts as source defects.

The working tree also contains an ongoing user-owned quiet-workspace redesign.
Exclude unrelated layout and styling changes unless they directly interact with
the hardening behavior listed below.

## Accepted Scope

1. Require an exact verified local-LLM model ID, model SHA-256, and runtime
   SHA-256. Missing, renderer-supplied, stale, or changing identity must fail.
2. Persist the user fallback preference as `ask-first | automatic | never`,
   defaulting to Ask First. Cancellation, shutdown, and recording-priority
   preemption must never cause heuristic fallback.
3. Preserve a prior result when **Retry with Local AI** fails.
4. Require the pinned `llama-completion` frontend, private prompt transport,
   exact recap/Ask JSON schemas, source-ID grounding, cancellation, and path
   redaction. Reject legacy `llama-cli` execution.
5. Prioritize failed background tasks, aggregate simultaneous terminal
   announcements, and make Cancel All target only queued, running, and paused
   states.
6. Distinguish OpenAI model publishing from the pinned canonical whisper.cpp
   artifact source and revision.
7. Make Windows public packaging fail closed without Azure Trusted Signing,
   include the Rust sidecar in executable signing, and keep credentials out of
   generated configuration.
8. Keep clean-machine, hardware, endurance, signing, and publication gates
   visibly incomplete until real receipts exist.

## Primary Files

### Rust

- `crates/candor-core/src/ai_fallback_preference.rs`
- `crates/candor-core/src/background_jobs.rs`
- `crates/candor-core/src/bundled_ai_assets.rs`
- `crates/candor-core/src/job_manager.rs`
- `crates/candor-core/src/local_instruct_model.rs`
- `crates/candor-core/src/main.rs`

### Electron And Renderer

- `electron/core/background-task.ts`
- `electron/core/operation-registry.ts`
- `electron/core/runtime-schema.ts`
- `electron/preload.cts`
- `electron/security/validate-core-input.ts`
- `electron/security/validate-private-core-input.ts`
- `v3/renderer/src/core/contracts.ts`
- `v3/renderer/src/features/jobs/BackgroundActivity.tsx`
- `v3/renderer/src/features/local-ai/useLocalAiWorkspace.ts`
- `v3/renderer/src/features/settings/SettingsView.tsx`

### Packaging And Provenance

- `electron-builder.release.cjs`
- `scripts/windows-release-signing-config.cjs`
- `scripts/spec6-release-signing-config.mjs`
- `scripts/spec3-verify-ai-bundle.mjs`
- `scripts/install-development-ai-bundle.mjs`
- `third_party/model-lock.json`
- `third_party/runtime-lock.json`

### Evidence

- `docs/implementation/public-beta-hardening/implementation-plan.md`
- `docs/implementation/public-beta-hardening/verification.md`
- `docs/implementation/public-beta-hardening/external-gates.md`
- `release-v3/proofs/m4-real-local-instruct-proof-win32-x64.json`

Do not scan model weights, `node_modules`, `target`, generated unpacked apps, or
the full `build` tree.

## Verification Completed

- Rust format and strict Clippy passed.
- Rust tests: 190 default-feature and 209 all-feature tests passed.
- Vitest: 174 tests across 45 files passed.
- Renderer typecheck, Electron main build, renderer production build passed.
- Playwright Electron and axe: 7 tests passed.
- Full `npm run v3:verify` passed.
- Real pinned Qwen3 4B Q4_K_M recap and Ask proof passed through the release Rust
  core and `llama-completion` runtime with strict grounding.
- `npm run electron:v3:build` passed.
- Source SPDX SBOM generated and verified.
- npm and Cargo audits found no known vulnerabilities.
- Strict public asset, signing-environment, readiness, and clean-checksum gates
  failed closed as documented.

## Prior Focused Review Disposition

- The prior review found no critical or high issues.
- Its low staging deletion race was checked against the implementation:
  `DictionaryStaging::delete` already treats a missing file as success.
- Its legacy-descriptor observation was hardened: a missing fallback policy now
  defaults to requiring the local LLM. Explicit recognized legacy quality
  descriptors retain disclosed fallback for compatibility.
- Legacy CLI flags are unreachable because the frontend guard rejects
  `llama-cli` before spawn. Removing those constants is optional cleanup.

## Required Review Output

Lead with findings ordered by severity: critical, high, medium, low. For every
observed defect include exact file and line references, concrete evidence,
impact, and the smallest safe fix. Separate actual defects from optional
improvements and external release blockers.

Answer these questions explicitly:

1. Can any successful local-LLM result carry an inexact or stale identity?
2. Can Ask First, Never, strict retry, cancellation, shutdown, or recording
   preemption violate the intended fallback policy?
3. Can malformed or ungrounded Qwen output escape the Rust, Electron, or
   renderer validators?
4. Can failed tasks be hidden, terminal announcements be lost, or Cancel All
   target a non-cancellable state?
5. Can a public Windows package be built unsigned, omit sidecar signing, or
   serialize a credential?
6. Do provenance and external-gate documents state only what current evidence
   supports?
7. Are any critical or high issues still required before source-level closure?
