# Phase 6 Implementation Review Reconciliation

## Review strategy

The first combined Phase 6 review request exceeded the ten-minute Claude CLI guardrail and produced no artifact. It is not counted as a review.

The handoff was split into two focused reviews:

1. Irreversible Rust data operations.
2. Electron authority and renderer truthfulness.

Both focused reviews returned real artifacts. Each required fix was committed and sent through a narrow re-review.

## Core review

Artifacts:

```text
docs/implementation/v4/claude-phase6-core-review-request.md
docs/implementation/v4/claude-phase6-core-review.md
docs/implementation/v4/claude-phase6-core-rereview-request.md
docs/implementation/v4/claude-phase6-core-rereview.md
```

Initial verdict: `GO WITH REQUIRED FIXES`.

### Accepted

Claude found that manifest schema `0` returned `RECORDING_MANIFEST_SCHEMA_UNSUPPORTED` but could still fall through to a supported backup or chunk rebuild. That could overwrite unsupported metadata.

The suggested one-line guard in `load_or_rebuild_manifest` was necessary but incomplete. Repository inspection showed that `read_manifest` also needed to stop candidate fallback before reaching `.bak` or `.tmp`.

Commit `7ffe10c`:

- fails closed at both candidate-selection and rebuild-selection boundaries;
- quarantines schema `0` without reading a supported backup;
- preserves the primary manifest byte for byte through list and recovery;
- retains fallback and rebuild behavior for supported corrupt manifests.

Verification:

```text
Rust default: 82 passed
Rust sqlcipher-vault: 97 passed
Claude focused re-review: GO
```

### Rejected

Claude described a manifest backup rotation false-error window and suggested deleting the old backup only after the new primary rename. The proposed order cannot work on Windows because the current primary must first be renamed into an unoccupied backup name. More importantly, a failed rename does not delete its source: if restoration fails, the backup remains available and is read before the temporary candidate. No data-loss or false-success path was demonstrated.

Claude also suggested avoiding chunk decryption during scan recovery. Candor intentionally decrypts and authenticates managed chunks before rebuilding metadata. Replacing that with a size approximation would weaken corruption detection. This remains an optional performance investigation only after long-recording measurements.

## Shell review

Artifacts:

```text
docs/implementation/v4/claude-phase6-shell-review-request.md
docs/implementation/v4/claude-phase6-shell-review.md
docs/implementation/v4/claude-phase6-shell-rereview-request.md
docs/implementation/v4/claude-phase6-shell-rereview.md
```

Initial verdict: `GO WITH REQUIRED FIXES`.

### Accepted

Claude found that a shared `busy` flag disabled the Record control during every operation. During active capture the same control is Stop, so unrelated transcription, export, or notes work could temporarily make Stop unavailable.

Commit `dc72630`:

- keeps Stop available during unrelated work and blocking storage;
- disables duplicate Stop while Stop itself is running;
- continues to block new starts during unrelated busy work or unsafe storage;
- rejects capture-start responses that omit the durable recording ID instead of inventing `started` as an ID.

Verification:

```text
Vitest: 33 files, 101 tests passed
Renderer typecheck: passed
Claude focused re-review: GO
```

## Phase 6 disposition

Phase 6 is complete for implementation and automated local proof. Remaining hardware, cross-platform, signing, clean-machine, display-scaling, and long-duration evidence belongs to Phase 7 and must not be claimed early.
