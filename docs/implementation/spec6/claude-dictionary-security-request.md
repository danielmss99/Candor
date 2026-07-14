# Claude review request: SPEC-6 dictionary security and migration

Review the current worktree on `codex/spec6-ai-release-completion` as an independent security and data-migration reviewer. The base commit is `9eaf4e220731127f7de601abf105bd0eab6342c1`.

Limit this checkpoint to:

- `crates/candor-core/src/dictionary_staging.rs`
- `crates/candor-core/src/dictionary_package.rs`
- `crates/candor-core/src/terminology_dictionary.rs`
- dictionary-related portions of `crates/candor-core/src/job_manager.rs`
- dictionary-related portions of `crates/candor-core/src/background_jobs.rs`
- dictionary maintenance in `crates/candor-core/src/main.rs`
- `electron/ipc/terminology-ipc.ts`
- `electron/preload.cts`
- `electron/security/validate-private-core-input.ts`
- `v3/renderer/src/features/terminology/`
- dictionary and public-key portions of `scripts/spec3-verify-ai-bundle.mjs`

Validate these invariants:

1. Persisted job descriptors contain only a random staging token, expected SHA-256, safe display name, and byte count. Legacy Base64 exists only for schema-v1 migration.
2. Staged archives are authenticated and encrypted with a separate Rust-owned key, atomically written, path-contained, regular-file only, size bounded, and reverified immediately before import.
3. Success, cancellation, and nonretryable failure delete staged data. Retryable data, Ask questions, terminal jobs, and orphans obey the bounded retention policy during long-running sessions and after restart.
4. Schema-v1 migration creates a backup, stages every acceptable archive before committing schema v2, verifies the new store, and restores the original byte-for-byte on any failure. Oversized archives must not drop unrelated jobs or source data.
5. Dictionary conflict order is meeting, project, organization, personal, specialist, general, followed by explicit preference, context relevance, category match, approved corrections, semantic version, and stable ID.
6. Project scope cannot be activated before a real project identifier exists.
7. Only the exact bundled Candor key ID and Ed25519 public-key bytes can produce `verified-candor`. Unknown, self-signed, legacy organization, and future unrecognized labels are visibly downgraded.
8. The publisher-key schema enforces a positive rotation generation. Private keys and model assets remain outside Git.
9. No dictionary archive bytes, keys, complete paths, prompts, transcripts, or persisted Ask questions appear in renderer-facing dictionary state or diagnostics. The normal user-initiated Ask request is expected to carry its bounded question from the renderer to the core, but the question must be scrubbed from persisted task state after acknowledgement or 24 hours.

Run focused tests if useful. Report findings first, ordered by severity: critical, high, medium, low. Include exact file and line references, impact, evidence, and a concrete fix. Explicitly say when no critical or high findings remain. Do not evaluate model quality, hardware capture, installer signing, or cloud distribution in this checkpoint.
