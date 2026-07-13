# Claude Phase 7 Review Reconciliation

Date: 2026-07-12

Claude returned **GO WITH REQUIRED FIXES** in
`claude-phase7-final-review.md`. Codex validated every finding against the
repository before changing code.

## Dispositions

| Finding | Disposition |
|---|---|
| H1 checksum and manifest package counts were not cross-validated | Accepted with a stronger fix. A shared release-artifact classifier now makes the M0 manifest cover the installer, blockmap, package metadata, and detached signatures that checksum generation covers. The producer requires exact two-way name/hash/count agreement, and the standalone validator rejects extra, absent, duplicate, path-shaped, and mismatched entries. Three direct validator tests and one artifact-name test cover the boundary. |
| H2 navigation denial used a fixed sleep | Accepted, but Claude's proposed `toHaveURL(initialUrl)` was not used because it can pass immediately while navigation is still pending. The test now arms a main-process `will-navigate` observer, triggers navigation, polls for the event, and proves `defaultPrevented: true` before checking the renderer URL. |
| M1 unused `CANDOR_NETWORK_POLICY` test environment variable | Accepted. The variable was not consumed by Rust and was removed from both the production core spawn environment and the Electron fixture. Network policy remains an unconditional Electron session control and a measured core status value. |
| M2 request-level Electron session hardening was not tested | Accepted. The security test now calls the window session's `fetch` against a non-routable external origin and requires the request to be rejected by the production session policy. |
| M3 axe legacy mode was undocumented | Accepted. The test explains that Electron exposes one sandboxed document with no iframe surface and that legacy injection avoids an unsupported second browser target. |
| L1 `test:electron` can use an existing build | Accepted as documentation, not a script defect. The release runbook already mandates `test:electron:build`; CI builds the app before calling the run-only command to avoid duplicate matrix builds. |
| L2 assert `devTools: false` through `getLastWebPreferences()` | Rejected after test. Electron returned `undefined` for that field even though `create-main-window.ts` explicitly sets `devTools: false`. The attempted assertion generated a false failure and was removed. Existing source and window-policy tests retain the enforceable check. |

## Verification After Fixes

| Check | Result |
|---|---|
| `npm test` | passed; 34 files and 105 tests |
| `npm run test:electron` | passed; 4 tests, including session request denial and prevented navigation event |
| `npm run m0:ci-contract-smoke` | passed |
| review-fixture M0 artifact manifest | included exactly the Windows installer and its blockmap |

The release package must be rebuilt after this source commit before artifact
manifest and checksum receipts can pass again. This is intentional source and
package provenance enforcement, not a release failure to bypass.

## Focused Re-Review

Claude confirmed that the two-way package binding and deterministic navigation
proof correctly close H1 and H2. It identified one Medium ambiguity in the new
session request test: `.invalid` would fail DNS even without Candor's guard. The
probe now uses `https://example.com`, which the current Electron session policy
cancels before outbound traffic. Removing that policy would allow a successful
response and fail the assertion. Claude stated that no further re-review is
required for this direct correction.
