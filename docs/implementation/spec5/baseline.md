# SPEC-5 baseline

Date: 2026-07-14

## Source

- Branch: `codex/background-ai-and-dictionaries`
- Base: `223d1d6ef660c76a045acc56936a3b3ef0d15fb6`
- Handoff: `CANDOR_CODEX_POST_AI_REVIEW_HANDOFF.zip`
- Handoff SHA-256: `2482AB10D22BEDFDE8D09C88EC3C4C59EFADAC686FC7B39BEFBB4BDFB88B2F8C`
- Previous AI work: PR #9 is merged into `origin/main`.

## Baseline verification

| Command | Result |
|---|---|
| `npm test -- --reporter=dot` | PASS, 147 tests in 40 files |
| `npm run electron:v3:typecheck-renderer` | PASS |
| `node scripts/cargo-with-local-perl.mjs test --manifest-path crates/candor-core/Cargo.toml --quiet` | PASS, 132 tests |
| `npm run spec3:ai-bundle:verify:self-test` | PASS |
| `npm run v3:verify-main-architecture` | PASS |
| `npm run v3:identity:verify` | PASS, version 0.4.0 |

## Existing foundations

- Fast, Balanced, and Maximum Whisper tiers are represented in `third_party/model-lock.json`.
- Standard already excludes full `large-v3`; the selected LLM remains deliberately blocked pending provenance, conversion, redistribution review, and benchmarks.
- The Rust core has cancellable in-memory jobs with typed Electron operations and `jobs.changed` events.
- Terminology dictionaries are encrypted at rest, bounded, automatically supplied to Whisper and the local LLM, and never auto-apply corrections.
- Capture finalization is durable before the renderer reports a saved recording.

## Confirmed gaps

- Jobs do not survive a Rust core or application restart.
- Job states do not include paused or cancelling as first-class persisted states, and retry is not implemented.
- Capture stop does not automatically queue transcription and recap.
- Inference is serialized but does not yield to recording through an explicit priority policy.
- There is no global Background Activity panel, completion notification lifecycle, or explicit close policy for active jobs.
- Dictionary import accepts bounded text formats but not signed data-only `.candordict` packages.
- Real model files, LLM selection approval, hardware evidence, signing, and clean-machine release receipts remain unavailable and must stay fail-closed.
