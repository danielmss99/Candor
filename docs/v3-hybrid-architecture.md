# Candor v3 Hybrid Architecture

Candor v3 is a from-scratch local-only desktop app. Electron owns the product
surface and Rust owns the trusted local core.

## M0 Decision Gate

M0 exists to prove the riskiest premise before product work continues:
Electron must run with a Rust sidecar, no unauthorized network traffic, a narrow
preload allowlist, and packageable binaries on Windows, macOS, and Linux.

If M0 cannot be proven, stop Electron work and reconsider Tauri or native shells
while preserving the Rust core design.

## Shell/Core Boundary

- Electron main supervises `candor-core` over stdio JSON-RPC.
- The renderer is sandboxed and receives only `window.candor`.
- The renderer cannot access raw filesystem paths, vault keys, arbitrary process
  execution, unrestricted networking, or native modules.
- The core owns audio capture, vault encryption, model verification,
  transcription, local AI orchestration, exports, and audit logs.

## Transport

Transport is newline-delimited JSON over stdin/stdout. M0 intentionally avoids
localhost TCP to prevent open ports, firewall prompts, and other-process access.

Every core response carries the `m0-jsonrpc-stdio-1` protocol version. Electron
main rejects an invalid response envelope, and the renderer validates the initial
handshake before accepting core data. Shared parsers reject malformed types
visibly. Recording and transcript reads are paged, stale meeting requests are
ignored, and duplicate writes are excluded by operation scope.

## Capability-Based Network Policy

The Rust core reports a capability matrix rather than a blanket marketing claim:

- recording: denied;
- transcription: denied;
- local AI: denied;
- local licensing: local only unless the user explicitly invokes a future portal;
- updates: disabled until a separately reviewed manual checker exists.

Every meeting can produce a pathless privacy receipt with capture channels,
encrypted chunk state, transcript and note facts, model identifiers and hashes,
local processing history, export history, retention policy, and network facts.

## Renderer Structure

The root coordinates feature-owned views and hooks. UI lives under
`v3/renderer/src/features`; protocol access and response schemas live under
`v3/renderer/src/core`; explicit capture and local-job machines plus stale request
coordination live under `v3/renderer/src/state`.

## Milestone Shape

- M0: Electron risk spike and proof artifacts.
- M1: SQLCipher vault and durable capture adapters.
- M2: record, recover, transcribe, replay, search, export.
- M3: product workspace and consent UX.
- M4: local AI, starting with heuristics and one small instruct model.
- M5: importer, signing, release, manual updater.

Run `npm run v3:verify` before packaging to execute the local staged proof stack
from M0 through M5. M0 exit still requires the stricter packaged proof audit and
OS-boundary network-deny artifacts on Windows, macOS, and Linux.
