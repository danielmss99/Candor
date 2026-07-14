# Claude Code Review Request

Perform the final focused review of the complete uncommitted SPEC-4 diff on branch `codex/whisper-llm-release` against:

- `docs/implementation/spec4/implementation-plan.md`
- `docs/implementation/spec4/implementation-status.md`
- `docs/implementation/spec4/verification.md`
- the handoff summarized in `docs/implementation/spec4/claude-plan-request.md`

Focus on actionable defects, ordered by severity. Inspect the code directly rather than reviewing only these notes.

## Required review areas

1. Trust boundaries: renderer input, native picker, path handling, dictionary encryption, prompt transport, fixed runtime/model paths, bounded output, logs, and release manifest validation.
2. Grounding: strict JSON parsing, unknown source IDs, numeric/dosage/drug/owner/date mutations, glossary misuse, unsupported answers, batching, merge logic, and late-transcript evidence.
3. Cancellation: JobManager token propagation, Whisper abort callback, llama.cpp process termination, prompt cleanup, scheduler release, and terminal job state.
4. Quality policy: fail-closed persistence, benchmark requirements, RAM guards, Fast/Balanced/Maximum mappings, first-run recommendation versus explicit user choice, rounded minutes-per-hour estimates, fallback behavior, corrupt settings, and absence of fabricated or raw estimates.
5. Terminology: import bounds, Unicode and control handling, pharmaceutical safeguards, correction history, original transcript preservation, and repeated rejection behavior.
6. Electron and renderer contracts: exact preload surface, method-specific validation, private-only legacy direct jobs, canonical async job starts, discriminated job-event validation, stale response behavior, compact layouts, keyboard access, and user-facing technical leakage.
7. Packaging: source-interface versus Complete profiles, immutable provenance, exact digests, missing-asset failure behavior, and whether any command could accidentally publish an AI-incomplete artifact as Complete.

## Known external blockers

Do not recommend filling these with placeholders: real model binaries and weights, reproducible Qwen conversion digest, license approval, 8/16/32 GB benchmark evidence, signing credentials, clean-machine tests, and hardware capture tests.

Return:

- findings with severity and file/line references;
- missing or weak tests;
- any claim that exceeds evidence;
- a concise recommendation on whether the source diff is ready for a pull request while the Complete release remains blocked.

Do not launch subagents. Keep this final pass focused on remaining P0 and P1 defects and produce a single synthesized response within the available session.
