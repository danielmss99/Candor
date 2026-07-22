# Claude Parakeet Implementation Review Reconciliation

Date: 2026-07-21

Review artifact: `claude-parakeet-implementation-review.md`

The Claude collaboration helper completed a real invocation successfully. The
review did not begin with `CLAUDE INVOCATION NOT PERFORMED`. Claude found no
Critical or High defect and confirmed that the download, verification,
selection, default recommendation, sherpa-onnx dispatch, Whisper live fallback,
static-runtime enforcement, FFI surface, attribution, and SBOM requirements are
implemented.

## Finding dispositions

### DEF-1, Low: extracted-byte limit relied on tar header bounds

Disposition: accepted and fixed.

`copy_and_hash` now returns the actual extracted byte count. Installation
requires that count to match the pinned member size and applies the aggregate
decompressed-byte limit to actual copied bytes in addition to the existing
header-declared limit.

Verification:

- `node scripts/cargo-with-local-perl.mjs test --manifest-path crates/candor-core/Cargo.toml parakeet_package --features local-whisper`
- Result: 5 Parakeet package tests passed.

### DEF-2, Low: Windows remove-then-rename window for JSON metadata

Disposition: accepted as a bounded fail-closed limitation, no code change.

A crash in this window can remove the install manifest or verification cache.
It cannot mark an unverified package as verified. The next verification performs
a full member re-hash. Replacing the repository-wide Windows atomic-write
strategy is outside this focused correction.

### OBS-1, Informational: cancellation window before verification enqueue

Disposition: accepted and fixed.

The acquisition service now checks cancellation after the final byte and outer
SHA-256 check, before publishing `verifying` or calling
`models.importFinish.start`. A regression test cancels from the final
`models.importChunk` call and proves that staging is aborted and verification is
never enqueued.

Verification:

- `npm test -- electron/models/model-acquisition-service.test.ts`
- Result: 6 tests passed.
- `npm run electron:v3:build-main`
- Result: passed.

### OBS-2, Informational: additional Windows reserved names

Disposition: rejected as unreachable and unnecessary in this boundary.

Every file must exactly match the fixed `MEMBER_SPECS` allowlist before a write
can occur. None of those names is `CLOCK$` or an NTFS metadata name. Expanding a
secondary denylist would not change the accepted archive language.

## Gate result

No Critical or High finding was open before reconciliation. The two applied
changes are narrow hardening and cancellation-UX fixes, not material architecture
changes, so the plan's material-fix final-review trigger does not apply. The
focused affected tests and build were rerun successfully.
