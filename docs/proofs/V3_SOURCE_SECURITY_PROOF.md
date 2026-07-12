# V3 Source Security Proof

Status: **implemented source leak proof**

## Purpose

Candor v3 release readiness needs a machine-readable source security proof, not
only a terminal-only script. This proof wraps the existing
`scripts/audit-source-security.ps1` gate and records the same release-critical
checks as structured JSON.

The proof verifies:

- `.env`, `.env.local`, and `.env.production` are not tracked by git
- `.env` and `.env.local` are ignored by git
- `src-tauri/build.rs` does not export `CANDOR_GOOGLE_CLIENT_SECRET`
- `src-tauri/src/calendar.rs` does not fall back to plaintext calendar secrets
- no proof response exposes raw paths or key material to the renderer

## Commands

Run the proof directly:

```powershell
npm run v3:source-security-proof
```

The aggregate verifier also runs it:

```powershell
npm run v3:verify
```

The proof writes:

```text
release-v3/proofs/v3-source-security-proof-<platform>-<arch>.json
```

## Boundary

This proof is a source leak and local-secret handling gate. It does not replace
the M0 network-deny proof, package artifact hash proof, or release artifact
audit. On non-Windows runners, if PowerShell is unavailable, the Node proof
still runs the same structured checks and records that the PowerShell wrapper
was skipped.
