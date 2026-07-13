## Review

### 1. Production response-line limit preservation

Yes, the production limit is fully preserved. `responseLineLimit()` (core-client.ts:498–502) only activates `testLimit` when it satisfies three independent guards: `typeof === "number"`, `Number.isSafeInteger()`, and `> 0`. An `undefined` option — which is what every production `CoreClient` passes — falls straight through to `MAX_CORE_RESPONSE_LINE_BYTES`. No production construction site sets the option, confirmed by reading the full file.

### 2. Correctness, security, and test-quality findings

**`responseLineLimit()` called once per `handleStdout` invocation, not per loop iteration**
- Severity: none / informational
- File/symbol: core-client.ts:430, `handleStdout`
- Evidence: `const maxResponseLineBytes = this.responseLineLimit()` is hoisted above the `while` loop. Since `this.options` is set at construction and never mutated, the value is stable for the entire invocation. This is correct and slightly more efficient.
- Impact: nil
- No fix required.

**Triple guard robustness in `responseLineLimit()`**
- The guard rejects `Infinity`, `NaN`, negative values, `0`, and floats. The implementation is tighter than necessary for a testing-only hook, which is a positive quality signal, not a concern.

**Test limit (1,024 B) vs. payload (2,048 B)**
- The relationship `payload > test limit > 0` guarantees the fault triggers on the first chunk delivery without any timing dependency. The detection logic being tested is unchanged; only the threshold value differs from production, which is the exact intent.

**No cross-mode contamination**
- `clientFor()` passes `maxResponseLineBytesForTesting: undefined` for every mode except `"oversized-line"`, so all other test cases are unaffected.

**`git diff --check`**
- Only CRLF line-ending warnings (Windows working tree), no actual whitespace errors. Clean.

**Non-blocking follow-up (low-stakes)**
- `responseLineLimit()` is private and the guards are clearly correct, but there is no unit test exercising the guard for invalid inputs (`0`, `-1`, `Infinity`). A small parameterised test of `responseLineLimit` would lock in the defensive behaviour permanently. No change required for this PR.

### 3. Verdict

`approve`

The fix is minimal, targeted, and correct. It eliminates the CI timing race by shrinking both the payload and the per-test limit, preserves the production constant without indirection, and introduces no regression across any other harness mode or production code path.
