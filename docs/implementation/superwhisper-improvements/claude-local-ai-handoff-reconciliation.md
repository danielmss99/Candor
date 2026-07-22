# Claude Local AI Handoff Review Reconciliation

Date: 2026-07-21

Review source: `claude-local-ai-handoff-plan-review.md`

The helper completed successfully and the review does not begin with
`CLAUDE INVOCATION NOT PERFORMED`.

## Accepted

- Add a typed transcript revision kind and a separate
  `currentCleanedRevisionId`. An AI-cleaned revision must never replace the
  selected evidentiary transcript.
- Add explicit parent and input revision links. Validate every reference while
  holding the manifest mutation lock and write a stage revision plus receipt in
  one atomic manifest replacement.
- Require cleanup output to be bounded schema-constrained JSON with exactly one
  output for each input segment. Preserve and validate source ID, timestamps,
  channel, and speaker association.
- Record stage, input revision, prompt-template hash, validation result, and
  fallback use in processing receipts without storing prompts or transcript
  content.
- Keep the model catalog immutable at runtime. Embed it in trusted application
  code or verify a packaged copy against a compile-time hash before resolving a
  URL.
- Preserve existing Whisper choices during profile migration. Parakeet may only
  become the default for new profiles after all release gates pass.
- Pin and privately load the sherpa-onnx runtime. Do not use Superwhisper assets
  or probe its installation at runtime.
- Treat Parakeet runtime hash, model hash, conversion provenance, attribution,
  Windows benchmark, silence, timestamp, crash-recovery, and language evidence
  as release blockers.

## Accepted with adjustment

- Claude recommended cancelling downloads when recording begins. Candor will
  refuse new downloads while capture is active and cancel an active transfer at
  the capture-start boundary. A user must explicitly restart it afterward.
- Claude recommended raw IDs in cleaned output. Candor will use stable source IDs
  derived from immutable segment order and validate the complete one-to-one
  mapping. Internal durable chunk indices remain core-private.
- Claude recommended a profile-migration processing receipt. Recording receipts
  are meeting-scoped, so profile-store migration will instead use an atomic
  versioned migration record in the profile store. Each captured meeting keeps
  the exact migrated profile snapshot that it used.

## Rejected

- Do not exclude cleaned text from search. The approved product behavior is to
  search original and cleaned text. Candor's current encrypted FTS indexes only
  the selected transcript, not every historical revision. The new index will
  store original and cleaned rows with an explicit, renderer-visible source kind
  and will never treat a cleaned match as authoritative evidence.
- Do not mark missing receipt links as `orphaned` inside a structurally invalid
  manifest. Current manifest validation already rejects successful receipts that
  reference absent revisions. New stage commits remain atomic; inconsistent
  manifests continue through the existing quarantine/recovery boundary rather
  than being silently normalized.
- Do not require the old binary to read schema 5. The existing forward-version
  rule deliberately rejects manifests newer than it supports. The new binary
  must read and migrate schemas 1 through 4 without data loss.

## Deferred

- A native download helper process. Electron main remains acceptable when the
  catalog is immutable, the renderer supplies only a model ID, redirects are
  revalidated, and installation remains core-owned and atomic.
- Parakeet default activation. The catalog and adapter may ship in a gated state,
  but the default flag stays false until every release artifact exists.
- Remote catalog updates. Catalog changes require a signed Candor application
  release.

## Required first implementation slice

1. Manifest schema 5 metadata and compatibility migration.
2. Separate evidentiary and cleaned revision pointers.
3. Stage-aware processing receipts and strict reference validation.
4. Renderer contract and Trust History presentation for the new metadata.
5. Focused Rust and renderer tests before implementing cleanup inference.
