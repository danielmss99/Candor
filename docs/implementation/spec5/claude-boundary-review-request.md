# Focused Claude review: SPEC-5 dictionary, Electron, UI, and release boundary

Review the uncommitted SPEC-5 diff in `C:\Claude_Config\candor`. Do not edit files and do not run the test suite. Limit the response to actionable correctness or security findings, plus a short no-findings statement for reviewed areas. Finish within this invocation.

Read only the changed portions of:

- `crates/candor-core/src/dictionary_package.rs`
- `crates/candor-core/src/terminology_dictionary.rs`
- `electron/ipc/terminology-ipc.ts`
- `electron/security/validate-dictionary-package-input.ts`
- `electron/preload.cts`
- `electron/window/capture-close-guard.ts`
- `v3/renderer/src/features/jobs/BackgroundActivity.tsx`
- `v3/renderer/src/features/terminology/TerminologySettings.tsx`
- `package.json`
- `third_party/model-lock.json`
- `scripts/spec3-verify-ai-bundle.mjs`

The `.candordict` archive allows exactly four root files, applies size and compression-ratio limits, rejects traversal/symlinks, validates schemas and minimum app version, verifies a digest and Ed25519 signature, and imports into encrypted local storage. A package-provided public key proves integrity only, so unknown packages are labelled `Community pack - unverified`. Drag-and-drop sends bounded bytes through a specific IPC method, not a renderer path. Strict Standard and Maximum package commands must fail until real production assets and evidence exist.

Review only these risks:

1. ZIP parser, duplicate-name, path, symlink, archive-bomb, signature, or canonicalization bypasses;
2. publisher identity being overstated or self-signed keys being trusted;
3. package update/idempotency bugs or dictionary content escaping logs/events;
4. pharmaceutical or numeric corrections applying without approval or losing original text;
5. preload input, close-choice, cancel-all, retry, notification, and stale-state defects;
6. renderer exposure of paths, raw meeting content, or generic execution;
7. a release command, manifest field, profile mapping, or candidate matrix that could publish incomplete Standard, include full Large in Standard, or falsely report readiness;
8. accessibility or compact-layout defects in the new activity panel.

For every finding provide severity, exact file and line range, evidence, failure scenario, and concrete fix. Distinguish defects from suggestions. Do not restate the architecture.
