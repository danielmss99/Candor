# Claude Review: Durable Smoke RPC Budget

Review the current uncommitted diff in `C:\Claude_Config\candor` as an adversarial CI and reliability reviewer. Do not edit the repository.

## Context

GitHub Actions run `29279169255` failed on `windows-latest` during staged verification while `scripts/m1-capture-crash-recovery-smoke.mjs` waited for `capture.proofInterruptedSerializedWriter`. The command performs eight durable encrypted chunk writes and exceeded the smoke harness's fixed 5-second JSONL RPC timer. The Rust test suite had already passed 87 tests in that job.

A separate local M2 smoke run previously exceeded the same fixed 5-second timer while writing durable capture data. Focused reruns and a clean full verification then passed. These failures are confined to the Node smoke harnesses under machine contention; no Electron or Rust production timeout has been changed.

## Proposed change

- In `scripts/m1-capture-crash-recovery-smoke.mjs`, replace the fixed 5-second RPC timer with a named 20-second `smokeRpcTimeoutMs` budget and include the budget in the timeout error.
- Apply the same bounded change to `scripts/m2-local-library-export-smoke.mjs`, the other demonstrated durable-write smoke path.
- Leave all other smoke, Electron, protocol, and product timeouts unchanged.

## Verification already completed

- `npm run m1:capture-crash-smoke`: 6 consecutive passes.
- `npm run m2:local-library-smoke`: 6 consecutive passes.
- The prior commit passed the full local `npm run v3:verify`, Electron integration tests, dependency audit, source audit, packaging, SBOM, checksum, and release artifact checks.

## Review questions

1. Does this narrowly scoped 20-second test-harness budget mask a likely product hang or correctness defect?
2. Is 20 seconds bounded enough for CI while still failing deterministically on a stalled core?
3. Should the timer be per request, per durable-write operation, or split by method in these two small smoke clients?
4. Are the improved timeout diagnostics sufficient for a hosted failure?
5. Are any additional focused tests required before commit?

Inspect the actual diff and surrounding scripts. Prioritize correctness, hang detection, CI reliability, accidental production impact, and missing tests. Findings must include severity, file and line, evidence, impact, and a concrete fix. Separate required defects from optional suggestions. End with `approve`, `approve with required changes`, or `reject`.
