# M2 Audio Replay Proof

## Purpose

This proof covers the durable audio bridge needed before real OS capture adapters can feed the M2 walking skeleton.

The core now accepts PCM audio chunks, stores them through the same durable local chunk path, and returns a pathless replay manifest for Electron playback.

## Command

```powershell
npm run m2:verify
```

The audio proof can also run by itself:

```powershell
npm run m2:audio-replay-smoke
```

## Expected Result

The smoke script starts `candor-core` over stdio JSON-RPC with an isolated `CANDOR_V3_DATA_DIR`, then verifies:

- `recording.durable.status` reports durable audio chunk support
- `recording.durable.writeAudioChunk` accepts `pcm_s16le` base64 chunks
- mic and system chunks produce a replay timeline with separate tracks
- `recording.durable.replayManifest` returns timing metadata and no raw paths
- `recording.durable.transcript` returns synced transcript segments with start and end timing
- `recording.durable.read` returns audio metadata only, not inline audio bytes
- `recording.durable.readAudioChunk` returns chunk bytes by recording ID and chunk index
- `export.create` with `format: "wav"` returns a pathless `audio/wav` payload for a selected track
- `export.create` includes synced transcript text and local audio replay metadata
- invalid audio format is rejected before storage

Passing output:

```text
M2 audio replay smoke passed.
```

## Boundary

This does not claim cross-OS real-device capture proof is complete. It proves the
durable local audio target and replay contract used by the implemented WASAPI,
CoreAudio, ScreenCaptureKit, and PipeWire or PulseAudio adapters.
