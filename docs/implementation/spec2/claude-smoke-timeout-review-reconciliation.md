# Claude Review Reconciliation: Durable Smoke RPC Budget

Date: 2026-07-13

Claude reviewed the final two-script timeout diff and returned `approve` with no required defects.

## Disposition

- Required findings: none.
- Optional S1, raise sibling one-chunk smoke timers: not applied. Both sibling scripts passed on the same hosted Windows runner that exposed the eight-chunk timeout. The current change remains limited to the two paths with reproduced evidence.
- Optional S2, name the process-exit timeout: not applied. It controls post-kill process cleanup, not durable RPC work, and changing it would expand this CI repair without behavioral evidence.
- Optional S3, await M2 process exit before temporary-directory cleanup: deferred as a pre-existing follow-up. It was not implicated in the hosted timeout and is outside this focused change.

## Evidence

- `npm run m1:capture-crash-smoke`: 6 consecutive passes.
- `npm run m2:local-library-smoke`: 6 consecutive passes.
- The 20-second budget applies only to each request in the two Node smoke clients.
- Electron, Rust protocol, and product timeouts are unchanged.
- A stalled request still fails deterministically after the bounded test budget and reports both the method and timeout duration.

Review artifacts:

- `claude-smoke-timeout-review-request.md`
- `claude-smoke-timeout-review.md`
- `claude-smoke-timeout-followup-review-request.md`
- `claude-smoke-timeout-followup-review.md`

## Follow-up review

The first complete staged rerun exposed an independent test-harness defect in
`electron/test-core/controllable-core.test.ts`: the 200 ms timeout intended for
a hung `core.status` request also constrained the preceding `core.version`
handshake. The failure reproduced in isolation.

The helper now supports a separate handshake budget. Existing callers preserve
their prior behavior by default, while the ordinary-request hang test allows a
2-second handshake and retains its strict 200 ms target-request timeout. The
focused 12-test file passed 10 consecutive runs.

Claude reviewed the complete final diff after this correction and again returned
`approve` with no required defects. Its optional notes concerned pre-existing
M2 process-exit diagnostics and an implicit test-mode naming convention; neither
was implicated by the failures or required for this focused repair.
