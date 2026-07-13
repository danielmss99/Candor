# Claude Follow-up Review: Final CI Timeout Diff

Review the complete current uncommitted diff in `C:\Claude_Config\candor`. This is a follow-up to your approved durable smoke RPC budget review. Do not edit the repository.

## Additional evidence and change

The complete `npm run v3:verify` passed all Rust tests and M0 through M5 proof clients, including both changed durable smoke scripts. Vitest then failed this test:

`electron/test-core/controllable-core.test.ts > bounds an ordinary request that hangs before responding`

The error was `candor-core timed out for core.version`. The test intended to allow startup and then prove a 200 ms timeout for a hung `core.status` request, but the helper applied the same 200 ms budget to the `core.version` handshake. The failure reproduced immediately in an isolated run.

The test helper now accepts a separate `handshakeTimeoutMs`, defaulted to the ordinary timeout so every existing call keeps its prior behavior. Only the `hang-before-response` test passes `2_000` for the handshake and retains `200` for the target request. Production code and product timeouts remain unchanged.

After this change, the full 12-test controllable-core file passed 10 consecutive isolated runs.

## Final diff under review

- `scripts/m1-capture-crash-recovery-smoke.mjs`: bounded 20-second per-request smoke budget for the demonstrated eight-chunk durable write.
- `scripts/m2-local-library-export-smoke.mjs`: the same bounded budget for the other demonstrated durable path.
- `electron/test-core/controllable-core.test.ts`: separate handshake and target-request budgets so the test measures the intended fault.
- Review request, response, and reconciliation artifacts under `docs/implementation/spec2/`.

Review for correctness, accidental reduction of hang detection, hidden production impact, test weakness, and unnecessary scope. Findings must include severity, file and line, evidence, impact, and a concrete fix. Separate required defects from optional suggestions. End with `approve`, `approve with required changes`, or `reject`.
