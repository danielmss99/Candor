# V3 Goal Audit

Status: **implemented mission-level audit; full goal is not complete**

## Purpose

Candor v3 has many milestone and release proof files. This audit ties those
proofs back to the original mission:

- Electron plus React/TypeScript shell
- Rust `candor-core` local core over stdio JSON-RPC
- local-only custody with no cloud AI, no account requirement, and no meeting bot
- encrypted SQLCipher vault with OS key storage
- durable recording and consented real mic plus system capture
- M2 walking skeleton with local Whisper transcription
- M3 product surface
- M4 local AI path
- M5 importer and signed release readiness
- subagent alignment to this same mission

The audit is intentionally conservative. Local Windows proof does not satisfy a
cross-OS requirement. A readiness check does not satisfy consented real capture.
The heuristic AI fallback, local instruct preflight, and fixture invocation proof
do not satisfy the real-model quality gate. Only a
`m4-real-local-instruct-proof-<platform>-<arch>.json` artifact with
`strictRealModelSatisfied: true` counts as that evidence.

The current Windows x64 artifact satisfies that M4 requirement with a real
llama.cpp runtime and hash-pinned Qwen2.5 1.5B GGUF model. Cross-platform M0,
real capture, and signed release evidence remain separate mission gates.

## Commands

Record the current mission status without failing the caller:

```powershell
npm run v3:goal-audit
```

Fail unless every required mission item is proven:

```powershell
npm run v3:goal-audit:strict
```

The audit writes:

```text
release-v3/proofs/v3-goal-audit-<platform>-<arch>.json
```

## Subagent Alignment

Before any subagent is used on Candor v3 work, give it the active objective,
the latest `v3-goal-audit-<platform>-<arch>.json`, and the specific subgoal it
owns. A subagent is aligned only if its proposed edit moves one of the
incomplete required items toward `passed` without weakening local custody,
consent, durability, or proof requirements.

## Boundary

This audit does not run builds, record audio, sign artifacts, notarize macOS
packages, launch an elevated firewall proof, or create Linux/macOS proof
artifacts. It reads existing proof JSON files and writes a mission-level status
summary.

The optional real-model proof is intentionally not part of routine
`npm run v3:verify`. It requires user-installed local assets and is run with
`npm run m4:real-local-instruct-proof`.
