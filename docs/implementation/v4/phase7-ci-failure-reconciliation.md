# Phase 7 CI Failure Reconciliation

Date: 2026-07-12

GitHub Actions run `29240021253` produced:

- Windows M0: passed;
- V3 dependency audit: passed;
- macOS M0: failed in the Vitest regression suite;
- Linux M0: failed in the same Vitest regression suite test.

Both POSIX runners exposed the same defect in
`electron/core/core-client.test.ts`: a Windows-shaped missing executable path
was passed through host-native `path.basename()`. On macOS and Linux, Node did
not treat backslashes as separators, so `rendererSnapshot().executableName`
contained the complete path even though `rawPathExposed` was false.

The fix uses deterministic Windows basename semantics after normalizing forward
slashes. This strips both Windows and POSIX path prefixes on every host while
leaving the original executable path untouched for the internal spawn call.
The failure-state test now runs both path forms and requires exactly
`missing-core.exe` in the renderer snapshot.

Local verification after the fix:

- focused `core-client.test.ts`: 8 tests passed;
- full Vitest suite: 34 files and 105 tests passed.

The fix must pass a new Windows, macOS, and Linux matrix run before this CI
failure is considered closed.
