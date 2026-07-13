Now I have the complete picture. Let me analyze all four files carefully.

---

## Review: macOS PKTAP Proof Post-Reconciliation Diff

### `scripts/m0-process-identity.mjs` (new file)

The extracted module is exactly the function that was deleted from the producer:

```js
export function isCandorProcessName(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return (
    normalized === "candor" ||
    normalized === "candor-core" ||
    normalized.startsWith("candor helper")
  );
}
```

Both `m0-network-deny-macos.mjs` and `m0-proof-audit.mjs` import it via `"./m0-process-identity.mjs"`, which resolves correctly from `scripts/`. The logic is unchanged from the prior approved version. No issues.

---

### `scripts/m0-network-deny-macos.mjs`

**Parser additions**

`parsePktapPacket` gains six new fields. The `flowId` regex `/(?:^|,\s*)flowid\s+(0x[0-9a-f]+)(?:,|$)/i` matches the PKTAP metadata segment (content between parentheses, already extracted before this match). The value is immediately `.toLowerCase()`'d, so the stored value is always lowercase hex — consistent with the non-case-insensitive validator pattern `^0x[0-9a-f]+$` used in both producer and auditor. The endpoint and flag extractions operate on the outer `line` string at the IP/TCP layer, which is correct since those fields are outside the metadata parentheses.

**`hasPrimaryAttribution` and kernel-attribution separation**

`hasPrimaryAttribution` returns `true` for `pid === 0` packets (checking `pid === 0` explicitly as the fallback for an empty processName). This correctly excludes kernel-attributed packets from `isProcesslessKernelControlCandidate` via `!hasPrimaryAttribution`. There is no overlap between `explicitKernelAttributedPackets` and `flowCorrelatedKernelControlPackets`: a packet with `pid === 0` has primary attribution, cannot be a kernel-control candidate, and cannot appear in the correlated list. The union in `kernelAttributedPackets` is strictly disjoint.

**`processOwnerSignature` null handling**

`JSON.stringify([processName ?? "", pid ?? "", effectiveProcessName ?? "", effectivePid ?? ""])` — `null ?? ""` → `""`, but `0 ?? ""` → `0` (not nullish). This means `pid: null` and `pid: 0` serialize differently, which is correct: they are distinct owners. Packets with `pid: null` never enter `backgroundOwners` because `hasNamedProcessAttribution` requires `pid > 0`.

**`correlateKernelControlPackets` temporal ordering**

The first loop (building `backgroundOwners`) stores only the first named non-Candor owner for each flow key. The flatMap rejects any correlation where `matched.packetIndex >= packetIndex`, ensuring strict forward-only ownership. Ambiguous flows (two different owners on the same key) are deleted from `backgroundOwners` and added to `ambiguousFlows`; subsequent packets on that key are blocked from re-populating the map. The `ambiguousFlows.has(key)` check in the flatMap is redundant (matched would already be null) but is harmless as defense-in-depth.

The `packetIndex` on each `parsedPacket` comes from the `packets.map((line, packetIndex) => ...)` index — guaranteed to be a non-negative integer. The `Number.isInteger(packet.packetIndex) ? packet.packetIndex : arrayIndex` fallback is only exercised in the self-test (which passes raw `parsePktapPacket` output lacking the index field). Both branches use the same offset basis within their respective loops, so the temporal comparison is consistent.

**`FLOW_CORRELATION_EVIDENCE_LIMIT = 25` hard limit**

Added to the `complete` flag expression. If more than 25 correlations occur, `complete` is false and the proof throws before writing. The samples are sliced to 25 regardless, so no proof with incomplete evidence can be written and then pass the `complete` gate. Fail-closed. ✓

**Self-tests**

Five new self-tests cover: normal correlation, ambiguous-owner rejection, future-only ownership rejection, padded-all-zero flow ID rejection, and Candor-owned flow rejection. The `isCandorProcessName` bootstrap check at the start is correct for all three canonical Candor names and correctly rejects `"nsurlsessiond"`.

**`-k NPDfF` flag**

