# Claude Final Re-review Request

Review the current uncommitted `codex/whisper-llm-release` diff after the fixes made in response to `docs/implementation/spec4/claude-code-review.md`.

Inspect the code directly. Do not launch subagents. Return only remaining P0 or P1 defects with file and line evidence, followed by a concise PR-readiness verdict.

## Prior finding disposition

1. The claim that `jobs-ipc.ts` bypasses private parameter validation was rejected after tracing the complete call path. Every job channel calls `CoreClient.call()`, and `electron/core/core-client.ts` resolves the operation and executes `operation.paramsSchema.parse(params)` before handshake or process startup. A new test confirms malformed `ai.ask.start` input produces `CORE_PARAMS_SCHEMA_INVALID` with a zero spawn count.
2. Windows prompt-file access control was fixed. `write_prompt_file()` now creates the file with a protected Windows DACL that grants full access only to the creating owner and LocalSystem. The DACL is supplied to `CreateFileW`, so there is no post-create access window. A Windows test reads the resulting security descriptor and rejects broad user groups.
3. Multi-source claims now report all speakers, use `Multiple speakers` and `mixed` when appropriate, and keep the earliest cited timestamp.
4. Four-to-seven-token claims now require three overlapping meaningful tokens. Exact number, dosage, and specialist-term checks still run first so precise safety errors are retained.
5. Merged recap summary Markdown now cites only summary claim sources instead of all decision, action, risk, and question sources.
6. Raw path detection normalizes slash direction and case before comparing runner, model, and prompt paths.
7. The core now rejects local performance benchmark start while capture is active, even if an untrusted renderer bypasses its disabled UI control.

Focused tests and strict Clippy pass. Real model assets, license approval, hardware benchmarks, signing, and clean-machine evidence remain external Complete-release blockers and must not be replaced with placeholders.
