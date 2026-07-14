# SPEC-4 Baseline

Recorded on 2026-07-13 from branch `codex/whisper-llm-release`.

## Inputs

- Base commit: `f9d797047e322161c605017c66ef164162646b75`
- Base source: merged `origin/main` after PR #8
- Handoff archive: `CANDOR_CODEX_COMPLETE_WHISPER_LLAMA_HANDOFF.zip`
- Handoff SHA-256: `CC99577068E084A2913163868551E96E3869C10AD4061C90C4C8F644A0DB2289`
- Archive contents: eight specification and manifest files; no runtimes, models, signatures, or benchmark evidence

## Verification

| Command | Result |
| --- | --- |
| `npm ci` | Passed; 440 packages audited, 0 vulnerabilities |
| `npm run v3:verify` | Passed |
| Rust default tests | 99 passed |
| Renderer tests | 40 files, 137 tests passed |
| M0 through M5 proof scripts | Passed |

The SQLCipher negative-path tests emitted expected HMAC failure diagnostics while proving rejection of an invalid key. The command still completed successfully.

## Existing foundation

- Bundled AI manifest and runtime/model lock verification already exist.
- Whisper model IDs and trusted digests already include `small.en`, `small`, `large-v3-turbo`, and `large-v3`.
- Managed local model overrides and verified bundled-package fallback already exist.
- A pinned llama.cpp candidate and fixed-path child-process boundary already exist.
- Local recap and Ask already require transcript citations.
- The renderer exposes only allowlisted operations and has no Node.js access.

## Honest baseline limits

- The merged bundle manifest is intentionally not release-ready and contains no real assets.
- No Qwen model is selected or packaged.
- No hardware benchmark or persistent Fast, Balanced, Maximum quality preference exists.
- No terminology dictionary service exists.
- No signed Complete or Complete Max installer exists.
- No 8 GB, 16 GB, 32 GB, pharmaceutical, clean-install, upgrade, or long-duration evidence was supplied.
