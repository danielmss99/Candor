# Claude implementation review request

## Review objective

Perform an adversarial, read-only implementation review of SPEC-2 on branch
`codex/post-consolidation-hardening` at
`918ee249f6b7a3180f04345d6e196c3d5780733f` against `origin/main` at
`1f9b87e19dc930faa5259e62ab9e4d6e7e23de1e`.

Do not modify files. Inspect the repository and the actual diff with:

```text
git diff origin/main...HEAD
git log --oneline origin/main..HEAD
```

Use these source artifacts as the acceptance contract:

- `docs/implementation/spec2/implementation-plan.md`
- `docs/implementation/spec2/claude-plan-review.md`
- `CANDOR_CODEX_POST_CONSOLIDATION_HANDOFF.md` is not in the repository, so the
  accepted plan above is authoritative for this review.

## Implemented scope

- Authoritative operation registry with parameter and result validation.
- Handshake-gated ordinary calls, process-scoped handshake reset, and protocol
  mismatch errors.
- Rust-owned asynchronous transcription, AI, import, and export jobs with
  progress, cancellation, rehydration, acknowledgement, and terminal results.
- Explicit `capture-connection-degraded` behavior with persisted recovery
  metadata, bounded retry, Stop availability, and no blind core kill.
- Deterministic controllable-core fault modes and capture hang coverage.
- Product-domain preload API v2 with an exact allowlisted surface and no generic
  invoke, filesystem, or process methods.
- Renderer migration to the domain API, simplified product copy, and grouped
  Advanced Settings.
- Product identity normalized to Candor `0.4.0`. The existing app ID remains
  unchanged until a real upgrade test proves a safe migration.
- Remote-main architecture verification, SPDX 2.3 SBOM generation and
  verification, release checksums, manual release evidence validation, and a
  20-state by 5-viewport GUI evidence matrix.

## Verification already run

- `npm run v3:verify`: passed.
- Rust tests: 86 passed.
- Vitest: 40 files and 133 tests passed.
- `npm run test:electron:build`: passed earlier in this branch with 5 Playwright
  Electron tests. It will run again after review reconciliation.
- `npx playwright test tests/e2e/visual-evidence.spec.ts -c playwright.electron.config.ts`:
  passed and generated 100 PNG screenshots.
- `npm run dist`: passed for Windows.
- `npm run m0:packaged-smoke`: passed against the rebuilt package.
- Release artifact smoke, icon proof, artifact manifest, checksums, SBOM,
  product identity, and working-tree/main architecture checks: passed.

Candidate under review:

```text
release-v3/Candor Setup 0.4.0.exe
bytes: 128885396
sha256: 98128038bed7ce58aacb638ca0053f831331103abb3d48cff6c9a24eb9b91a9c
```

## Known external blockers

Do not report these as newly discovered code defects unless the implementation
incorrectly claims they passed:

- This shell is not elevated, so the Windows network-deny receipt records
  `administrator-required`.
- macOS and Linux packaged/network proof is pending CI or target machines.
- Windows executable, sidecar, and installer are not Authenticode-signed.
- macOS and Linux signed artifacts do not exist yet.
- Clean-machine install and upgrade, real microphones, system audio, device
  switching, sleep/resume, lock/unlock, and 5/30/60/180-minute runs require
  physical evidence.
- Strict real local Whisper and llama.cpp model quality proofs remain external
  model/runtime gates.
- `releaseReady` and `missionComplete` are intentionally false.

## Required review format

Lead with findings ordered by severity. Each finding must include:

1. Severity: Critical, High, Medium, or Low.
2. Exact file and line, or the narrowest relevant symbol when line numbers move.
3. Concrete evidence from the implementation.
4. User or security impact.
5. A specific fix and the test that should prove it.

Prioritize:

- trust-boundary validation gaps;
- handshake or request lifecycle races;
- job persistence, cancellation, and event-ordering bugs;
- degraded capture states that could lose Stop or recovery behavior;
- preload surface expansion, sender validation, and renderer sandbox regressions;
- unsafe logs, paths, tokens, transcript or note leakage;
- existing-data or licensing lockout regressions;
- stale renderer responses and reload recovery;
- false release, privacy, identity, checksum, SBOM, or architecture claims;
- missing tests that could hide a concrete behavioral defect.

After findings, include:

- `Plan deviations`: required SPEC-2 behavior that is absent or materially
  different.
- `Uncertainties`: anything you could not prove from repository evidence.
- `Verdict`: one of `approve`, `approve with non-blocking follow-ups`, or
  `changes required`.

Do not praise the work, restate the diff, or list optional product ideas. If no
actionable defect is found, say so directly and identify only residual test or
external-evidence risk.
