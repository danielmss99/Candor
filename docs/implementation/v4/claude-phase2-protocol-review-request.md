# Candor V4 Process And Protocol Review Request

You are reviewing a local-first Electron/React desktop recorder with a Rust
sidecar. Be adversarial. Do not praise the plan by default. Findings must cite a
file and line or an exact observable behavior, distinguish defects from optional
improvements, and include a concrete fix.

## Objective

Decide whether the current Electron main-process and Rust protocol boundary is
safe enough to become the foundation for the renderer decomposition. Prioritize:

1. renderer-to-main capability containment;
2. input and response validation;
3. process startup, timeout, crash, restart, and shutdown behavior;
4. active-capture safety;
5. duplicate/replayed IDs and bounded framing;
6. path, content, secret, or diagnostic leakage;
7. missing tests that can conceal a high-impact regression.

## Scope

Review commits `1f1afa3` through `6039f02` relative to their parent. Important
files:

- `electron/main.ts`
- `electron/core/core-client.ts`
- `electron/core/core-errors.ts`
- `electron/core/protocol.ts`
- `electron/core/request-registry.ts`
- `electron/ipc/core-ipc.ts`
- `electron/preload.cts`
- `electron/security/validate-core-input.ts`
- `electron/security/validate-sender.ts`
- `electron/window/create-main-window.ts`
- `electron/window/navigation-policy.ts`
- `crates/candor-core/src/main.rs`
- `scripts/source-security-rules.mjs`
- `docs/proofs/M0_IPC_THREAT_MODEL.md`

Review the related tests beside those files. Do not edit the repository.

## Implemented Boundary

- `electron/main.ts` is 126 lines and composes focused modules.
- Renderer has no Node.js and receives only frozen named product functions.
- The former generic `candor-core:call(method, params)` channel is gone.
- Main registers 43 dedicated renderer channels and maps each to a fixed Rust
  method and timeout.
- Every renderer core payload passes a method-specific validator before Rust.
- Electron generates UUIDv4 request IDs and exact timestamps.
- Rust validates versioned metadata, rejects duplicate IDs, and reads bounded
  4,000,000-byte frames without `lines()` pre-allocation.
- Electron requires matching response IDs, protocol version, typed errors, and
  a complete handshake.
- Restart is denied while capture is active. Timeouts do not kill a core already
  known to be capturing.
- Native picker channels validate the active main frame and return basenames,
  never complete paths.

## Compatibility Decisions And Known Gaps

- Direct M0-M5 proof scripts still use the old `{id, method, params}` envelope.
  Rust accepts that legacy shape only when all new metadata fields are absent.
  The production Electron client always uses the new envelope.
- JSON Schema files and generated TypeScript types are not implemented yet.
- Renderer-facing structured error UX and protocol mismatch recovery UI belong
  to the next renderer phase.
- Event subscription and job cancellation are not implemented yet.
- Core lifecycle state names are still `stopped/starting/running/stopping/exited/failed`;
  there is no explicit retry-budgeted `recovering` state yet.
- A timeout kills a non-capturing core. A timeout while capture is active marks
  the supervisor failed but leaves the process alive.

## Verification Evidence

- `npm run v3:verify`: passed after modular proof corrections.
- Rust: 66 tests passed.
- Vitest: 15 files, 58 tests passed.
- SQLCipher vault, capture/recovery, transcription, local AI, export, and v2
  importer staged proofs passed.
- Rebuilt release sidecar and unpacked packaged Electron smoke passed.
- Source-security audit: 95 checks and 6 mutation tests passed before the final
  protocol additions; the full source-security proof passed afterward.

## Required Response

1. Verdict: `Go`, `Go with required fixes`, or `Stop`.
2. Findings first, ordered Critical/High/Medium/Low.
3. For each finding: severity, file/line, evidence, impact, concrete fix, and
   whether it blocks renderer work.
4. Explicitly assess the legacy envelope compatibility path.
5. Explicitly assess timeout behavior during active capture.
6. List optional improvements separately.
7. State uncertainties where repository evidence is insufficient.
