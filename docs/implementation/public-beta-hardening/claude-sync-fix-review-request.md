# Claude review request: packaged smoke synchronization fix

## Objective

Review the focused fix for PR #12 hosted failures on macOS and Linux. The packaged application rendered the intended quiet workspace, but `scripts/m0-packaged-smoke.mjs` still required removed session rail and session tab elements plus obsolete fallback copy.

## Observed hosted proof

Both failed hosted jobs recorded the same relevant state:

```json
{
  "bodyTextCharacters": 1036,
  "aiModeVisible": true,
  "selectedMode": "Local AI",
  "statusText": "Local AI, asks before fallback",
  "aiSuggestionsTabActivated": true,
  "notesTabRestored": true,
  "currentView": "meeting",
  "sessionRailVisible": false,
  "sessionTabsVisible": false,
  "recordActionVisible": true,
  "transcriptVisible": true,
  "notesVisible": true,
  "remoteImages": 0
}
```

The quiet workspace intentionally replaced `.session-rail` and `.session-tabs` with `.candor-desktop`, `.desktop-sidebar`, and `.desktop-nav[aria-label="Primary"]`.

## Changed files

- `electron/smoke/m0-smoke.ts`
  - Collect current desktop shell, sidebar, and primary navigation evidence.
- `scripts/m0-packaged-smoke.mjs`
  - Require the new evidence and the current ask-first fallback policy copy.
- `tests/visual/VisualEvidenceApp.tsx`
  - Align visual fixtures with the same fallback policy copy.

## Verification completed

- `npm run m0:ci-contract-smoke`: passed.
- `npm test`: 174 tests across 45 files passed.
- `npm run electron:v3:build`: passed.
- `npx electron-builder --config electron-builder.source-interface.yml`: passed.
- `npm run m0:packaged-smoke`: passed against rebuilt `release-v3/win-unpacked/Candor.exe`.
- `npm run test:electron`: 7 Electron and axe tests passed.
- `git diff --check`: passed.

## Review request

Review the working-tree diff only. Prioritize:

1. Whether the new assertions preserve a meaningful packaged UI contract rather than weakening it.
2. Whether any obsolete UI assumptions remain.
3. Whether exact fallback copy is an appropriate contract here.
4. Cross-platform selector reliability.
5. Missing focused tests or high-risk regressions.

Report findings by severity with file and line evidence. Distinguish defects from optional suggestions. Do not edit the repository.
