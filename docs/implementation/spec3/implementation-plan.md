# SPEC-3 Source Implementation Plan

## Goal alignment

This work is a subgoal of Candor's existing local-only desktop mission. It adds
the trusted packaging and runtime boundary for zero-setup local AI without
changing recording ownership, storage, network policy, or the Electron to Rust
architecture.

## Accepted decisions

1. Keep direct `whisper-rs` integration and package only the selected Whisper
   model. The locked `whisper-rs-sys` crate is the Whisper runtime supply-chain
   boundary.
2. Add a separate, read-only bundled manifest. Do not add a spoofable `bundled`
   flag to the existing user-managed manifest.
3. Electron main supplies `CANDOR_AI_BUNDLE_ROOT` when it spawns the Rust core.
   Renderer input can never choose the root, executable, model, or arguments.
4. Managed user assets remain an Advanced override. A verified bundle is the
   zero-setup fallback.
5. Build verification fails closed. Runtime corruption disables only the
   affected AI capability and never blocks recording or meeting access.
6. Development fixtures are explicitly marked and can never be release-ready.
7. A signed reinstall or full signed update is the only baseline repair path.
   This source wave adds no download or updater behavior.

## Claude review reconciliation

Claude's plan review correctly endorsed the existing inference engines, trusted
Electron root injection, first-use verification, pathless readiness API, SBOM
coverage, and the hard stop on selecting an LLM without licensing and benchmark
evidence.

The following recommendations were rejected or refined:

- The existing user manifest will not gain a `bundled` flag. A separate schema
  gives packaged and writable assets different trust boundaries.
- A corrupt bundle will not terminate the core. That would conflict with the
  requirement that recordings remain accessible when AI is damaged.
- Bundled Whisper resolution does require a model-manager change because the
  current verified path is limited to the user data directory.
- Packaging will not point at missing placeholder binaries. A valid non-ready
  metadata bundle is packaged now; strict release verification remains blocked
  until real assets are staged.

## Source-wave deliverables

- Bundled manifest schema, resolver, first-use verifier, and path containment.
- Bundled speech fallback and bundled language fallback.
- Pathless `ai.bundledAssetsStatus` RPC and exact preload method.
- Electron trusted-root injection and external resource packaging.
- Non-strict source build gate and strict release gate.
- AI asset SBOM entries when files are actually present.
- Normal UI readiness and repair states with manual controls kept in Advanced.
- Unit, protocol, packaging, corruption, and data-access regression tests.

## Deliberately blocked gates

- Default LLM selection and redistribution approval.
- Quantization provenance and meeting-quality evidence.
- Real bundled model/runtime hashes and signed installer inclusion.
- 8 GB, 16 GB, and 32 GB hardware benchmarks.
- Clean offline installer and upgrade proof.
- 5, 30, 60, and 180-minute physical-session validation.
- Windows signing, macOS notarization, and Linux package validation.

The source wave is complete only when its automated checks pass and an
independent Claude review has no unresolved high-severity source finding. It
does not make the public beta release-ready.
