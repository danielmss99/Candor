# SPEC-4 Verification

Recorded on 2026-07-14 on Windows x64 from `codex/whisper-llm-release`.

## Passing checks

| Check | Result |
| --- | --- |
| `cargo fmt --check` | Passed |
| Strict Rust Clippy (`--all-targets --all-features -- -D warnings`) | Passed |
| Default Rust tests | 132 passed |
| Rust `local-whisper` feature check | Passed |
| Renderer and Electron unit tests | 40 files, 147 tests passed |
| Renderer TypeScript check | Passed |
| Electron production build | Passed with SQLCipher and local Whisper |
| AI bundle verifier self-test | Passed |
| Source-interface AI bundle verification | Passed |
| Source-interface package identity | Passed; Windows metadata reports `Candor Source Interface` 0.4.0 under the separate builder configuration |
| `npm run release:complete` fail-closed gate | Passed; exited before build or packaging because real selected assets and evidence are absent |
| M2 transcription boundary and proof audit | Passed |
| M3 product surface | Passed |
| M4 local instruct fixture and verifier self-test | Passed |
| M5 legacy import | Passed |
| Playwright Electron and axe | 5 tests passed |
| GUI evidence matrix | 23 states x 5 desktop viewports, 115 screenshots after the final Local AI ready-state run |
| Full staged repository verification (`npm run v3:verify`) | Passed |
| Dependency audit | Zero known vulnerabilities; two documented unmaintained transitive font crates remain allowed warnings |
| `git diff --check` | Passed |

## Expected closed gate

`npm run release:complete` exits nonzero because the repository intentionally has
a `source-interface` manifest with no release-selected assets. The verifier
specifically reports missing Complete profile selection, real speech and
language assets, benchmark evidence, tested runtime evidence, and an exact
selected language-model artifact digest. The chained production build and
Electron Builder command do not run.

This failure is required. Replacing it with a passing placeholder would weaken the release boundary.

## Verification fixes found during this run

- Preserved the current speech selection when a bundled default is not verified.
- Updated the M2 producer and auditor to require automatic local terminology and reject user prompt input.
- Renamed a terminology-only refresh so the M3 audit continues to detect actual full-application refreshes.
- Updated the exact preload allowlist for typed quality methods.
- Updated visual fixtures with quality and terminology state so AI settings render in every screenshot scenario.
- Serialized terminology and quality-policy persistence after Claude identified read/write races.
- Added concurrent dictionary update and model-control-token rejection tests.
- Added stale-request guards for meeting-specific terminology state.
- Removed protocol reflection from parameter errors and `core.ping`.
- Re-ran the full staged verifier and Electron/axe evidence after review reconciliation.
- Separated source-interface package identity from public Candor and removed the
  standalone production-builder npm path.
- Added the core-owned Whisper and Llama benchmark job, duplicate-work guard, atomic measured-evidence tests, tier-specific model fingerprint invalidation, exact private operation schema, automatic idle startup policy, cancellation-safe retry state, and Maximum accuracy check path.
- Cleared terminal benchmark failures after persisting their safe retry state so an older failed job cannot shadow a later measured pass.
- Rejected model-control directives embedded inside dictionary definitions, not only directives at the beginning of a field.
- Replaced the fixed 45-second llama.cpp cutoff with a cancellable, token-scaled timeout capped at ten minutes for slower local hardware.
- Added a rounded measured estimate such as `About 15 minutes for a 1-hour meeting`; raw benchmark factors remain rejected outside diagnostics.
- Preserved explicit user quality choices while allowing the first successful automatic benchmark to establish the recommended Balanced default.
- Moved superseded direct AI, transcription, and export operations behind the private compatibility boundary; the renderer uses only canonical async job starts.
- Validated job event types, states, progress, timestamps, terminal consistency, errors, and custody flags before forwarding events to the renderer.
- Created llama.cpp prompt files on Windows with a protected owner-and-LocalSystem-only DACL at file creation time, and verified the descriptor rejects broad user groups.
- Tightened grounded recap validation for short claims, exact pharmaceutical facts, multi-speaker attribution, mixed channels, and summary-only citations.
- Rejected local benchmark starts in the Rust core while capture is active, including callers outside the renderer.
- Added a no-spawn test proving malformed private job requests are rejected before the core process starts.
- Completed an authenticated Claude rereview after reconciliation; it confirmed every disposition and found no remaining P0 or P1 code defect.
- Repaired the headless Ubuntu terminology tests with a compile-time test-only encryption key, then added real-constructor coverage proving OS-backed encryption when available and fail-closed behavior when unavailable.
- Sent the CI portability correction through another authenticated Claude review and implemented its recommended fail-closed coverage.
