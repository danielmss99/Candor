# M1 Durable Recording Proof

Status: **Encrypted durable chunk store implemented where native OS key storage is available; v3 mic capture service and separated mic plus system capture adapters implemented for Windows, macOS, and Linux; cross-OS real-device proof still pending**

## Requirement

Recording durability must ship before polish. Audio data must be written as
append-only flushed chunks, encrypted at rest where native key storage exists,
and recovery must find unfinished recordings without exposing raw filesystem
paths to the renderer.

## Implemented Baseline

- `candor-core` has a platform-neutral durable recording store rooted in local
  user data by default:
  - Windows: `%LOCALAPPDATA%\Candor\v3`
  - macOS: `~/Library/Application Support/Candor/v3`
  - Linux: `$XDG_DATA_HOME/candor/v3` or `~/.local/share/candor/v3`
- `CANDOR_V3_DATA_DIR` can override the root for tests and smoke proof.
- Chunks are append-only encrypted `chunk-000000.cchunk` files using a
  `chacha20poly1305` envelope and a core-only key derived from the OS-managed
  local key when native key storage is reachable.
- Windows uses DPAPI, macOS uses Keychain, and Linux uses Secret Service when
  available. If native storage is unavailable, the plaintext harness path
  remains explicit rather than pretending encryption is implemented.
- Legacy or fallback chunks use append-only `chunk-000000.raw` files.
- Each chunk write uses `write_all` followed by `sync_all`.
- Native audio callbacks use bounded non-blocking queues. Queue saturation or a
  runtime stream failure stops the capture session, preserves the first
  integrity error, and flushes audio already accepted into the queue. A
  compromised capture is never silently reported as verified.
- `manifest.json` is rewritten after each chunk and after finish or recovery.
- Recovery scans recording directories, rebuilds missing manifests from chunks,
  decrypts encrypted chunk envelopes when needed to recover plaintext byte
  counts, and marks interrupted recordings as `needsRecovery`.
- Core summaries report `rawPathExposed: false`, `encryptedAtRest`,
  `encryptedChunkCount`, `totalBytes`, and `storedBytes`.
- When the SQLCipher OS-key vault is available, recording summaries are mirrored
  into an encrypted `candor_recordings` index. The JSON manifest remains the
  crash-recovery journal, while the encrypted index becomes the library/search
  foundation.

## Core RPC Methods

- `recording.durable.status`
- `recording.durable.start`
- `recording.durable.writeTextChunk`
- `recording.durable.writeAudioChunk`
- `recording.durable.finish`
- `recording.durable.recover`

`writeTextChunk` is a harness method for proving the durable writer before real
OS audio capture adapters land. The v3 mic capture service now has its own M1
proof. Windows system capture now uses the `cpal` WASAPI loopback path, and
Linux system capture can use PipeWire or PulseAudio monitor-style input devices
through `cpal`. Windows and Linux combined mic plus system capture write both
tracks through one serialized core writer to avoid concurrent manifest rewrites.
macOS 13 and later uses ScreenCaptureKit for system audio and `cpal` CoreAudio
for the microphone, with both tracks entering that same serialized writer.

## Verification Commands

```powershell
cargo test --manifest-path crates/candor-core/Cargo.toml
npm run m1:durable-recording-smoke
npm run m1:durable-crash-smoke
npm run m1:capture-service-smoke
npm run m1:capture-proof-audit
npm run m1:capture-crash-smoke
npm run m1:verify
```

## Current Test Coverage

- Finished recording writes a flushed chunk and returns no raw path.
- On Windows, finished recording and crash recovery smokes prove encrypted
  chunk storage with `encryptedAtRest: true` and `storedBytes > totalBytes`.
  The same code path is used on macOS and Linux when native key storage is
  available.
- Interrupted recording is recovered as `needsRecovery`.
- Missing manifest is rebuilt from chunk files, including encrypted Windows
  chunk envelopes.
- Unsafe recording IDs are denied.
- Real sidecar smoke uses a temporary local data directory, writes a finished
  recording, writes an interrupted recording, runs recovery, and verifies no raw
  path is exposed.
- Crash recovery smoke starts a real `candor-core` sidecar, writes one flushed
  chunk, force-kills the process before finish, starts a new sidecar with the
  same data directory, and verifies startup recovery marks the interrupted
  recording `needsRecovery` with the flushed chunk preserved before any manual
  `recording.durable.recover` call.
- SQLCipher smoke writes a durable recording and verifies its metadata is
  indexed into the encrypted vault without exposing key material or raw paths.
- Capture service smoke proves the core can create separated durable mic and
  system audio chunks through the capture boundary without exposing raw paths,
  Windows reports an implemented WASAPI loopback system adapter, and Linux
  reports an implemented PipeWire or PulseAudio monitor-input system adapter.
  Both implemented system paths use a combined mic and system path with
  serialized manifest writes.
- Capture service smoke also runs a deterministic serialized-writer proof with
  concurrent synthetic mic and system producers, verifying separated tracks
  without requiring real audio hardware.
- Rust unit tests force callback queue saturation and verify that it produces
  `CAPTURE_CALLBACK_OVERFLOW`, while the IPC smoke and proof audit require the
  fail-session, no-silent-drop policy in `capture.status`.
- Capture service smoke writes
  `release-v3/proofs/m1-capture-service-smoke-<platform>-<arch>.json`, including
  explicit `realDevice.*.requested`, `attempted`, `ok`, and `skippedReason`
  fields so skipped hardware proof cannot be mistaken for real-device success.
- Capture crash smoke writes separated mic and system chunks through the
  capture-service serialized writer, force-kills the sidecar before finish, and
  verifies startup recovery preserves the chunks and replay tracks.

## Remaining M1 Work

- SQLCipher vault and native OS-key local open now have separate M1 proofs.
- Passphrase fallback UX and recovery story are still pending for machines
  where native key storage is unavailable.
- macOS ScreenCaptureKit adapter is implemented structurally; packaged-app TCC
  and real-device proof are still pending.
- Real-device mic capture smoke is available with `CANDOR_CAPTURE_REAL_DEVICE=1`.
- Real-device system capture smoke is available on each supported OS with
  `CANDOR_CAPTURE_REAL_SYSTEM=1`.
- Real-device combined mic plus system capture smoke is available with
  `CANDOR_CAPTURE_REAL_BOTH=1`.
- Real-device release proof must include M1 capture-service proof artifacts with
  successful attempted branches for the target OS, not only default synthetic
  proof artifacts.
- `npm run m1:capture-proof-audit:real` is the strict artifact audit for that
  evidence after an operator intentionally runs the real-device smoke branches.
- A kill-9 recovery proof against a real OS audio capture session is still
  pending.
- Synthetic mic and system audio channel separation is proven in
  `docs/proofs/M1_CAPTURE_SERVICE_PROOF.md`; simultaneous mic plus system capture
  in one recording session is implemented on Windows, macOS, and Linux.
