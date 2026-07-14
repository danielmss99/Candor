# SPEC-3 Acceptance Status

Status recorded on 2026-07-13.

## Implemented

- A separate read-only packaged-asset manifest and strict release verifier.
- Immutable runtime and model candidate locks with license and provenance
  fields.
- SHA-256 verification at release verification and before first runtime use.
- Canonical containment, symlink, traversal, alternate-data-stream, size, and
  duplicate-selector defenses.
- Trusted Electron resource-root injection and assets outside ASAR.
- Managed local assets as an Advanced override with the verified package as the
  default fallback.
- Fixed executable and argument ownership in Rust with no shell and no local
  HTTP server.
- Pathless `ai.bundledAssetsStatus` RPC and exact preload operation.
- Checking, ready, unavailable, incompatible, corrupt, and repair-required
  product states.
- Recording and existing meeting access remain available when bundled AI is
  absent or corrupt.
- Signed-installer-only repair policy with no startup or background download.
- SBOM generation that inventories real bundled assets when they are present.
- Advanced manual setup remains available without dominating the normal UI.
- Cross-platform CI contract for package verification and packaged-core smoke.

## Source-complete, release-blocked

The source implementation for Gate B, packaged asset interfaces, is complete
and locally verified. The release gates below remain deliberately closed:

| Gate | Status | Required evidence |
| --- | --- | --- |
| Gate A: critical reliability | Partial | Physical capture, disk-full, upgrade, and long-session evidence |
| Gate B: packaged interfaces | Complete | Automated source and Windows package checks pass |
| Gate C: selection | Blocked | Legal review, provenance, quality, and 8/16/32 GB benchmarks |
| Gate D: Complete installer | Blocked | Real selected assets, notices, model cards, complete SBOM, offline clean install |
| Gate E: signed beta | Blocked | Signing, notarization, cross-OS artifacts, network-deny and upgrade proof |

## Completion decision

SPEC-3 is not fully complete under its own completion definition. This branch
implements the secure boundary needed to add selected assets later without
weakening local custody or data access. It must not be labeled a Complete public
beta until the strict verifier, release-readiness audit, hardware matrix,
physical-session matrix, clean-machine tests, and signing proofs all pass.
