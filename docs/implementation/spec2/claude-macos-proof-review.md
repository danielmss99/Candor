---

## Review: macOS PKTAP Attribution Hardening

I reviewed the complete diff plus surrounding context, traced the two-pass correlation algorithm end-to-end, and checked every condition in the spec against the implementation. Here is the adversarial analysis.

---

### Observed defects

**There are no required findings.** The following are verified absences of defects:

---

### Verification against the eight required conditions

Working through each condition against the actual code paths:

**Condition 1 — Nonzero flow ID**
`flowCorrelationKey` at line 148 returns `null` for `!packet.flowId`, the empty string, or `packet.flowId === "0x0"`. A null key causes both the first-pass owner registration and the second-pass candidate lookup to skip the packet. `flowCorrelationKey(packet) !== null` is required by `isProcesslessKernelControlCandidate`, so a candidate with a missing or zero flow ID never enters the correlation path at all — it lands in `packetsWithoutProcessMetadata` and the proof fails. Solid.

One edge: `=== "0x0"` catches only the single-zero representation. Apple's tcpdump uses `0x%x` (literal prefix, non-padded), meaning `printf("0x%x", 0)` → `"0x0"`, so the comparison is exact. `0x00` would not appear from a standard implementation and there is no practical gap.

**Condition 2 — Outbound TCP**
`isProcesslessKernelControlCandidate` checks `packet.direction === "out" && packet.transportProtocol === "TCP"`. The first-pass candidate-owner loop independently gates on `packet.direction !== "out" || packet.transportProtocol !== "TCP"` and skips. Both passes enforce this independently.

**Condition 3 — TCP RST with zero payload**
`packet.tcpFlags.includes("R") && packet.payloadLength === 0`. Only `isProcesslessKernelControlCandidate` packets enter the correlation output. `payloadLength: null !== 0`, so a missing `length` field returns null and fails the `=== 0` check — fail-closed. ✓

**Condition 4 — Exact 5-tuple + flow ID match**
`flowCorrelationKey` encodes all five fields (`flowId`, `networkProtocol`, `transportProtocol`, `sourceEndpoint`, `destinationEndpoint`) as a single pipe-joined string. Partial matches cannot produce a hit because all five fields are required to form a key; any missing field returns null. The matched packet's key is the same key used to write and read the map. The `matchedFlow` receipt echoes all five fields for the audit to cross-check.

**Condition 5 — Named process with positive PID**
`hasNamedProcessAttribution` at line 132 requires `pid > 0 && processName.length > 0` OR `effectivePid > 0 && effectiveProcessName.length > 0`. The first-pass loop skips any packet that fails this predicate. Kernel packets (`pid === 0`) are correctly excluded from becoming background owners.

**Condition 6 — Not Candor by name or PID**
The `applicationAttributed` guard in `correlateKernelControlPackets` checks:
```js
applicationProcessIds.has(packet.pid)       // whole observed Candor process tree
applicationProcessIds.has(packet.effectivePid)
isCandorProcessName(packet.processName)
isCandorProcessName(packet.effectiveProcessName)
```
A packet attributed to Candor (by any of the four fields) is skipped from the owner map. The Candor self-test at line 423 verifies this explicitly.

**Condition 7 — Ambiguity detection**
The `ambiguousFlows` Set is populated whenever a second distinct owner is seen for a key. The `processOwnerSignature` function encodes all four ownership fields; two packets with different PIDs or process names on the same flow produce different signatures and mark the flow ambiguous. Once marked, the flow can never produce a correlation (`!ambiguousFlows.has(key)` is checked in both the first and second pass). Flows that enter the ambiguous set cannot exit it.

**Condition 8 — Unmatched processless packets fail the proof**
`flowCorrelatedPacketIndexes` is the set of `packetIndex` values for successfully correlated packets. The `packetsWithoutProcessMetadata` filter at line 872 excludes only packets whose index is in that set. Any outbound packet that has no primary attribution, no effective attribution, and no correlation index lands in `packetsWithoutProcessMetadata`. This array must be empty for `complete = true`, and `complete` is a terminal gate on the proof and on `throw`s at lines 1019–1021.

---

### Adversarial: can a Candor packet be reclassified?

No. For reclassification to occur a packet would need:
- **Zero PKTAP attribution** — `!hasPrimaryAttribution && !hasEffectiveAttribution`. Any packet Candor owns is attributed by PKTAP at socket creation time in the kernel, before userspace sees it.
- **Zero-length TCP RST** — `payloadLength === 0 && tcpFlags.includes("R")`. RSTs with payload zero carry no data. Application-level exfiltration cannot be expressed as a zero-payload RST.
- **Exact prior match** — a named non-Candor process must have sent an earlier packet on the exact same flow ID and 5-tuple. Candor cannot predict or control the flow IDs assigned by the kernel to system services.

The combination renders the attack surface empty in any realistic model. The only packets affected by this rule are kernel-generated RSTs sent after the kernel tears down connections it was proxying on behalf of an already-attributed system service — exactly the failure case that triggered the CI failure.

---

### Fail-closed audit of receipt fields

The `validateMacosFlowCorrelations` function in `m0-proof-audit.mjs` independently validates every field on each sample:

