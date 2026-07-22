# Independent Plan Review: Local AI Handoff and Model Library

Date: 2026-07-21

This is a sanitized review request. It contains architecture facts and bounded
source descriptions only. It excludes recordings, transcripts, vault data,
credentials, private keys, environment files, local paths outside the repo, and
Superwhisper proprietary files.

## Objective

Extend Candor's existing local-first meeting pipeline with:

1. An explicit handoff from speech recognition to transcript cleanup and then
   structured recap generation.
2. Three separately retained artifacts: immutable raw ASR transcript, derived
   cleaned transcript, and source-grounded structured recap.
3. A curated Local Models screen for verified speech and text-processing models.
4. Explicit, allowlisted model downloads that cannot receive meeting data.
5. NVIDIA Parakeet TDT 0.6B V3 as the default for new profiles only after
   Windows, accuracy, provenance, license, and resource gates pass.

## Existing repository facts

- Rust `RecordingStore` already has bounded immutable transcript revisions,
  encrypted raw-versus-normalized comparison text, processing receipts,
  reprocessing from original audio, protected-term review, and encrypted search.
- Current transcript revision sources are `initial`, `reprocess`, `import`, and
  `review`. Receipts currently cover transcription attempts.
- Rust `LocalInstructModelService` already runs a verified local llama.cpp binary
  and GGUF, chunks long transcripts, requires schema-constrained JSON, validates
  source IDs, and produces grounded recap and Ask outputs.
- Current text-model acquisition is manual-install-only. The renderer never
  receives or submits raw model paths.
- `ModelManager` supports pinned Whisper model identities, streamed manual
  imports, local verification, warm-state reporting, hardware requirements, and
  measured latency.
- Meeting profiles currently select a `localModelTier`, language, replacement
  set, recap template, and provisional live-transcription preference.
- Electron keeps a sandboxed renderer, context isolation, narrow IPC, and a
  network policy that denies meeting-data networking.
- The current worktree also contains the accepted onboarding, microphone test,
  shortcut, History, live transcript, media import, diarization foundation, and
  read-only CLI/MCP work. These changes must be preserved.

## Proposed design

### Processing chain

1. ASR commits an immutable `raw-asr` revision.
2. Deterministic replacement rules may create a normalized revision.
3. The local text model creates an `ai-cleaned` revision in bounded batches.
   It must retain source segment IDs, timestamps, channels, and speaker labels.
4. Recap generation consumes the selected successful cleaned revision, or the
   raw revision when cleanup is unavailable, and cites immutable raw source IDs.
5. Each stage is independently retryable. Retrying creates new descendants and
   never overwrites earlier revisions or recaps.

Extend revision metadata with `kind`, `parentRevisionId`, and processing identity.
Extend receipts with `stage`, input revision IDs, prompt-template hash,
validation result, and fallback status. Do not store prompt content in receipts.

### Model library

Ship a catalog manifest with immutable model ID, capability, engine, publisher,
distribution source and revision, fixed HTTPS URLs, SHA-256, byte count, license,
languages, hardware requirements, and release-gate state. The renderer submits
only a model ID.

An Electron model-acquisition broker resolves the packaged entry, applies an
exact host/path allowlist, downloads into bounded staging storage, hashes before
atomic installation, and streams into existing core-owned installation methods.
No remote catalog, arbitrary URL, generic filesystem IPC, analytics, or
background download is allowed. Explicit model download traffic must remain
separate from meeting data and pause during recording.

Initial entries are the already pinned Whisper models, the already pinned Qwen3
4B GGUF candidate, and a gated Parakeet V3 entry.

### Parakeet

Use a pinned sherpa-onnx Windows runtime and its reproducible Parakeet V3 INT8
conversion. Do not use assets from the installed Superwhisper application.
Parakeet is initially final/offline ASR; Whisper continues provisional live ASR.
New installs select Parakeet only after all release gates pass. Existing explicit
Whisper choices are preserved.

## Non-negotiable boundaries

- Meeting audio, transcript, prompt input, recap, notes, IDs, vault data, and
  private paths never enter the download broker or any outbound request.
- Raw transcript evidence is immutable and always readable after downstream
  failure.
- No cloud model, remotely mutable catalog, active-window context, clipboard
  context, or arbitrary prompt/file/URL IPC.
- Failed or cancelled installation cannot replace a working model.
- Model removal requires confirmation and cannot remove an active/warm model.
- No release claim for Parakeet until exact binary, model, license, benchmark,
  language, silence, timestamp, and recovery proofs exist.

## Review questions

Provide an adversarial review with severity labels and distinguish required work
from optional improvements. Focus on:

1. Whether cleanup should be a transcript revision, a separate derived document,
   or both, considering revision selection and search semantics.
2. How to link recap provenance to raw sources when the recap reads cleaned text.
3. Crash consistency across downloaded assets, revision branches, and receipts.
4. Prompt-injection and hallucination risks in cleanup output while preserving
   speaker/timestamp identity.
5. Whether Electron should download bytes or whether a more isolated broker is
   required under Candor's current trust boundary.
6. Migration from `localModelTier` to explicit speech, cleanup, and summary IDs.
7. Parakeet/sherpa-onnx redistribution and Windows-runtime risks that must block
   default selection.
8. Required unit, integration, adversarial, network, crash-recovery, accessibility,
   performance, and release tests.
9. Repository surfaces that should not be edited concurrently.

Do not edit files. Do not expand into cloud AI or ambient application context.
Return a concise implementation order, Critical/High/Medium/Low findings,
assumptions, failure modes, tests, and explicit defer/reject recommendations.
