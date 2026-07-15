# Live Recording and Local AI Implementation Plan

## Objective

Restore trustworthy live recording feedback and install a complete local development AI bundle without weakening Candor's fail-closed public release gates.

## Accepted Plan

1. Add a core-owned `durationMs` value to the active capture status.
2. Prove the value is present and monotonic with a Rust regression test.
3. Add an explicit Windows x64 development-bundle installer.
4. Acquire only pinned official assets over HTTPS with exact byte and SHA-256 checks.
5. Reject unsafe archive entries and stage the full bundle before atomic promotion.
6. Keep the generated manifest non-release and non-fixture.
7. Verify the development bundle with Candor's existing verifier.
8. Prove strict release verification still fails closed.
9. Restart Candor and run real local transcription and local LLM smoke checks.

## Claude Review Resolution

Claude approved the timer contract and the non-release bundle design. Its ZIP traversal, atomic promotion, and end-to-end smoke-test findings are incorporated.

Claude described Qwen3 as using a restrictive Qwen license. That finding is rejected because the pinned official Qwen3-4B-GGUF repository declares Apache 2.0. The installer uses the license file from the exact pinned official revision, and release readiness remains false until Candor's formal redistribution record is completed.

## Release Boundary

This work installs a verified local development bundle for this workstation. It does not create a signed public installer, set `releaseReady` to true, or fabricate external licensing, signing, hardware, or clean-machine receipts.
