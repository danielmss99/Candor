# Claude final review request: Candor SPEC-6 AI Release Completion

Review the complete worktree on `codex/spec6-ai-release-completion` as an independent senior Electron, TypeScript, Rust, desktop-security, and release reviewer. The base commit is `9eaf4e220731127f7de601abf105bd0eab6342c1`.

Read these review and evidence artifacts first:

- `docs/implementation/spec6/implementation-plan.md`
- `docs/implementation/spec6/acceptance-status.md`
- `docs/implementation/spec6/verification.md`
- `docs/implementation/spec6/claude-plan-review.md`
- `docs/implementation/spec6/claude-ai-task-review.md`
- `docs/implementation/spec6/claude-dictionary-security-review.md`

Then inspect the full diff from the base commit and validate the repository evidence. Prioritize:

1. local-LLM defaults, fallback policy, strict retry, and provenance;
2. exact and privacy-safe background-task validation before renderer state;
3. encrypted dictionary staging, transactional migration, retention, and cleanup;
4. deterministic dictionary scope resolution and Candor publisher trust anchoring;
5. fail-closed AI asset acquisition, profile verification, and publication limits;
6. renderer sandbox, preload V3 surface, accessibility, and fallback disclosure;
7. tests, proof honesty, and deviations from the accepted SPEC-6 plan.

Treat absent production model weights, signing keys, publisher keys, hardware receipts, long-duration evidence, and clean-machine evidence as external blockers. Do not recommend fabricating or weakening those gates.

Report findings first, ordered by critical, high, medium, and low. Every finding must include exact file and line references, impact, evidence, and a concrete fix. Distinguish observed defects from optional improvements. Explicitly state whether any critical or high findings remain and whether code-level acceptance is suitable for a pull request while public release readiness remains false.
