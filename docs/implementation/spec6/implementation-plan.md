# SPEC-6 accepted implementation plan

Date: 2026-07-14

## Governing objective

Complete the repository-controlled AI, background task, dictionary, and release-boundary work needed for a safe local-first Windows beta. Keep signing, physical hardware, long-duration, clean-machine, and production-asset evidence fail-closed when those inputs are unavailable.

## Claude checkpoint

The initial authenticated Claude architecture and migration review is recorded in `claude-plan-review.md`. It reported no critical or high-severity findings. Its required and moderate findings were reconciled as follows:

- Reject the contradictory `heuristic-fallback` plus `require-local-llm` combination at the Electron boundary.
- Map unknown Local AI status to the stable, fail-closed `LOCAL_LLM_STATUS_UNKNOWN` code instead of forwarding untrusted arbitrary error text.
- Run dictionary staging retention at startup and every hour while the core remains active.
- Roll back oversized legacy dictionary migrations byte-for-byte, remove migration staging, and preserve unrelated jobs.
- Register dictionary task result schemas and validate completed task results before renderer state.
- Treat every renderer trust label other than `verified-candor` as community-unverified.
- Version the publisher trust anchor with a required rotation generation.

Two suggestions were not adopted. Raw migration backup paths are not logged because diagnostic paths may expose user identity or storage layout. A missing production publisher key remains a fail-closed release condition, while normal startup continues without claiming the bundled dictionary is trusted.

The focused AI/task review is recorded in `claude-ai-task-review.md`. Its one high, one medium, and one low finding were resolved by validating recording-priority cancellation states, parsing every forwarded task event in Electron, and making provenance rendering null-safe. Two earlier quota-limited attempts remain recorded as nonreviews.

The dictionary security review is recorded in `claude-dictionary-security-review.md`. It reported no critical, high, or medium findings. Both low observations were still resolved: dictionary descriptor cleanup now recovers a poisoned job lock after physical deletion, and encrypted job-store writes remove stale temporary files before exclusive creation.

The repository-wide final review is recorded in `claude-final-review.md`, with post-review actions in `claude-final-review-disposition.md`. Claude found no critical or high issues and considered the code suitable for a pull request. The one latent medium and all actionable low findings were resolved before packaging.

## Phase 1: explicit local AI execution

- Replace fast/best job routing with explicit local-LLM and heuristic-fallback modes.
- Automatic and normal manual recap and Ask use local LLM with disclosed fallback allowed.
- Retry with Local AI requires the local LLM and cannot silently fall back.
- Cancellation, shutdown, and recording-priority preemption remain pause or cancellation outcomes, never heuristic output.
- Add typed execution provenance and persist only safe processing facts.

## Phase 2: typed background tasks

- Upgrade the preload API to V3.
- Validate every task state, type, progress unit, error, provenance field, terminal invariant, and ETA invariant in Electron main.
- Replace renderer `JsonObject` task state with typed `BackgroundTask` values.
- Render queued, running, paused, cancelling, completed, failed, and cancelled accurately.

## Phase 3: private dictionary staging and migration

- Stage package bytes in encrypted Rust-owned files before a descriptor is persisted.
- Store only a random token, digest, safe display name, and byte count in the job store.
- Recheck file containment, type, size, digest, decryption integrity, package schema, and signature immediately before import.
- Migrate schema-v1 Base64 descriptors transactionally with a retained migration backup and rollback behavior.
- Apply bounded cleanup rules for terminal, retryable, expired, and orphaned staging files.
- Bound persisted Ask question retention and terminal job retention.

## Phase 4: dictionary precedence and trust

- Add scope, explicit preference, approved-correction history, semantic version, and resolution provenance.
- Resolve by meeting, project, organization, personal, specialist, general, then the documented stable tie-breakers.
- Keep project scope dormant until a real project identifier exists.
- Anchor Candor verification to a separately packaged public key. Self-signed and unknown publisher packages remain community-unverified.

## Phase 5: release tooling

- Define Standard as Turbo, multilingual Small, official Qwen Q4_K_M, pinned llama.cpp, one general dictionary, and one Candor public key.
- Define Maximum as Standard plus full large-v3.
- Add release-only resumable acquisition with exact byte and digest checks and atomic promotion.
- Keep weights and private keys outside Git and prohibit runtime downloads or web installers.
- Keep release readiness false until legal, benchmark, signing, hardware, install, upgrade, and provenance evidence exists.

## Verification and review

- Add focused Rust, TypeScript, Electron, accessibility, migration, tamper, and release-gate tests.
- Run the complete local verification matrix.
- Request focused Claude reviews after the AI/task boundary, after dictionary security, and after final verification.
- Resolve all validated critical and high findings before the pull request is marked ready.
