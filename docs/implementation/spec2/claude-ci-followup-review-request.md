# Claude CI follow-up review request

Review the uncommitted fix for the Ubuntu and macOS failure in GitHub Actions
run `29271594451`. This is a read-only review. Do not modify files.

Inspect:

```text
git diff
git diff --check
electron/core/core-client.ts
electron/test-core/controllable-core.mjs
electron/test-core/controllable-core.test.ts
```

## Failure

The oversized-response fault-harness test used a 24 MB child-process write and
a 2-second handshake timeout. On Ubuntu and macOS hosted runners, the handshake
timed out before the entire oversized line reached `CoreClient`, so the test
received `candor-core timed out for core.version` instead of the intended
`boundary limit` protocol fault.

## Fix

- Add the internal `maxResponseLineBytesForTesting` CoreClient option.
- Keep the production fallback at `MAX_CORE_RESPONSE_LINE_BYTES`.
- Use a 1,024-byte test limit only for the `oversized-line` harness mode.
- Reduce that harness payload to 2,048 bytes.

No production construction site sets the testing option.

## Verification

- The fault-harness file passed once after the change.
- Five additional consecutive fault-harness runs passed.
- `npm run electron:v3:build-main` passed.
- `npm run v3:verify` passed with 87 Rust tests and 134 Vitest tests.
- `git diff --check` passed before this request artifact was added.

## Required response

1. State whether the fix preserves the production response-line limit.
2. Identify any correctness, security, or test-quality regression with severity,
   file and symbol, evidence, impact, concrete fix, and proving test.
3. Return one verdict: `approve`, `approve with non-blocking follow-ups`, or
   `changes required`.
