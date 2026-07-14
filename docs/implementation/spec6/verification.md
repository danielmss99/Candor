# SPEC-6 local verification

Date: 2026-07-14
Branch: `codex/spec6-ai-release-completion`
Base: `9eaf4e220731127f7de601abf105bd0eab6342c1`

## Passing checks

| Check | Result |
|---|---|
| `cargo fmt --check` | passed |
| `cargo clippy --all-targets --all-features -- -D warnings` | passed |
| `cargo test --all-features` | 202 passed |
| default-feature Rust suite in `npm run v3:verify` | 183 passed |
| `npm test` | 169 passed across 44 files |
| `npm run electron:v3:typecheck-renderer` | passed |
| `npm run electron:v3:build-main` | passed |
| `npm run electron:v3:build-renderer` | passed |
| `npm run core:v3:release` | passed and staged the matching optimized sidecar |
| `npm run dist` | source-interface installer packaged successfully |
| `npm run m0:packaged-smoke` | passed against the rebuilt packaged runtime |
| `npm run spec3:packaged-ai-smoke` | passed with AI unavailable and no runtime download path |
| `npm run v3:release-artifact-smoke` | passed against the rebuilt Windows artifact |
| `npm run test:electron` | 5 passed, including axe and 125/150 percent scaling |
| GUI state matrix | 25 states across 5 viewports, 125 screenshots |
| `npm run audit:source:portable` | 168 checks and 11 mutation tests passed |
| `npm run v3:dependency-audit` | no npm or Rust vulnerabilities |
| `npm run release:publication-policy:self-test` | passed, including rejection at the exact 2 GiB boundary |
| `npm run release:publication-policy` | passed for current nonrelease artifacts |
| `node scripts/spec3-verify-ai-bundle.mjs --self-test` | passed |
| acquisition dry run for `large-v3-turbo` | exact URL, byte count, digest, temp path, and no release-state mutation verified |
| `npm run v3:verify` | passed all 13 repository proof stages |
| `git diff --check` | passed |

The v3 proof is written to `release-v3/proofs/v3-local-verification-win32-x64.json`.

The source-interface installer is rebuilt from the clean implementation commit before pull-request publication. Its exact size and SHA-256 are written to the generated release checksum and artifact proof files. It contains no release-selected Whisper or Qwen weights and is not a Complete release artifact. Its size must not be used as the expected size of either production AI profile.

`cargo audit` reports two allowed unmaintained transitive dependency warnings, `rustybuzz 0.20.1` and `ttf-parser 0.25.1`. It reports no vulnerability advisory. These dependencies remain tracked through the existing dependency-audit policy.

## Resolved verification findings

The first strict Clippy run found two style-only warnings in new Rust code. Both were corrected and Clippy then passed.

The first Rust suite run found a stale test expectation: a terminal task now reports 100 percent, while the test expected its earlier 50 percent snapshot. The test now synchronizes the worker and verifies both 50 percent while running and 100 percent when completed.

The first Electron run launched an older staged core sidecar and correctly entered recovery UI. Rebuilding with `npm run core:v3:release` aligned the packaged sidecar with the V3 contract, after which all Electron tests passed. The preload test was also updated to assert API version 3.

The final trust-boundary review removed transcript content from transcription task results, made completed task schemas exact and recursively sensitive-key aware, scrubbed persisted Ask questions from both descriptor and result retention paths, and allowed manually uploaded Candor-signed dictionaries to use the exact bundled publisher key when that key is present and valid.

The final self-review also removed the renderer's `local` and `quick` execution aliases so `local-llm` and `heuristic-fallback` now flow unchanged from React through Electron to Rust. Dictionary imports now check cancellation after encrypted staging reads and package verification, current-schema job stores reject legacy Base64 archive fields, and orphan cleanup covers interrupted temporary staging files.

The strict bundle verifier now requires every speech model in the selected package profile to have passed Candor benchmarks, approved redistribution review, pinned official provenance, exact bytes, digest, and license metadata. The selected language model must independently carry passed benchmarks, approved redistribution review, approved artifact provenance, bytes, digest, and license metadata. The pinned llama.cpp runtime must carry passed compatibility and approved redistribution evidence. Manifest assets must match their locked bytes, digest, and license.

