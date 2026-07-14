# SPEC-3 Bundled Local AI Baseline

Recorded on 2026-07-13 from commit
`adfe573b15e89add9345b53da463d5902487335a` on
`codex/bundled-local-ai`.

## Results

| Check | Result |
| --- | --- |
| `npm test` | Pass, 40 files and 134 tests |
| `npm run electron:v3:typecheck-renderer` | Pass |
| `npm run core:v3:build` | Pass |

## Starting architecture

- Whisper inference is linked through `whisper-rs`; there is no Whisper child
  process or local server.
- llama.cpp-compatible inference uses a direct child process with fixed
  arguments, bounded output, no shell, and no HTTP listener.
- User-managed speech and language assets are already SHA-256 verified under
  the local data directory.
- The async job manager serializes inference jobs and preserves terminal job
  state across renderer reloads.
- Electron packages `candor-core`, but no model or language runtime assets.
- The release SBOM inventories npm and Cargo dependencies, but not packaged AI
  assets.

No baseline failures were found.
