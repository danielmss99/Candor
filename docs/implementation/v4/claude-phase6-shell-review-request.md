# Claude Phase 6 Focused Shell Review

Review Candor's Electron and renderer boundary for Phase 6. Do not edit files. Keep the response under 1,500 words.

Repository: `C:\Claude_Config\candor-v3-m0`
Branch: `codex/electron-consolidation`
Commits: `f5f8ed8`, `def10f5`, `7ffe10c`

Inspect these actual files and relevant tests:

```text
electron/ipc/recordings-ipc.ts
electron/ipc/register-ipc.ts
electron/core/protocol-methods.ts
electron/preload.cts
electron/preload-api.ts
v3/renderer/src/core/contracts.ts
v3/renderer/src/features/meetings/useMeetingActions.ts
v3/renderer/src/features/startup/useRuntimeStatus.ts
v3/renderer/src/features/capture/useCaptureActions.ts
v3/renderer/src/features/recovery/system-alerts.ts
v3/renderer/src/app/AppRouteOutlet.tsx
v3/renderer/src/components/DesktopShell.tsx
v3/renderer/src/features/detail/MeetingDetailView.tsx
```

Product invariants:

1. The renderer cannot invoke the private Rust deletion method directly or gain generic IPC, filesystem, process, or path authority.
2. Permanent deletion requires a native confirmation whose safe default is Cancel.
3. Existing meetings stay openable, exportable, and deletable without an active license.
4. Low or unavailable storage blocks only new recording starts. An active capture can still stop.
5. Durable-write failure, quarantine, incomplete deletion, and recovery facts remain persistently visible and are based on core measurements.
6. A stopped recording is not called saved until the core returns a durable recording ID.
7. Runtime validators reject malformed critical responses instead of coercing them into reassuring defaults.

Adversarial questions:

- Is there any renderer-accessible path to `recording.durable.delete` or arbitrary core methods?
- Can confirmation be bypassed through another exposed operation?
- Can license service failure block existing meeting access or deletion?
- Can polling, stale state, operation errors, or the `busy` prop disable Stop during active capture?
- Can a capture start fail for disk pressure but leave only a dismissible notification?
- Can a refresh failure mark a successfully saved recording as capture failure, or mark a failed save as successful?
- Do persistent alerts overlap content, expose paths, or claim recovery/safety without measured facts?

Verification already passed: 99 Vitest tests, renderer typecheck, product-surface smoke, Electron package, and Windows packaged runtime smoke. Physical disk exhaustion remains unverified.

Required format:

1. Verdict: `GO`, `GO WITH REQUIRED FIXES`, or `NO-GO`.
2. Findings ordered by severity with file, line, evidence, user impact, and concrete fix.
3. Separate observed defects from optional improvements.
4. Explicitly assess renderer authority, delete confirmation, license independence, stop availability, persistent failure visibility, and false-saved risk.
5. End with the smallest required fix set and exact re-review files.

Do not recommend cloud services, Tauri, generic bridges, or unrelated UI redesign.
