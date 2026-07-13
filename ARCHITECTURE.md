# Candor Architecture

## Authority

The active application consists of:

- `electron/`
- `v3/renderer/`
- `crates/candor-core/`
- `electron-builder.v3.yml`
- `.github/workflows/v3-m0.yml`

Electron and the Rust core are the only active desktop architecture. The former
implementation is available only through the archival tag `archive/tauri-v2`.

## Process Boundary

```text
User
  -> React renderer (sandboxed)
  -> explicit preload operations
  -> Electron main process
  -> JSON lines over child stdin/stdout
  -> candor-core
  -> local stores, audio devices, and local models
```

### Renderer

The renderer owns presentation and user interaction. It does not own a security
boundary and receives only the frozen `window.candor` preload surface.

Prohibited renderer capabilities:

- Node.js globals or modules
- arbitrary IPC
- generic file reads or writes
- raw path selection
- arbitrary process execution
- renderer-selected executables or command lines
- vault keys and OS key-storage handles
- unrestricted network access

### Preload

The preload translates named product operations into allowlisted IPC. Current
operations are explicit functions. Native export, import, licensing, model, and
shell operations are registered in domain IPC modules and validate the active
main-frame sender. The transitional core channel remains method-allowlisted
until Phase 3 maps each preload operation to a named domain channel.

### Electron Main

Electron main owns:

- BrowserWindow creation and navigation policy
- session permissions and network denial
- file and folder dialogs that do not return raw paths to the renderer
- the Rust child-process lifecycle
- request correlation, timeouts, and protocol checks
- release-safe local export writes
- activation and license state

Every native capability must validate its sender and input before reaching the
core or operating system.

### Rust Core

`candor-core` owns:

- microphone and system-audio capture adapters
- append-only chunked recording and recovery
- SQLCipher vault access and OS-backed key storage
- recording, transcript, notes, retention, and privacy state
- local model import and hash verification
- Whisper transcription and local AI scheduling
- Markdown, editable Word, searchable PDF, and WAV export data
- v2 data import without modifying the source folder

The core must not return keys, complete sensitive paths, transcript content in
diagnostics, or unbounded payloads.

## Transport

The child process uses newline-delimited JSON on stdin and stdout. No localhost
TCP port is opened. The current protocol reports `m0-jsonrpc-stdio-1`; Electron
requests include UUID correlation, protocol version, and send time, while the
compatibility `id` is echoed by Rust. Electron bounds request and response
frames, validates every response envelope at runtime, rejects unknown or
duplicate responses, and applies method-specific timeouts. Phase 3 makes the
additive request metadata mandatory in Rust and adds core-side duplicate-ID
rejection.

Protocol faults are application states, not console-only errors. Malformed,
oversized, timed-out, crashed, hung, and incompatible core states must reach the
renderer as structured recovery choices.

## Core Lifecycle

The target lifecycle is:

```text
NotStarted -> Starting -> Ready -> Busy -> Ready
                    \-> Failed
Ready or Busy -> Disconnected -> Recovering -> Ready or Failed
```

Restart is capture-aware. Electron must not blindly terminate or restart the
core during recording, finalization, migration, import, or export. Interrupted
capture is checked before normal startup.

## Capture Lifecycle

```text
Idle
  -> CheckingPermission
  -> AwaitingConsent
  -> Starting
  -> Recording
  -> StopRequested
  -> Finalizing
  -> Saved
```

Failures can enter recovery, but the UI must never report `Saved locally` before
durable finalization. Duplicate starts and stops are rejected. Low disk remains
visible; disk full blocks capture with a recovery action.

## Data Ownership

Normal runtime data lives in OS application-data locations selected by the Rust
core and Electron. Tests can override the root through `CANDOR_V3_DATA_DIR`.

Structured vault data, recording manifests, audio chunks, model assets, exports,
and recovery files have separate responsibilities. A schema or storage format
cannot change silently. Migration work requires a pre-write backup,
transactional mutation, invariant verification, rollback, and corrupt-record
quarantine.

The v2 importer canonicalizes the selected source folder, rejects referenced
audio outside that folder, copies accepted data into the managed recording
store, and leaves originals untouched.

## Network Policy

Recording, transcription, local AI, vault access, and local export are denied
network capability. Chromium background networking, component updates, sync,
and proxies are disabled. Renderer fetches are blocked by CSP and Electron
session policy.

Activation and future manual update checks are separate, user-initiated
capabilities. Their use must be disclosed and recorded separately. Candor does
not make a blanket zero-network claim when an optional network capability is
enabled.

## Build And Packaging

`npm run build` performs:

1. deterministic icon validation;
2. release Rust core build with source-prefix remapping;
3. staging of the sidecar under ignored `build/core-bin/`;
4. Electron main compilation;
5. renderer compilation.

`npm run dist` packages through `electron-builder.v3.yml`. The Rust sidecar is
placed under `resources/bin`. `asar` protects application JavaScript layout but
is not treated as an encryption boundary.

## Security Invariants

- `contextIsolation: true`
- `sandbox: true`
- `nodeIntegration: false`
- `webSecurity: true`
- permissions denied unless a reviewed product flow owns them
- navigation and popups blocked
- no background updater or crash upload
- no generic renderer filesystem, process, path, or IPC API
- no user content, secrets, or full paths in diagnostics
- privacy statements derived from measured state

The portable source audit enforces these invariants and runs in-memory mutation
tests to prove important checks fail closed.

## Verification

The staged local gate is `npm run v3:verify`. Packaged and release gates include:

- `npm run electron:v3:pack`
- `npm run m0:packaged-smoke`
- `npm run m0:artifact-manifest`
- `npm run audit:release`
- OS-specific network-deny proofs
- release signing and readiness proofs

Local success does not replace real hardware, long-duration capture,
clean-machine install and upgrade, signing, or notarization evidence.
