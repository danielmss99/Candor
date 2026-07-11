# V3 Staged Verification Proof

Status: **implemented aggregate local verifier**

## Purpose

Candor v3 has milestone-specific proof gates. This aggregate verifier makes the
from-scratch lane harder to accidentally under-test by running the full local
milestone stack in one command before packaging.

## Command

```powershell
npm run v3:verify
```

On Windows the runner uses Windows PowerShell for `scripts/m0-verify.ps1`. On
Linux and macOS it uses `pwsh` for the same M0 script.

## Covered Gates

`scripts/v3-verify.mjs` runs:

- deterministic application icon reproducibility
- M0 CI contract smoke
- M0 local verification, including Electron hardening, proof-audit self-test,
  sidecar smoke, renderer typecheck, and renderer build
- V3 source security proof, including env-file tracking, git ignore, compile-time
  secret export, and calendar plaintext fallback checks
- V3 updater policy proof, including no Electron auto-updater, no crash reporter
  startup, no background update checks, and no attempted external calls
- M1 durable recording, crash recovery, consent, and capture service smoke
- M1 SQLCipher vault proof
- M2 local library, replay, model manager, scheduler, and transcription boundary
- M3 product surface proof
- M4 local heuristic recap proof, local instruct preflight proof, local
  instruct fixture proof, and strict-harness quality self-test
- M5 v2 import proof
- Vitest regression suite

The Rust core also passes the strict all-feature lint gate:

```powershell
cargo clippy --manifest-path crates/candor-core/Cargo.toml --all-features --all-targets -- -D warnings
```

The runner writes:

```text
release-v3/proofs/v3-local-verification-<platform>-<arch>.json
```

The M0 proof audit reports this as the staged-verification gate for each
platform. In strict mode, missing or failed staged-verification artifacts block
M0 exit readiness just like missing smoke, network, or manifest artifacts.

## Boundary

This aggregate proof is not the M0 exit gate. M0 still requires packaged smoke,
artifact manifests, and OS-boundary network-deny proof on Windows, macOS, and
Linux. `npm run v3:verify` proves the local staged implementation, while
`npm run m0:proof-audit:strict` proves whether the complete uploaded M0 proof
set is exit-ready.

The strict real llama.cpp and GGUF quality gate is intentionally separate from
the routine staged verifier because it requires user-installed model assets.
Run `npm run m4:real-local-instruct-proof` when those assets are configured. A
passing Windows x64 artifact now exists for the verified llama.cpp b9959 runtime
and Qwen2.5 1.5B Instruct Q4_K_M model. The `:allow-missing` command remains for
machines where the explicit local assets are not installed.

`npm run v3:verify` also does not claim real Whisper inference in default
builds. The stricter local Whisper toolchain and feature-build gate is
`npm run m2:whisper-preflight`.

For the top-level release view, run:

```powershell
npm run v3:release-readiness-audit
```

Strict release readiness is:

```powershell
npm run v3:release-readiness-audit:strict
```

That audit records the full-mission gap list, including cross-OS packaged
network proof, strict real capture, real Whisper inputs, and real local Whisper
inference.

For the original objective mapped requirement by requirement to current proof
artifacts, run:

```powershell
npm run v3:goal-audit
```

Strict goal audit is:

```powershell
npm run v3:goal-audit:strict
```
