# Candor

Candor is a local-first desktop meeting workspace. It records microphone and
system audio, creates local transcripts, keeps notes beside the conversation,
and exports editable meeting reports without cloud AI, a meeting bot, or a
required account.

Windows is the first release target. Windows, macOS, and Linux remain active
build and verification targets.

## Architecture

```text
React renderer
  -> sandboxed Electron preload
  -> Electron main process
  -> versioned JSONL RPC over stdin/stdout
  -> Rust candor-core
  -> local vault, managed audio, and local models
```

- `electron/` owns application lifecycle, native windows, security policy,
  file-selection dialogs, licensing, and supervision of the Rust process.
- `v3/renderer/` owns the React and TypeScript desktop interface.
- `crates/candor-core/` owns capture, durable recording, vault access,
  transcription, local AI, exports, retention, and privacy facts.
- `electron-builder.v3.yml` is the production Complete packaging configuration.
- `electron-builder.source-interface.yml` is the separate CI and developer
  verification configuration. It uses the `Candor Source Interface` product
  name and a distinct application ID.

The renderer has no Node.js access, generic filesystem API, arbitrary process
execution, raw vault paths, or vault keys. Electron and the Rust core communicate
through stdio rather than a localhost server.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the trust boundaries and
[docs/implementation/v4/implementation-plan.md](docs/implementation/v4/implementation-plan.md)
for the active consolidation plan.

## Local-First Boundary

Meeting audio, transcripts, notes, and local AI processing stay on the device.
The Rust core owns the facts used by privacy receipts and custody language. The
interface must not claim encryption, local processing, model verification, or
network isolation unless the current core response proves it.

Optional activation and future manual update checks are separate capabilities.
They must be user-initiated and disclosed independently from recording,
transcription, and local AI.

## Development

Prerequisites:

- Node.js 22
- Rust stable
- platform-native audio and key-storage build dependencies
- Windows native Perl when building the SQLCipher release core

Install and launch the Electron development application:

```powershell
npm ci
npm run dev
```

The development launcher builds the debug Rust core, starts Vite on an available
loopback port, and launches Electron with that exact origin allowlisted. It does
not open a public network listener.

Common commands:

| Command | Purpose |
|---|---|
| `npm run dev` | Launch Electron with the Vite renderer and debug Rust core |
| `npm run build` | Build the release Rust core, Electron main, and renderer |
| `npm run start` | Launch already-built local artifacts |
| `npm run preview` | Build and launch the built renderer in Electron |
| `npm run dist` | Build a source-interface verification installer, not a public release |
| `npm test` | Run the Vitest suite |
| `npm run v3:verify` | Run the staged local proof stack from M0 through M5 |
| `npm run audit:source` | Run the Electron/Rust source-security audit |
| `npm run dev:install-local-ai` | Install the pinned Whisper and Local AI development bundle on this workstation |
| `npm run electron:v3:pack` | Produce an unpacked `Candor Source Interface` package |
| `npm run electron:v3:dist:ai-release` | Build a public candidate only after the complete bundled-AI gate passes |
| `npm run release:complete` | Build Complete only when its exact profile, models, licenses, and evidence pass |
| `npm run release:complete-max` | Build Complete Max only when the Large model and full profile pass |
| `npm run m0:packaged-smoke` | Exercise the packaged application and sidecar |
| `npm run spec3:packaged-ai-smoke` | Prove the packaged AI boundary and meeting-data isolation |

`npm run start` expects `npm run build` to have completed. Production core
builds use a stable system build directory and stage only the finished sidecar
under ignored `build/core-bin/`; this prevents personal checkout paths from
entering release artifacts.

## Models

The public Complete installer is intended to include its required Whisper and
local instruction-model assets. It must not download baseline models on first
launch or in the background. Packaged assets live outside ASAR under the trusted
application resources root, are pinned in `third_party/`, and are verified at
build time and before first use. Advanced users may deliberately import a local
override through the native file picker with an expected SHA-256 value.

Model weights and llama.cpp binaries remain outside Git. On Windows x64,
`npm run dev:install-local-ai` acquires the exact assets pinned in
`third_party/`, verifies byte counts and SHA-256 digests, and atomically installs
them under the ignored `build/ai-bundle-local/` development root. Development
mode prefers that root without changing the tracked release placeholder. The
workstation bundle remains `releaseReady: false`, and
`npm run electron:v3:dist:ai-release` must still fail until licensing,
provenance, benchmarks, notices, signing, and external release evidence are
complete.
`npm run package:source-interface` is the CI/developer package path. Its product
name is `Candor Source Interface`, its application ID is separate from Candor,
and its installer name cannot be confused with a Complete release. It is never
a Complete product artifact. No general-purpose npm command invokes the
production builder configuration directly. Public release automation must use
`release:complete` or `release:complete-max`, which first require the matching
manifest profile and fail closed before packaging.

## Data Safety

- Recording chunks are append-only and flushed during capture.
- Interrupted recordings have deterministic recovery paths.
- Existing v2 Markdown and managed audio can be imported through the Rust v2
  importer; source files remain untouched.
- Licensing failures must not block opening, exporting, or deleting existing
  recordings.
- Release and migration claims remain incomplete until their proof artifacts
  exist. A green local verifier is not a signed, clean-machine release proof.

## Brand And Interface

The production identity is Keep Tab / Soft Signal. The GUI color and component
sources of truth are:

- `design/brand/CANDOR_PROJECT_BRAND_HANDOFF.md`
- `design/figma/style-guide.md`
- `design/figma/token.json`
- `v3/renderer/src/tokens.css`

The primary product journey is `Record -> Review -> Export`. Normal workflows
must not require users to understand hashes, runners, schedulers, or vault
internals.

## Legacy Archive

The former desktop implementation is preserved at the immutable Git tag
`archive/tauri-v2`, pointing to revision
`b29061334cff9c52654ad0f0528fee179151ed47`. It is not part of the active build,
dependency graph, workflow set, or release package.

## Release Status

Candor remains prerelease software. Local verification, packaged smoke, and
artifact auditing are implemented. Final model benchmark approval, signed
installers, clean-machine offline inference and upgrade proof, real long-duration
capture, sleep and resume, and device-switch evidence remain mandatory release
gates.
