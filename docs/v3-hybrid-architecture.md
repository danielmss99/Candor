# Candor Electron And Rust Architecture

Candor uses Electron for the desktop product surface and Rust for the trusted
local core.

## M0 Decision Result

M0 tested the highest-risk premise: Electron could supervise a Rust sidecar,
retain a narrow sandboxed preload, package on Windows, macOS, and Linux, and run
under explicit network-deny proof tooling. That gate selected Electron as the
active shell.

The alternative implementation is archived at `archive/tauri-v2`. It is not an
active fallback, dependency, workflow, or packaging path. A future shell change
would preserve the Rust core boundary rather than revive two simultaneous apps.

## Boundary

- Electron main supervises `candor-core` over stdio JSONL RPC.
- The renderer is sandboxed and receives only `window.candor`.
- The renderer cannot access raw paths, vault keys, arbitrary processes,
  unrestricted networking, or native modules.
- Rust owns capture, durable recording, vault state, model verification,
  transcription, local AI, exports, retention, import, and privacy facts.

## Network Policy

Recording, transcription, local AI, and export are denied network capability.
Activation and future manual update checks are separate, user-initiated
capabilities. The product reports capability facts instead of making a blanket
network claim.

## Verification

Run `npm run v3:verify` before packaging. Release still requires packaged runtime
smoke, artifact audits, OS network-deny evidence, real hardware and duration
tests, clean-machine upgrade evidence, and signing.

The complete current trust model is in `ARCHITECTURE.md`.
