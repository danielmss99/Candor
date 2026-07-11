# M0 IPC Threat Model

Status: **implemented M0 baseline, pending sustained fuzz expansion**

## Assumption

The renderer is untrusted. A compromised renderer may call the preload API with
unexpected values, attempt unknown methods, or try to navigate/network out.

## Boundary

- Renderer can access only `window.candor`.
- Preload exposes a fixed method allowlist.
- Electron main repeats the allowlist check before touching `candor-core`.
- Rust core has its own allowlist and returns `METHOD_NOT_ALLOWED` for unknown
  methods.
- Preload exposes a separate frozen `window.candor.license` surface with only
  `status`, `activate`, `startTrial`, `deactivateDevice`, and `portalInfo`.
  License state is stored locally through Electron `safeStorage`; the renderer
  receives no storage path, device id, purchaser email, or key material.
- The renderer may call `vault.openLocal` through the typed preload bridge, but
  that method takes no passphrase, key, or path parameters and returns only
  structured custody facts.
- The renderer may call typed capture controls: `capture.status`,
  `capture.devices`, `capture.startMic`, `capture.startSystem`,
  `capture.startMicAndSystem`, and `capture.stop`.
- The renderer may call typed consent controls: `consent.status` and
  `consent.acknowledge`.
- The renderer may call pathless local library and playback methods:
  `recording.durable.list`, `recording.durable.read`,
  `recording.durable.replayManifest`, `recording.durable.transcript`,
  `recording.durable.readAudioChunk`, `recording.durable.search`, and
  `export.create`.
- The renderer may call `exportSaveLocal` with a recording id, one of the three
  report formats, bounded structured report data, and bounded document options.
  Electron main owns the native save dialog and is the only layer that receives
  the selected destination. Before writing, main verifies the core-reported
  format, MIME type, exact byte count, 16 MB output limit, local custody facts,
  and the DOCX or PDF signature. It returns only the saved basename, byte count,
  SHA-256, and document capability facts. No destination path or arbitrary write
  primitive reaches the renderer.
- The renderer may call typed local model methods: `models.status`,
  `models.listLocal`, and `models.verifyLocal`. These accept no raw model
  paths, no URLs, and no arbitrary file handles. Verification is by allowlisted
  model id only. The renderer may also call
  `window.candor.core.modelsImportFromFile`, which asks Electron main to open a
  native file picker and stream the selected file to the core; the selected path
  is never returned to the renderer.
- The renderer may call typed local AI methods: `ai.status`,
  `ai.askHeuristic`, `ai.recapHeuristic`, `ai.instructStatus`,
  `ai.askInstruct`, `ai.recapInstruct`, and `ai.schedulerStatus`. These accept
  only recording ids, question text, and bounded token counts. They do not
  accept executable paths, model paths, URLs, or network endpoints. Instruct
  status reports configuration facts without returning configuration values.
  Electron main applies fixed 60-second timeouts to the two instruct methods;
  the renderer cannot provide or extend an IPC timeout.
- The renderer may call `aiInstructAssetImportFromFile`, which asks Electron
  main to open a native file picker and pass the selected runner or GGUF path to
  a private core method. Import requires an expected SHA-256 hash. Neither the
  source path nor the managed destination path is returned to the renderer.
- The renderer may call typed transcription methods:
  `transcription.status` and `transcription.runLocal`. These accept only a
  recording id, optional channel, optional model id, language, and initial
  prompt. They do not accept raw model paths, raw recording paths, arbitrary
  file handles, URLs, or network endpoints.
- `recording.durable.writeAudioChunk` is accepted by Electron main and the Rust
  core for M2 smoke proofing and future native capture adapters, but it is not
  exposed by the preload bridge.
- `recording.durable.writeTranscriptSegment` is accepted by the Rust core for
  local transcription output and smoke proofing, but it is not exposed by the
  Electron preload bridge.
- `models.importStart`, `models.importChunk`, `models.importFinish`, and
  `models.importAbort` are accepted by Electron main and the Rust core for the
  native model file picker flow, but they are not exposed directly through the
  preload bridge.
- `capture.proofSynthetic` is a core-only smoke proof and is not exposed by the
  preload bridge.
- `capture.proofSerializedWriter` is a core-only smoke proof for the combined
  capture writer queue and is not exposed by the preload bridge.
