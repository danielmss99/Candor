# Windows Public Beta Hardening Verification

Date: 2026-07-15

## Scope

This record covers the source-level Windows public beta hardening approved for
the current worktree. It does not certify signing, clean-machine behavior,
physical audio hardware, endurance, sleep/resume, device switching, or public
artifact publication.

## Implemented Guarantees

- Local LLM work requires an exact verified model ID, model SHA-256, and
  runtime SHA-256. Missing or changing identity fails the AI task.
- The default fallback preference is **Ask first**. Automatic fallback is an
  explicit setting, and cancellation, shutdown, or recording-priority
  preemption never trigger heuristic output.
- Strict local-AI retry creates a new required-local-LLM task and preserves the
  previous result when retry fails.
- Qwen recap and Ask use the pinned `llama-completion` frontend, exact JSON
  schemas, strict transcript source IDs, private prompt-file transport, and
  cancellable subprocess execution. Legacy `llama-cli` execution is rejected.
- Failed background tasks render before active and queued work, simultaneous
  terminal changes produce one aggregate accessible announcement, and Cancel
  All targets only queued, running, or paused tasks.
- Whisper provenance distinguishes OpenAI as upstream publisher from the
  pinned canonical whisper.cpp artifact revision.
- Windows public packaging uses a separate Azure Trusted Signing configuration
  with forced signing and `.exe` coverage for both the Electron executable and
  Rust sidecar. Missing signing configuration fails before packaging.

## Verification Results

| Verification | Result |
| --- | --- |
| `cargo fmt --all -- --check` | Passed |
| Strict Clippy, all targets and features | Passed |
| Rust default-feature tests | 190 passed |
| Rust all-feature tests | 209 passed |
| Vitest | 174 passed across 45 files |
| Renderer TypeScript check | Passed |
| Electron main build | Passed |
| Renderer production build | Passed |
| Playwright Electron and axe | 7 passed |
| GUI state matrix | 135 screenshots; all required baseline combinations present |
| `npm run v3:verify` | Passed |
| `npm run electron:v3:build` | Passed |
| M0 CI contract smoke | Passed |
| AI bundle verifier self-test | Passed |
| Publication policy self-test | Passed |
| Source security mutation proof | Passed |
| `npm audit` | 0 known vulnerabilities |
| `cargo audit` | 0 known vulnerabilities; 2 allowed unmaintained transitive warnings |
| SPDX SBOM generation and verification | Passed |
| Real release-mode Qwen recap and Ask proof | Passed |

The two allowed Cargo warnings are `RUSTSEC-2026-0206` for `rustybuzz 0.20.1`
and `RUSTSEC-2026-0192` for `ttf-parser 0.25.1`. They report unmaintained
transitive libraries, not known vulnerabilities.

## Real Local AI Evidence

The real-model proof used the pinned Windows `llama-completion` runtime and the
Qwen3 4B Q4_K_M GGUF. It completed a grounded recap and grounded Ask response,
verified runtime and model hashes, emitted no raw paths, deleted the prompt
file, and made no model download.

- Proof: `release-v3/proofs/m4-real-local-instruct-proof-win32-x64.json`
- Runtime SHA-256:
  `2272eaaf8bb9477257790835d7b25aaf8fd22941e44ac3fcc9f2df389d1ef7b4`
- Model SHA-256:
  `7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5`
- Distribution archive SHA-256:
  `f7783c2b8c007f95e710ac40f26a24861a80b603b0b739fc54d7c926a4716c1e`

## Fail-Closed Evidence

- `npm run spec3:ai-bundle:verify:complete` exited 1 because the public bundle
  is not release-selected and lacks complete production asset, benchmark,
  license, and terminology bindings.
- `npm run release:standard` exited 1 at the same strict asset gate before any
  package could be published.
- Loading `electron-builder.release.cjs` without Azure credentials exited 1 and
  named every missing required signing variable.
- `npm run v3:release-readiness-audit:strict` exited 1 and recorded the absent
  signing, clean-machine, physical capture, endurance, network, cross-platform,
  and production AI evidence.
- `npm run v3:release-checksums:verify` exited 1 because the tracked worktree is
  dirty. Publication checksums must be regenerated and verified from the final
  clean release commit and signed artifact set.

The release-readiness GUI validator was corrected after the first strict audit
rejected the current 135-image evidence set for exceeding its old exact
125-image count. It now requires every baseline scenario and viewport pair,
requires the declared count to match the evidence array, rejects duplicates,
and safely permits additional validated scenarios. The rerun removed the GUI
gate failure while preserving the external failures above.

## Claude Review Disposition

Claude's focused implementation review reported no critical or high-severity
findings.

- The reported low-severity staging deletion race required no additional code
  change because `DictionaryStaging::delete` already treats a missing staged
  file as success.
- The persisted-descriptor migration observation was hardened: descriptors
  missing a fallback policy now default to required local LLM behavior. Only
  explicitly recognized legacy quality descriptors retain disclosed fallback.
- Unreachable legacy llama CLI flags are cleanup-only and do not provide an
  execution path because the frontend guard rejects that binary before spawn.

A final post-verification Claude review was requested at 09:54 EDT on
2026-07-15. The authenticated Claude CLI returned HTTP 429 because its session
limit had been reached and reported a noon reset. No alternate Claude bridge
was configured, so no final-review result is claimed. The request and redacted
fallback artifact are retained as `claude-final-review-request.md` and
`claude-final-review.md`.

## Evidence Locations

- `release-v3/proofs/v3-local-verification-win32-x64.json`
- `release-v3/proofs/m4-real-local-instruct-proof-win32-x64.json`
- `release-v3/proofs/spec3-ai-bundle-source-interface-win32-x64.json`
- `release-v3/proofs/v3-release-readiness-audit-strict-win32-x64.json`
- `release-v3/proofs/v3-release-sbom-win32-x64.json`
- `release-v3/Candor-0.4.0-SBOM.spdx.json`
