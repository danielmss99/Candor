# SPEC-6 baseline

Date: 2026-07-14

## Source

- Branch: `codex/spec6-ai-release-completion`
- Base: `9eaf4e220731127f7de601abf105bd0eab6342c1`
- Handoff: `CANDOR_CODEX_SPEC6_AI_RELEASE_COMPLETION_HANDOFF.zip`
- Handoff SHA-256: `F1A9263A806536040847156D6AC0C82093690F00A7A54C102B75C64AD7565576`
- Previous work: PR #10 is merged into remote `main`.

## Baseline verification

| Command | Result |
|---|---|
| `npm test -- --reporter=dot` | PASS, 155 tests in 42 files |
| `node scripts/cargo-with-local-perl.mjs test --manifest-path crates/candor-core/Cargo.toml --quiet` | PASS, 150 tests |
| `npm run electron:v3:typecheck-renderer` | PASS |
| `npm run test:electron` | PASS, 5 Playwright tests including axe and visual evidence |
| `npm run spec3:ai-bundle:verify:self-test` | PASS |
| `npm run v3:verify-main-architecture` | PASS |
| `npm run v3:identity:verify` | PASS, version 0.4.0 |
| `npm run spec3:ai-bundle:verify:complete` | EXPECTED FAIL, release assets and evidence are absent |

## Confirmed gaps

- Automatic transcription follow-up queues recap through the old fast quality path, which resolves to heuristic output.
- Recap and Ask do not return a complete typed execution provenance contract.
- Electron job event validation omits paused, cancelling, and dictionary task types.
- Renderer background activity treats all nonterminal tasks as running and can show ETA outside a running state.
- Dictionary job descriptors persist full Base64 archives.
- Dictionary selection has no fixed scope precedence or deterministic complete tie-break order.
- Organization trust labels are not anchored to a separately bundled Candor publisher public key.
- Standard asset locks contain candidates, but the bundle manifest remains source-interface only and `releaseReady` is correctly false.

## External blockers

- Production model files, llama.cpp runtime artifact, general dictionary, and publisher public key are absent.
- Redistribution approval, hardware benchmarks, real capture evidence, long-duration evidence, signing, clean-machine install, and upgrade receipts are absent.
- These remain fail-closed and must not be represented as completed by source changes.
