# Claude Code Review, Interrupted Pass

The authenticated Claude Code review started on 2026-07-13 and inspected the uncommitted SPEC-4 repository directly. Claude launched independent review passes for correctness, trust boundaries, cross-file contracts, performance, and duplication.

The top-level reviewer hit the Claude account session limit after 20 turns and returned HTTP 429 before producing its final synthesis. This artifact does not represent a completed top-level Claude approval. Five subreviews did return candidate findings before the limit was reached.

## Material candidates returned

- Concurrent terminology and quality-policy reads could overlap atomic rename-based writes.
- Rapid meeting changes could let an older terminology request overwrite newer renderer state.
- Job state mutation silently ignored a poisoned mutex.
- Imported terminology was placed into Whisper and LLM context without explicit model-control-token rejection or an untrusted-data fence.
- Local instruct configuration and bundle inspection repeated for every transcript batch.
- Serde parameter errors and `core.ping` could reflect caller-controlled values into protocol responses.
- The encrypted terminology reader preallocated the full metadata-declared size before authentication.
- Lowercase normalization was repeated inside the terminology scoring loop.

## Candidates requiring boundary verification

- Private model import accepts a native-picker-selected source path by design and is not renderer callable.
- Strict local-AI metadata intentionally rejects omitted custody and grounding fields.
- Durable audio and text chunk methods are core proof operations, not missing private Electron operation definitions.
- Bundle timestamp cache entries are keyed by canonical asset path as well as size and modification time.
- Several cleanup and caching ideas were maintainability suggestions rather than correctness defects.

The accepted and rejected findings are reconciled in `claude-code-reconciliation.md`.
