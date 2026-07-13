# V3 Source Security Proof

Status: implemented Electron/Rust source gate

## Purpose

The source proof records machine-readable evidence that the active Electron and
Rust application retains its local-first trust boundary. Missing source is a
failure and cannot be interpreted as an empty passing input.

The proof verifies:

- required Electron, renderer, Rust, packaging, and launcher files exist;
- sandbox, context isolation, Node.js denial, permissions, navigation, popup,
  webview, and Chromium network switches remain present;
- the preload exposes no generic filesystem, process, path, or IPC capability;
- renderer CSP blocks network connections and embedded content;
- root commands and packaging target Electron and the staged Rust core;
- active source contains no recognized hardcoded secret pattern;
- Rust JSONL frames are bounded and use stdio;
- the v2 importer remains canonicalized, contained, and originals-untouched;
- `.env` and `.env.local` remain ignored and no environment file is tracked.

Five in-memory mutation tests prove the audit rejects a missing main process,
disabled sandbox, generic preload file operation, hardcoded secret, and weakened
v2-import guarantee.

## Commands

```powershell
npm run audit:source:portable
npm run audit:source
npm run v3:source-security-proof
```

The proof is also part of `npm run v3:verify` and writes:

```text
release-v3/proofs/v3-source-security-proof-<platform>-<arch>.json
```

## Boundary

This proof does not replace package execution, artifact hash comparison,
OS-boundary network denial, signing, clean-machine installation, or real capture
evidence.