The first aggregate V3 run correctly failed because an M3 source assertion still named the removed `local` renderer alias. The M3 and M4 proof assertions were updated to require `local-llm` and `heuristic-fallback`; the complete aggregate verifier then passed.

The final task-state audit found that `jobs.cancelAll` marked active workers as terminal before they had actually stopped. Active workers now remain in `cancelling` until worker acknowledgement changes them to `cancelled`; tasks without a worker can still terminate immediately. A deterministic Rust test covers both states.

The final progress audit removed legacy `model` and `asset` units from task producers. Internal stage counters are normalized to bounded percent values, and Electron rejects percentages above 100 or percent totals other than 100.

The release acquisition path now removes a complete but digest-invalid temporary model fragment before retrying from zero. Whisper `ggml-*.bin` model weights are explicitly ignored by Git in addition to the protected release staging directory.

The final renderer trust audit now preserves validated AI provenance in privacy-receipt parsing and displays the measured engine, fallback disclosure, prompt version, and generation time. Any signed dictionary that does not chain to the exact bundled Candor publisher key is shown as community-unverified, including future unknown trust labels. Cancelled background tasks now announce cancellation instead of incorrectly announcing that they need attention.

Acknowledging terminal dictionary work now returns its hidden staging token only inside the Rust process. The request handler deletes that encrypted payload immediately while the renderer-visible acknowledgement remains token-free. A Rust regression test covers the cleanup handoff.

Recap and Ask now perform a final cancellation check after generation and immediately before recording provenance. This prevents cancellation already observed at that boundary from recording a completed processing fact. The task manager also holds its worker registry lock through bulk cancellation state changes so a newly claimed worker cannot be reported as terminal before it stops.

Completed background work can no longer be retried. Retry is restricted to failed, cancelled, or paused work, while paused activity uses the user-facing `Resume` action instead of the ambiguous `Retry` label.

Dictionary display names are rejected when they contain control characters or leading or trailing whitespace at both the Electron and Rust trust boundaries. This prevents invisible names and log or interface control injection while keeping the persisted descriptor pathless.

Diagnostic AI provenance now bounds and validates its generation timestamp before export. Overlong or malformed values are dropped, while prompts, transcripts, and sensitive paths remain excluded.

The fallback disclosure was visually rechecked at 1366x768 with 125 percent scaling and at the 960x600 minimum viewport. Its title, explanation, and `Retry with Local AI` action remain distinct and nonoverlapping.

The final dictionary-security review reported no critical, high, or medium issues. Its two low observations were resolved with poisoned-lock-tolerant descriptor cleanup and exclusive encrypted job-store temp creation. Focused regressions cover both cases.

Renderer archive-byte import APIs were removed. Dictionary package selection now uses a sender-validated native file picker, and source-security mutation tests fail if archive bytes are reintroduced into the preload or renderer surface.

Dictionary cancellation, cancellation-all, worker failure, acknowledgement, startup retention, and migration rollback paths now delete encrypted staging before reporting successful cleanup. Retryable file deletion failures remain explicit, and active work cannot be acknowledged early.

The final full verification run passed Rust formatting, all-feature Clippy, 183 default Rust tests, 202 all-feature Rust tests, 169 Vitest tests, five Electron tests, axe, 125 screenshots, 168 source checks, 11 mutation checks, and all 13 `v3:verify` stages.

Claude's final review initially reported one latent medium maintenance hazard and three low observations. Before packaging, stage progress without a positive total was normalized to a wire-safe percent value, non-object AI results were rejected before provenance persistence, post-delete dictionary descriptor cleanup became infallible, and the renderer export request gained a concrete TypeScript type. Focused regressions and the complete verification matrix passed afterward.

## Expected strict failures

`npm run spec3:ai-bundle:verify:complete` and `npm run spec3:ai-bundle:verify:complete-max` both exit nonzero by design. Their failures confirm that release readiness, package profile, selected speech model, language runtime, selected language model, terminology data, publisher key, benchmarks, license approvals, and exact production bundle bindings remain absent.

`npm run release:publication-gate` also exits nonzero by design. Before the GitHub asset-size policy runs, it requires the strict V3 release-readiness audit, which currently records the missing signing, clean-machine, upgrade, real capture, real inference, duration, network, SBOM, bundled-AI, and hosted release evidence.

These failures are acceptance evidence for the fail-closed release boundary. They are not waived and do not indicate public release readiness.