| Field | Audit check |
|---|---|
| `reason` | Must equal exact constant string |
| `flowId` | `/^0x[1-9a-f][0-9a-f]*$/` — nonzero, nonleading-zero hex |
| `networkProtocol`, `transportProtocol` | Must be `IP`/`IP6` and `TCP` |
| `sourceEndpoint`, `destinationEndpoint` | Non-empty strings |
| `direction`, `tcpFlags`, `payloadLength` | `out`, contains `R`, exactly `0` |
| `matchedFlow.*` | All five fields must equal the sample's own fields |
| `matchedProcess` | Positive PID, non-empty name, not Candor |
| Count vs samples | `samples.length === Math.min(count, 25)` |
| Inclusion in kernel total | `kernelAttributedPacketCount >= count` |

The receipt is independently verifiable. Mismatched correlation evidence fails the audit.

---

### Malformed or missing metadata

- Missing `flowId` → `flowCorrelationKey` returns null → packet is not a candidate → lands in `packetsWithoutProcessMetadata` → proof fails.
- Missing `tcpFlags` → `isProcesslessKernelControlCandidate` fails `typeof packet.tcpFlags === "string"` → not correlated → proof fails.
- Missing `payloadLength` → parsed as `null`; `null === 0` is false → not correlated → proof fails.
- Missing `transportProtocol` → `flowCorrelationKey` returns null → not correlated → proof fails.
- Missing `direction` → parser returns `null`; the candidate check requires `"out"` → not correlated → proof fails.

Every malformed packet is fail-closed by construction.

---

### `NPDfF` flag correctness

The Apple tcpdump man page (referenced source) documents `N` = process name, `P` = PID, `D` = direction, `f` = flow identifier, `F` = additional PKTAP flags. The parser self-tests use packets containing all three new fields (`flowid`, `Flags`, `length`) in the format that `-k fF` is expected to produce, and the test passes. The `so` field (socket origin) appeared in the old `NPD` output too, confirming that `F` doesn't add it. The format is consistent with the Apple documentation and the referenced tcpdump source.

---

### Optional improvements (not required)

**1 — Missing ambiguity-detection self-test**
`m0-network-deny-macos.mjs` lines 408–431 test the main correlation path and the Candor-block path, but there is no test for: *same flow key, two different non-Candor owners → zero correlations*. The ambiguity detection code is logically correct (shown by the analysis above), but this path has no automated regression guard. The existing `unrelatedKernelReset` test uses a *different* flow ID, not the same flow ID with two owners.

Suggested test addition (after the existing correlation test):
```js
const secondOwnerPacket = parsePktapPacket(
  "00:00:00.000010 (proc mDNSResponder:99, out, so, flowid 0xabc123) IP 192.168.64.2.58230 > 17.253.5.154.443: Flags [P.], length 40",
);
const ambiguousReset = parsePktapPacket(
  "00:00:00.000011 (out, flowid 0xabc123) IP 192.168.64.2.58230 > 17.253.5.154.443: Flags [R], length 0",
);
if (
  correlateKernelControlPackets([
    namedBackgroundPacket,
    secondOwnerPacket,
    ambiguousReset,
  ]).length !== 0
) {
  throw new Error("macOS PKTAP correlation must reject ambiguous-owner flows");
}
```

**2 — Missing temporal-ordering self-test**
No test verifies that a processless RST appearing before any named attribution packet is rejected. The two-pass design with `matched.packetIndex >= packetIndex` handles this correctly, but it is untested.

**3 — `processOwnerSignature` separator collision**
`processOwnerSignature` joins with `|`. A macOS process name containing `|` (unusual but syntactically legal) could produce ambiguous signatures, either failing to detect ambiguity or falsely detecting it. In practice, system process names do not contain `|`, so the risk is theoretical. A JSON-style encoding or a dedicated separator (e.g., `\x00`) would eliminate it.

**4 — `isCandorProcessName` / `isCandorProcessLabel` duplication**
The function exists identically in both `m0-network-deny-macos.mjs` (line 321) and `m0-proof-audit.mjs` (line 302) under two names. The files have no shared import. A future change that updates one and misses the other would silently diverge. Since Candor process name matching is security-critical, this duplication is the most maintenance-relevant observation.

**5 — `0x0` zero check is not exhaustive (low confidence, theoretical)**
`flowCorrelationKey` filters `packet.flowId === "0x0"`. The audit regex `/^0x[1-9a-f][0-9a-f]*$/` also rejects it. Both are correct for Apple's `printf("0x%x", n)` output format, which never produces leading zeros. If a future tcpdump version zero-pads (e.g., `0x00000000`), neither check would catch it. Unlikely but worth a note.

---

### Verdict

**approve**

There are no required findings. The correlation rule is evidence-backed, enforces all eight conditions from the spec, is fail-closed for any unmatched processless packet, and cannot be used to reclassify Candor traffic. The receipt records sufficient evidence for independent audit. Malformed or missing metadata always falls through to the unattributed packet gate, causing the proof to fail. The `NPDfF` format string is consistent with Apple's documented `-k` flag characters.

The optional improvements above (especially the ambiguity-detection self-test and the duplication of `isCandorProcessName`) are low-urgency but worth a follow-up pass.