`NPDfF` adds `f` (flow ID) and `F` (TCP flags) to the previously-used `NPD` (process name, PID, direction). This is required for the new fields and consistent with the CI contract update.

---

### `scripts/m0-proof-audit.mjs`

**`validateMacosFlowCorrelations`**

Independently enforces:

1. Count is a non-negative integer and matches `samples.length` exactly (guaranteeing no truncated evidence).
2. Evidence limit matches the auditor's own hardcoded `MACOS_FLOW_CORRELATION_EVIDENCE_LIMIT = 25` — if the producer changes its constant without the auditor, this check fails.
3. Per-sample: `packetIndex >= 0`; exact `reason` string match; non-zero flow ID (same `^0x[0-9a-f]+$` pattern, lowercase); IP/TCP protocols; both endpoints non-empty; outbound direction; RST flag present; payload zero.
4. `matchedPacket.packetIndex < sample.packetIndex` — strict forward ordering, independently re-checked.
5. `matchedPacket` flow fields match `matchedFlow` fields match the sample's own flow fields — triple-agreement check on the identity tuple.
6. `matchedProcess` fields agree exactly with `matchedPacket` fields.
7. Named non-Candor owner (positive PID; not `isCandorProcessName`).
8. All `packetIndex` values across samples are unique.

Every structural invariant the producer encodes is independently re-derived by the auditor. The `MACOS_FLOW_CORRELATION_REASON` string is a separate constant from the producer's `FLOW_CORRELATION_REASON` — deliberate independent enforcement. Both are exercised by self-tests.

**New self-tests in `runSelfTest`**

- Mismatched `matchedFlow.flowId` → must produce the "exact PKTAP flow identifier" failure.
- Candor-named `matchedProcess` → must produce the "never classify a Candor-owned flow" failure.
- Data-bearing reset (`payloadLength: 1`) → must produce the "zero-length TCP reset" failure.
- Padded-zero flow ID (`0x00000000`) → must produce the "non-zero PKTAP flow identifier" failure.
- `flowCorrelatedKernelControlPacketCount: 26` with samples still at length 1 → must produce both the evidence-limit and "every packet must include audit evidence" failures.

All checks are positive assertions on the failure list (not just absence of success), which is correct.

**`metadataDisplay: "NPDfF"` gate added to `validateNetworkProof`**

The auditor now requires `captureConfiguration.metadataDisplay === "NPDfF"` in addition to the other capture config fields. The producer writes this field. The self-test fixture includes it. ✓

**Updated `metadataSource` string gate**

The auditor requires the exact long `metadataSource` string describing flow correlation. This is a string-equality check — any reversion to the old parser would break the audit. ✓

---

### `scripts/m0-ci-contract-smoke.mjs`

Single change: the contract check for `"NPDfF"` replaces `"NPD"`. This is consistent with the actual tcpdump invocation. ✓

---

## Required Defects

None identified.

---

## Optional Suggestions

**1. Redundant `ambiguousFlows.has(key)` in flatMap** — `backgroundOwners.get(key)` already returns `undefined` for ambiguous keys (they were deleted). The extra check is dead code. Not wrong, but adds noise.

**2. `processOwnerSignature` uses `""` as the null sentinel for PIDs** — `pid: null` serializes as `""` rather than something more obviously numeric. Since `hasNamedProcessAttribution` already guarantees no `null`-PID packet can enter `backgroundOwners`, this never fires on real data. Functionally fine.

**3. `FLOW_CORRELATION_REASON` constant is duplicated across producer and auditor** — a third module could export it alongside `isCandorProcessName`. Deliberately independent for auditor isolation; acceptable as-is since the self-tests enforce exact string equality.

---

## Verdict

**approve**

All six refinement areas (ambiguity negative self-tests, JSON.stringify owner signatures, padded-zero flow ID rejection, process-identity extraction, named-owner receipt evidence with ordering check, 25-correlation hard limit) are correctly implemented. The producer and auditor are consistent, independently enforcing the same constraints from opposite directions. No correctness, security, import, fail-open, or testing regressions are present.
