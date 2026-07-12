# Candor v3 Failure Path Matrix

## Automated Now

| Failure path | Enforcement | Automated evidence |
|---|---|---|
| Malformed protocol version | Strict version handshake | `core/contracts.test.ts`, `core/candor-client.test.ts` |
| Malformed entity payload | Field-level parser failure | `core/contracts.test.ts` |
| Duplicate start or stop work | Capture machine and exclusive action registry | `state/operation-machines.test.ts`, `state/request-coordinator.test.ts` |
| Stop while startup is pending | Explicit `starting -> stopping` transition | `state/operation-machines.test.ts` |
| Renderer restart during recording | Core fact reconciles the capture state | `state/operation-machines.test.ts` |
| Stale meeting response | Request token invalidation | `state/request-coordinator.test.ts` |
| Notes and export race | Shared `document-write` exclusion scope | `state/request-coordinator.test.ts` |
| Local AI cancellation | Explicit canceling state and reset | `state/operation-machines.test.ts` |
| Whisper and LLM overlap | Single local-model scheduler | Rust scheduler tests and `m2:local-model-scheduler-smoke` |
| Model integrity failure | Expected SHA-256 required before managed copy | model manager and instruct asset tests |
| Vault key loss or wrong key | Wrong key cannot read SQLCipher data | Rust vault tests and `m1:vault-smoke` |
| Manifest migration | Version 1 manifests remain readable and upgrade on write | Rust recording store tests |
| Interrupted manifest replacement | Flushed backup or temp remains readable | Rust recording store tests |
| Corrupt primary manifest | Valid backup is used | Rust recording store tests |
| Audio storage write failure | No chunk metadata is committed | Rust recording store tests |
| Storage root creation failure | Explicit error and no partial manifest | Rust recording store tests |
| Empty library | Actionable local-first empty state | `features/product-surface.test.tsx` |
| Technical setting overload | Advanced disclosure is closed by default | `features/product-surface.test.tsx` |
| Privacy receipt path exposure | Receipt is core-backed and pathless | Rust and renderer contract tests |

## Packaged And Hardware Gates

These require packaged builds, OS facilities, or physical devices and cannot be
honestly replaced by unit tests:

| Gate | Required evidence |
|---|---|
| True disk exhaustion | Packaged recording on a quota-limited volume reports failure, preserves prior chunks, and remains recoverable |
| Physical microphone and loopback | Real capture proof on Windows, macOS, and Linux |
| Thirty-minute forced kill | Recovery loses no more than one flushed chunk on every OS |
| Clean-machine install | Installer launch, sidecar placement, permissions, and uninstall proof |
| Signing and notarization | Authenticode, Apple notarization, and Linux artifact signing evidence |
| Network denial | Firewall or packet-capture proof from packaged binaries on every OS |

No hardware gate is marked complete from a synthetic fixture. The release audit
must keep these items open until its corresponding artifact exists.
