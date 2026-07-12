# M2 Synced Transcript Proof

## Purpose

This proof covers the timestamped transcript contract needed for synced replay.

The core can now store transcript segments with channel, speaker, start time, duration, confidence, and text. Segment text is written through the durable local chunk store. The renderer can read the pathless transcript timeline but cannot write arbitrary transcript chunks through preload.

`transcription.proofSynthetic` now proves the same segment shape through the transcription service boundary, and `transcription.runLocal` is the pathless product command reserved for local Whisper inference.

## Command

```powershell
npm run m2:audio-replay-smoke
```

The full M2 local proof also runs it:

```powershell
npm run m2:verify
```

## Expected Result

The smoke script starts `candor-core` over stdio JSON-RPC with an isolated `CANDOR_V3_DATA_DIR`, then verifies:

- `recording.durable.writeTranscriptSegment` stores a timed segment through the core
- `recording.durable.transcript` returns sorted pathless transcript segments
- `recording.durable.replayManifest` points to `recording.durable.transcript`
- `recording.durable.read` includes transcript segment metadata, not raw paths
- `recording.durable.search` indexes the segment text
- Markdown export includes the synced segment text
- WAV export remains pathless and playable
- `npm run m2:transcription-boundary-smoke` proves transcription output can be written after capture has finished
- `npm run m2:transcription-proof-audit` validates the generated transcript
  proof artifact and keeps synthetic transcript evidence separate from real
  local Whisper inference

## Boundary

Default builds do not claim Whisper inference is complete. They prove the durable transcript output shape that local Whisper must produce, and fail closed if real local Whisper is requested without the `local-whisper` feature.
