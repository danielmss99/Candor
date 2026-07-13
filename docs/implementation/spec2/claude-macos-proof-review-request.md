# Claude Review Request: macOS PKTAP Attribution Hardening

## Objective

Review the current uncommitted changes in `C:\Claude_Config\candor` adversarially. The changes address the only failed step in GitHub Actions run `29273425419`: three processless, zero-length outbound TCP reset records caused the macOS network proof to fail even though the same network flow had previously been attributed to `nsurlsessiond`, Candor had zero escaped packets, and Candor's isolated PF counters remained zero.

Do not agree by default. Determine whether the new correlation rule is evidence-backed, fail-closed, and unable to hide Candor traffic.

## Files to inspect

- `scripts/m0-network-deny-macos.mjs`
- `scripts/m0-proof-audit.mjs`
- `scripts/m0-ci-contract-smoke.mjs`

Run `git diff --` for those files and inspect surrounding code, not only this summary.

## Intended rule

A processless packet may be reclassified as kernel-control background traffic only when all of these are true:

1. PKTAP provides a nonzero flow ID.
2. The packet is outbound TCP.
3. It is a TCP reset with zero payload.
4. Its network protocol, transport protocol, source endpoint, destination endpoint, and flow ID exactly match an earlier packet.
5. The earlier packet has a named process with a positive PID.
6. The earlier packet is not attributed to Candor by process name, effective process name, or any observed Candor process PID.
7. Conflicting process owners make the flow ambiguous and therefore ineligible.
8. Every unmatched processless packet still makes the proof fail.

The receipt records the correlation reason, process owner, exact matched flow, and bounded samples. The combined proof audit independently validates these fields.

## Source basis

Apple's open-source PKTAP header includes process identity and `pth_flowid`. Apple's tcpdump implementation prints flow IDs when `-k f` is requested and documents `N`, `P`, `D`, `f`, and `F` as process name, process ID, direction, flow identifier, and flags. The parse command now requests `NPDfF`.

Primary references:

- https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/net/pktap.h
- https://github.com/apple-oss-distributions/tcpdump/blob/58aef51e406a84d34352a0a05946770037a25360/tcpdump/print_pktap.c
- https://github.com/apple-oss-distributions/tcpdump/blob/58aef51e406a84d34352a0a05946770037a25360/tcpdump/tcpdump.1

## Verification already run

- `node scripts/m0-network-deny-macos.mjs --validate-only`: passed, including parser and correlation self-tests.
- `npm run m0:proof-audit:self-test`: passed.
- `npm run m0:ci-contract-smoke`: passed.
- `npm run v3:verify`: passed with 87 Rust tests and 134 Vitest tests.
- `git diff --check`: passed.

## Review questions

1. Can a Candor packet be incorrectly reclassified by this rule?
2. Are flow ownership, ordering, ambiguity, delegated process identity, protocol, and endpoint checks sufficiently strict?
3. Does the receipt carry enough evidence for an independent audit?
4. Can malformed or missing metadata bypass the fail-closed behavior?
5. Are the positive and negative self-tests sufficient for this change?
6. Is `NPDfF` correct for Apple's tcpdump metadata output?

## Required response format

Lead with findings ordered by severity. Every finding must include:

- severity;
- file and line;
- concrete evidence;
- security or correctness impact;
- a specific fix.

Separate observed defects from optional improvements. End with one verdict: `approve`, `approve with required changes`, or `reject`. If there are no required findings, say so explicitly. Do not edit the repository.
