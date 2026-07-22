# Superwhisper Improvements Research Evidence

Date: 2026-07-19, extended 2026-07-21

## Repository snapshot

- Workspace: `C:\Claude_Config\candor`
- Branch: `main`
- Starting status: clean and synchronized with `origin/main`
- Active architecture: sandboxed React renderer, narrow Electron preload and main-process IPC, JSONL stdio to Rust `candor-core`
- Product boundary: meeting-first, local-first, no required account, no meeting-data network capability

## Pre-implementation Candor baseline, 2026-07-19

- First-run setup is implemented in `v3/renderer/src/features/onboarding/ActivationFlow.tsx` and `useOnboardingSettings.ts`.
- The microphone step records Candor consent only. It does not enumerate devices, open a test stream, display levels, or verify OS access.
- Rust already enumerates CPAL input devices through `capture.devices`; renderer code does not consume that result.
- Capture device identifiers are current enumeration ordinals such as `input-0`, so persistent selection needs a fingerprint and safe fallback.
- No Electron `globalShortcut` service, shortcut persistence, tray, or background lifecycle exists.
- Transcript storage is append-only and search is currently literal substring matching.
- Terminology dictionaries, correction proposals, local model verification, background jobs, privacy receipts, and source-grounded recap already exist.
- `docs/mcp-server.md` is an unimplemented, outdated direct-file Node sketch. It is not part of the active app.

## Superwhisper first-party evidence reviewed

The initial research used current first-party documentation, changelog entries,
product pages, official GitHub repositories, and timestamped official YouTube
captions. On 2026-07-21 the user-installed Windows application was also opened
and inspected through observable UI, configuration field names, and package
metadata. It was not decompiled, debugged, modified, or used as a source of code,
prompts, recordings, or redistributable model assets. Vendor performance or
compliance claims were not treated as independently proven.

- Setup: https://youtu.be/92Ou2R0lgTw
- Settings: https://youtu.be/i4DljXkX-3M
- Modes: https://youtu.be/0fweM866LxQ
- Custom modes: https://youtu.be/2Up7UDsh3J4
- Super Mode: https://youtu.be/HWGDTbxBhGw
- Model library: https://youtu.be/Cj0Pd4luZWo
- Meetings: https://youtu.be/dJoYbiSitoQ
- Vocabulary: https://youtu.be/dZRdEg1d_AI
- History: https://youtu.be/_b-sG-78PDc
- Agent integration: https://youtu.be/TppWoG8v7AU
- CLI and MCP: https://youtu.be/v79Pp8DF2Po
- Current models: https://superwhisper.com/models
- Current changelog: https://superwhisper.com/changelog
- Sensitive-data guidance: https://superwhisper.com/docs/security/sensitive-data

## Product conclusions

Superwhisper is currently stronger at instant system-wide invocation, live feedback, task presets, model presentation, transparent processing history, deterministic replacements, reprocessing, and agent reuse.

Candor is stronger as a private meeting evidence system because it already provides durable mic and system capture, recovery, local custody, governed terminology, source-linked AI, review-before-export, and a narrower privacy boundary.

The implementation should import Superwhisper's interaction and observability ideas without copying cloud routing, ambient application context, clipboard capture, arbitrary cursor insertion, invisible recording, or required account behavior.

## Local AI handoff observations, 2026-07-21

- Superwhisper separates voice recognition from optional language-model
  processing. Its History distinguishes the voice result from the AI result and
  exposes processing configuration for diagnosis and reprocessing.
- The observed default Windows mode selected Parakeet V3 for voice recognition
  while reporting no configured language model. This confirms that the second
  stage is optional rather than part of Parakeet itself.
- The installed package contained Parakeet V3 INT8 ONNX assets and several local
  chat-template families. These observations establish product architecture only;
  Candor will obtain independently licensed and pinned artifacts.
- NVIDIA publishes Parakeet TDT 0.6B V3 under CC BY 4.0 with 25 documented
  languages. The official NeMo path prefers Linux, while sherpa-onnx documents a
  Windows-capable INT8 conversion and C/Rust-compatible runtime. Candor therefore
  requires separate Windows runtime, conversion, license, and benchmark proof.
- The safe Candor design keeps speech and text models in separate catalog
  sections and preserves raw, cleaned, and summary artifacts instead of replacing
  one result with another.

## Non-invasive Windows package triage, 2026-07-21

- Windows uninstall metadata reports superwhisper 1.5.1. The main executable's
  embedded product and file version report 1.5.0, so product conclusions rely
  on the observed UI and not on a single version string.
- The installed executable is a 64-bit PE32+ image with nine sections and a
  valid Authenticode signature from SuperUltra, Inc.
- Main executable SHA-256 at inspection time:
  `C3E2C69493580434D587FFFE202A13FD7A30FF8E2C1732D1BCD4EEAB69FA74A8`.
- This triage was read-only. No disassembly, decompilation, debugger attachment,
  runtime patching, credential inspection, user recording access, or asset reuse
  was performed.
