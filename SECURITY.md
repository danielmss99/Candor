# Security Policy

## Supported Versions

Candor is prerelease software. Security fixes are applied to the current `main`
branch and the newest signed prerelease when one exists.

## Reporting A Vulnerability

Do not open a public issue for a vulnerability involving recordings,
transcripts, notes, vault state, model assets, license tokens, installers, or
update channels.

Send a private report to the maintainer who provided the build. Include the
Candor version, operating system, reproduction steps, impact, and sanitized
evidence. Do not attach another person’s meeting content or secrets.

## Security Commitments

- Meeting audio, transcripts, notes, and local AI processing stay on the device.
- The renderer remains sandboxed with Node.js disabled and context isolation
  enabled.
- The preload exposes product operations, not generic IPC, filesystem, process,
  executable, or path capabilities.
- Electron blocks arbitrary navigation, popups, webviews, and renderer network
  access.
- The Rust core communicates over stdio, not a localhost service.
- Model and runner imports require supported formats and expected SHA-256 values.
- Vault keys remain outside the renderer and use OS-backed storage where
  available.
- Diagnostics exclude meeting content, secrets, tokens, and complete sensitive
  paths.
- Existing recordings remain accessible when licensing or optional network
  services fail.
- Privacy claims are conditional on measured application state.
- Public release artifacts must pass path and secret scans and be signed.

## Optional Network Capabilities

Recording, transcription, local AI, and local export do not require network
access. Activation and future manual update checks are separate, user-initiated
capabilities and must be disclosed independently. Crash upload and behavioral
analytics are disabled by default.

## Release Evidence

`npm run v3:verify` is a local regression gate, not a complete release claim.
Clean-machine install and upgrade, real audio hardware, long-duration recording,
sleep and resume, device switching, signing, and OS network-deny evidence are
required before a production release.
