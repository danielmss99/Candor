# SPEC-5 verification

Date: 2026-07-14

## Passing checks

| Check | Result |
| --- | --- |
| `cargo fmt -- --check` | Passed |
| `cargo clippy --all-targets -- -D warnings` | Passed |
| `cargo test` | 148 passed |
| `npm test` | 155 passed across 42 files |
| `npm run electron:v3:typecheck-renderer` | Passed |
| `npm run electron:v3:build` | Passed, including release Rust core and production renderer |
| `npm run test:electron` | 5 passed, including sandbox, preload, accessibility, scaling, and GUI evidence |
| `npm run v3:source-security-proof:self-test` | 138 checks and 7 mutation tests passed |
| `npm run v3:source-security-proof` | Passed |
| `npm run v3:verify-main-architecture` | Passed |
| `npm run v3:identity:verify` | Passed at product version 0.4.0 |
| `npm run v3:verify` | Passed all staged M0 through M5 checks and wrote the local verification proof |
| `npm run v3:dependency-audit` | Passed with 0 npm vulnerabilities and 0 Rust security vulnerabilities; two allowed unmaintained transitive warnings remain |
| `npm run spec3:ai-bundle:verify:self-test` | Passed |
| `npm run spec3:ai-bundle:verify` | Source-interface verification passed |

## GUI evidence

The Playwright matrix covers 24 states across five desktop viewport and scaling configurations, for 120 screenshots. The added `background-activity` state was inspected at 1440×900, 1366×768, 150% scaling, and the 960×600 minimum. Its first screenshot exposed a missing semantic text token in the light popover; the corrected screenshot now has readable headings, progress, estimates, and controls.

Evidence is generated under:

```text
release-v3/proofs/gui-state-matrix/
release-v3/proofs/gui-state-matrix.json
```

## Expected release-gate failures

`npm run package:standard` and `npm run package:maximum-pack` both fail before Electron Builder runs. The verifier reports the absent release-ready profile, speech assets, llama runtime, selected language model, terminology asset, benchmark evidence, and redistribution approval. This is the required result for the current source-interface build.

The verifier self-test also proves that a Maximum Accuracy-only speech model is rejected from the Standard profile.

## Claude review

Two authenticated focused reviews completed successfully. Claude reported one high, three medium, and two low findings. All six were accepted and fixed with targeted regression tests. A requested follow-up review started through the authenticated helper but Claude returned HTTP 429 because the account session limit had been reached. The helper saved that failure honestly in `claude-fix-rereview.md`; no follow-up approval is claimed.

## External verification still required

- Production Whisper and LLM assets and immutable artifact receipts.
- Production dictionary publisher key and bundled general dictionary.
- Physical capture, inference-load, duration, sleep/resume, and device-switch runs.
- 8 GB, 16 GB, and 32 GB performance results.
- Signed and timestamped Standard and Maximum Accuracy installers.
- Clean-machine offline install and upgrade receipts.
