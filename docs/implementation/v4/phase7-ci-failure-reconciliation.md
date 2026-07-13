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

## Second Matrix Run

GitHub Actions run `29241810155` closed the original defect:

- Windows M0: passed;
- Linux M0: passed, including packaged runtime, Electron/axe, and network denial;
- V3 dependency audit: passed;
- macOS staged verification, package, artifact, checksum, and packaged smoke:
  passed.

macOS then timed out in all four Playwright tests. The downloaded traces show
each test body reached its final assertion and hung only in `session.close()`.
Candor intentionally stays active on macOS after the last window closes, so
Playwright's generic close waited for process exit until the 90-second test
timeout.

The E2E harness now calls Electron `app.quit()` on macOS, bounds graceful close
to five seconds, and terminates the test child process only if it still has not
exited. This changes test teardown only; production macOS lifecycle behavior is
unchanged. A third matrix run is required to close the macOS gate.

## Third Matrix Run

GitHub Actions run `29244127917` proved the teardown correction and narrowed the
remaining failure:

- Windows M0: passed;
- Linux M0: passed;
- V3 dependency audit: passed;
- macOS staged verification, package, artifact, checksum, packaged smoke, and
  test teardown: passed;
- macOS Electron integration: one compact-layout assumption and two unsupported
  forced-scale assertions failed.

The macOS CI display constrained the application below the `1180px` compact-pane
breakpoint. Candor correctly displayed the `Transcript | Notes | AI` switcher
with Transcript active, but the workflow test tried to locate the hidden Notes
editor without selecting the Notes pane. The cross-platform test now selects
that visible pane before asserting the editor.

Electron's Chromium `force-device-scale-factor` switch is honored by the Windows
and Linux runners but not by the macOS runner, which reported a ratio of `1` for
both requested scales. The 125% and 150% tests now skip only on macOS with an
explicit reason. Windows and Linux remain the automated forced-scale evidence;
macOS retains its sandbox, workflow, accessibility, packaged-smoke, and native
network checks without claiming a scale condition the runner did not apply.

A fourth matrix run is required to close the macOS gate.