- `capture.proofInterruptedSerializedWriter` is a core-only crash-recovery proof
  for capture-service chunks and is not exposed by the preload bridge.
- `models.proofSynthetic` is a core-only smoke proof that writes a fake model
  into the isolated model store and verifies that hash checking blocks it. It is
  not exposed by the preload bridge.
- `ai.proofSchedulerBusy` is a core-only smoke proof that verifies the scheduler
  denies concurrent local Whisper and LLM jobs. It is not exposed by the preload
  bridge.
- `transcription.proofSynthetic` is a core-only smoke proof and is not exposed
  by the preload bridge.
- Proof-harness vault methods such as `vault.openLocalProof`,
  `vault.openWithOsKeyProof`, `vault.proofWrongKeyFails`, and
  `vault.proofOsKeyStorage` remain core-only validation tools. The core-only
  `vault.proofPassphraseFallback` method validates fallback custody without
  exposing a passphrase through the renderer. These methods are not exposed by
  the Electron preload bridge.

## Denied Capabilities

- Raw vault keys in renderer.
- Vault passphrases in renderer.
- Raw unrestricted filesystem paths in renderer.
- Native save-dialog results or destination paths in renderer.
- Arbitrary process execution.
- Arbitrary native module access.
- Localhost TCP server.
- Cloud AI calls.
- Background model download calls.
- Auto-updater traffic.
- Crash reporter traffic.
- License storage paths, device identifiers, and purchaser email values in the
  renderer.

## Sidecar Lifecycle

Electron main starts `candor-core`, tracks pending RPC calls, times calls out,
rejects pending calls on process exit, and sends `core.shutdown` before quit.
Startup is not considered healthy until Electron main completes a `core.version`
handshake and records the expected `m0-jsonrpc-stdio-1` protocol version in the
sidecar supervisor state.

The supervisor state tracks lifecycle state, executable path, PID, restart
count, last exit, and last handshake. The renderer can read only this structured
status through `window.candor.shell.supervisorStatus()`. It cannot request a
restart, access the raw process object, execute arbitrary commands, or call
`core.shutdown`.

## Packaged Runtime Proof

`scripts/m0-packaged-smoke.mjs` launches the packaged app with
`CANDOR_M0_SMOKE_OUT`, waits for the renderer to load, and executes a renderer
probe through `window.candor.core`. The proof passes only if the renderer can
reach the preload bridge, Electron main accepts the typed IPC call, and the
packaged sidecar returns `core.status` over stdio JSON-RPC.

The packaged smoke also runs a renderer isolation probe from the page context.
It must prove that `require`, `process`, `ipcRenderer`, and Electron globals are
not visible, that the preload `core`, `license`, and `shell` surfaces are frozen, and that
private model import chunks, raw file APIs, process execution, and external
navigation commands are absent from the bridge.

The smoke starts from an isolated Electron user-data directory, captures the
inactive activation screen, starts a local no-account trial through the typed
license bridge, captures first-run setup, enters the app, and verifies the
renderer reports the same local trial state. It then captures Live Meeting and
seven secondary product views from the packaged app.

The proof artifact is stored under `release-v3/proofs/` and also asserts that
the core denies localhost TCP, reports zero attempted external calls, and keeps
the packaged session from allowing external requests. It also performs a
smoke-only sidecar restart exercise: Electron main shuts down the first sidecar,
starts a replacement, completes a fresh version handshake, and proves the
replacement still returns `core.status` over stdio.

## M0 Fuzz Baseline

`scripts/m0-core-smoke.mjs` now runs the real `candor-core` binary over stdio
and verifies these fail-closed cases:

- unknown methods return `METHOD_NOT_ALLOWED`
- malformed JSON returns `MALFORMED_JSON_RPC`
- malformed envelopes with missing required fields return `MALFORMED_JSON_RPC`
- frames larger than `maxRpcFrameBytes` return `RPC_FRAME_TOO_LARGE`
- fuzz errors use `id: null` rather than trusting attacker-controlled request
  IDs
- `core.status` still succeeds after the fuzz cases, proving the sidecar stayed
  alive

Rust unit tests cover the same malformed, oversized, and empty-frame behavior.
Post-M0 should add sustained randomized fuzzing and compromised-renderer IPC
tests around Electron main, but malformed core frames are now part of the M0
verification gate.
