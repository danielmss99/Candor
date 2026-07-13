# SPEC-2 baseline

Date: 2026-07-13

Branch: `codex/post-consolidation-hardening`

Local HEAD: `1f9b87e19dc930faa5259e62ab9e4d6e7e23de1e`

`origin/main`: `1f9b87e19dc930faa5259e62ab9e4d6e7e23de1e`

## Results

| Command | Result | Evidence |
| --- | --- | --- |
| `npm ci` | Passed after stopping a stale Candor Vite process that held `node_modules/@esbuild/win32-x64/esbuild.exe` open | 439 packages installed; npm reported zero vulnerabilities |
| `npm test` | Passed | 35 files, 106 tests |
| `npm run electron:v3:typecheck-renderer` | Passed | TypeScript exited successfully |
| `npm run core:v3:build` | Passed | Rust debug build completed |
| `npm run electron:v3:build` | Passed | Icons, release core, Electron main, and renderer built; clean release compilation took about 12 minutes |
| `npm run electron:v3:pack` | Passed | Windows unpacked application created in `release-v3/win-unpacked` |
| `npm run test:electron` | Passed | 4 Playwright Electron tests, including sandbox surface, keyboard flow, axe, and scaled layouts |
| `npm run v3:source-security-proof` | Passed | Local source-security proof regenerated |
| `npm run v3:dependency-audit` | Passed with warnings | npm reported zero vulnerabilities; RustSec reported allowed unmaintained warnings for transitive `rustybuzz 0.20.1` and `ttf-parser 0.25.1` |

## Existing gaps confirmed

- `CoreClient.call()` can send an ordinary operation without awaiting the handshake.
- The RPC envelope and handshake are validated, but method-specific parameters and results are not.
- The preload exposes low-level core operation vocabulary and generic `JsonValue` results.
- Long transcription, AI, import, and export operations are synchronous requests.
- There is no explicit `capture-connection-degraded` supervisor state.
- Critical-state screenshot coverage is incomplete.
- Package identity contains `version: 2.0.0` and a Candor v3 description.

## External evidence that remains unavailable

The baseline does not prove Windows Authenticode identity, timestamping, clean-machine installation or upgrade, Bluetooth and USB hardware behavior, sleep and resume behavior, device switching, or 180-minute physical recording durability. These gates remain blocked until evidence is collected on appropriate machines and hardware.
