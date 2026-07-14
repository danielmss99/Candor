# Claude Implementation Review Request: SPEC-3 Bundled Local AI

Review the uncommitted changes on `codex/bundled-local-ai` in
`C:\Claude_Config\candor` against:

- `docs/implementation/spec3/implementation-plan.md`
- `docs/implementation/spec3/verification.md`
- `docs/implementation/spec3/acceptance-status.md`
- the original requirements summarized in the accepted plan

The parent commit is `adfe573b15e89add9345b53da463d5902487335a`.
Inspect the actual working-tree diff and source files. Do not edit files.

## Implemented boundary

- Separate read-only bundled manifest and strict release verifier.
- Trusted Electron `CANDOR_AI_BUNDLE_ROOT` injection.
- Rust first-use verification, containment checks, and package fallback.
- Compiled trust anchor for the selected speech model.
- Fixed-path llama.cpp-compatible process execution with no shell or HTTP.
- Pathless readiness RPC and exact preload method.
- Source, package, corruption, protocol, UI, SBOM, and release gates.
- Normal UI checking/ready/repair states with manual overrides in Advanced.
- No startup or background asset download.
- Existing meetings remain accessible when AI assets are absent or corrupt.

The ZIP contained no runtime or model binaries. The checked-in manifest is a
valid non-ready source interface with no selected defaults. Strict release
verification must fail until licensed and benchmarked assets are staged.

## Verification already run

- Rust: 97 tests pass; strict Clippy passes.
- Frontend: 40 files and 137 tests pass.
- Full `npm run v3:verify` passes M0 through M5.
- Electron build, unpacked package, packaged AI smoke, release artifact smoke,
  source security proof, and Windows M0 packaged smoke pass.
- Playwright: 5 tests pass, including exact preload and accessibility checks.
- GUI matrix: 110 screenshots across 22 states and 5 viewports.
- Strict AI release verification fails intentionally because no real assets are
  selected.

## Review priorities

1. Trust-boundary bypasses: renderer-controlled paths or arguments, environment
   spoofing, manifest self-signing, path traversal, symlink escape, TOCTOU, or
   writable packaged roots.
2. Incorrect fallback or readiness behavior that could run unverified assets or
   make a false local-AI claim.
3. Data-access regressions when the bundle is missing, corrupt, incompatible, or
   the core restarts.
4. Release-verifier gaps involving platform selectors, checksums, notices,
   provenance, licenses, fixtures, SBOM entries, or strict/non-strict modes.
5. Protocol/preload regressions, malformed-response handling, logging exposure,
   or unintended network behavior.
6. Missing tests or documentation contradictions that materially affect SPEC-3.

## Required response format

List findings first, ordered by severity. Each observed defect must include:

- severity: Critical, High, Medium, or Low;
- exact file and line;
- evidence and impact;
- concrete fix;
- whether an existing test should have caught it.

Separate observed defects from optional improvements. If there are no observed
defects, say so directly and name residual risks or unverified assumptions.
Do not treat unsigned artifacts, absent real models, incomplete benchmarks,
cross-OS physical testing, or the intentional strict-verifier failure as source
defects unless the implementation incorrectly masks them.
