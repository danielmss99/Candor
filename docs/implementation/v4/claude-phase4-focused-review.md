---

## Focused Renderer Safety Review — Findings

---

### FINDING 1 — HIGH: False-clean dirty indicator on concurrent note edits

**Files**: `useMeetingActions.ts:128–130` and `useReportWorkflow.ts:116–117`

**Evidence**: In `saveMeetingNotes`, `notesMarkdown` is captured in the `useCallback` closure when the callback is created. The `ExclusiveActionRegistry` (scope `"document-write"`) blocks a *second* save while one is in flight — it does **not** block the user from typing. If the user edits notes mid-save (`updateNotes` → `setNotesDirty(true)`), then the in-flight save completes and calls `setNotesDirty(false)` unconditionally. The notice `"Meeting notes saved locally"` fires simultaneously. The UI now shows notes as saved when post-save edits are unwritten to disk. The identical pattern exists in `useReportWorkflow.ts:116–117` (export-time notes flush).

```ts
// useMeetingActions.ts:125–133
const saveMeetingNotes = useCallback(async () => {
  if (!api || !selectedRecordingId) return;
  await run("notes", async () => {
    setNotesStatus(asObject(await api.recordingNotesSave(selectedRecordingId, notesMarkdown)));
    setNotesDirty(false);          // ← unconditional; fires even if user typed more
    setNotice("Meeting notes saved locally");
    ...
  }, "document-write", "notes-save");
}, [api, notesMarkdown, ...]);
```

**Impact**: User sees "saved locally" and `notesDirty = false`. Closing the app loses the post-save edits silently.

**Smallest safe fix**: Snapshot `notesMarkdown` before entering `run`, then clear dirty only if no new edits arrived. The cleanest approach is a `notesMarkdownRef` exposed from `useMeetingWorkspace` (already has the `useRef(requests)` pattern):

```ts
// useMeetingWorkspace.ts — add:
const notesMarkdownRef = useRef(notesMarkdown);
notesMarkdownRef.current = notesMarkdown;
// expose as notesMarkdownRef in return

// useMeetingActions.ts — replace the unconditional clear:
const snapshot = notesMarkdown;
await run("notes", async () => {
  setNotesStatus(asObject(await api.recordingNotesSave(selectedRecordingId, snapshot)));
  if (notesMarkdownRef.current === snapshot) setNotesDirty(false);
  setNotice("Meeting notes saved locally");
  ...
}, "document-write", "notes-save");
```

Same fix pattern required in `useReportWorkflow.ts:116–117`.

**Proof command**:
```
npx vitest run --reporter=verbose src/features/meetings/useMeetingActions.test.ts
```
The file contains exactly one test (`nextOpenMeetingIds`) — a pure-function test. The async save race has zero coverage.

---

### FINDING 2 — MEDIUM (clearly required): `reviewStates` not reset across recording changes

**File**: `useReportWorkflow.ts:62`

**Evidence**: `reviewStates` is initialized once with `useState<Record<string, ReviewState>>({})` and is never cleared when `selectedRecordingId` changes. `recapItemKey` at `contracts.ts:523–525` generates keys as `"${category}-${segmentIndex}-${text}"`. For recurring meetings where the same action item text recurs at the same segment index (e.g., weekly standup: "Update the team on progress" always at segment index 2), review states from Recording A will be present when Recording B is loaded.

```ts
// useReportWorkflow.ts:62 — never reset:
const [reviewStates, setReviewStates] = useState<Record<string, ReviewState>>({});

// contracts.ts:523
export function recapItemKey(item: RecapItem): string {
  return `${item.category}-${item.segmentIndex}-${item.text}`;
}
```

Note: `summaryDraft` IS reset via `useEffect(() => setSummaryDraft(recap?.summary ?? ""), [recap])` at line 78 — the symmetrical reset for `reviewStates` is absent.

**Impact**: Items in Recording B silently pre-appear as accepted or rejected based on a prior session's review, without the user taking any action.

**Smallest safe fix**:
```ts
// useReportWorkflow.ts — add after existing useEffect:
useEffect(() => {
  setReviewStates({});
}, [selectedRecordingId]);
```

**Proof command**:
```
npx vitest run --reporter=verbose src/features/export/useReportWorkflow.test.ts
```
The single test exercises `reviewedReportItems` in isolation. No test covers `reviewStates` persistence across `selectedRecordingId` changes.

---

### FINDING 3 — MEDIUM (fragility): `step` is a self-modifying dep in `useOnboardingSettings`

**File**: `useOnboardingSettings.ts:74–85`

**Evidence**: `step` appears in the effect dependency array while `setStep` is called inside the same effect. Current branches do not loop — React bails when `setStep` is called with the same value already in state — but the pattern is liveness-sensitive:

```ts
useEffect(() => {
  ...
  if (asString(licenseStatus.state, "inactive") === "inactive") {
    setStep(inactiveLicenseStep(recordingCount, licensePromptDismissed)); // may call setStep("activate")
  } else if (step === "activate") {   // reads step; step is also in dep array
    setStep("app");
  }
}, [licenseAvailable, licenseLoaded, licensePromptDismissed, licenseStatus, recordingCount, step]); // ← step here
```

ESLint `react-hooks/exhaustive-deps` flags this; any future contributor adding a new `setStep("newValue")` branch without a guard creates a production infinite loop with no lint signal.

**Impact**: No current runtime bug. Structural fragility that becomes a hard loop if the effect gains a new transition branch.

**Smallest safe fix**: Remove `step` from the dependency array. The `else if (step === "activate")` reads a stale-but-correct value because it only needs to fire when `licenseStatus` transitions to active (not when `step` changes independently):

```ts
// eslint-disable-next-line react-hooks/exhaustive-deps
}, [licenseAvailable, licenseLoaded, licensePromptDismissed, licenseStatus, recordingCount]);
```

**Proof command**:
```
npx eslint src/features/onboarding/useOnboardingSettings.ts --rule '{"react-hooks/exhaustive-deps":"warn"}'
```

---

## All 8 categories — clean items

| Category | Verdict |
|---|---|
| 1. Stale responses after unmount | Clean. `RequestCoordinator` token guards all async paths; cleanup `useEffect` at `useMeetingWorkspace.ts:151–155` invalidates all scopes on unmount. |
| 2. Duplicate capture / false durable-save | Clean. `ExclusiveActionRegistry` scope `"capture"` blocks concurrent starts. `captureSession.saved()` is only reached after `api.captureStop()` returns a non-empty `recordingId`; empty ID throws before that call, routing to `captureSession.failed()`. |
| 3. Strict Mode / hook-dep loops | `useWorkspaceStartup` — `started.current` ref survives the StrictMode mount/unmount/remount cycle; refresh identity change after startup is correctly gated. Only `step` dep (Finding 3) is structural fragility. |
| 4. Startup failures as optional diagnostics | Clean. `loadCritical()` throws on failure and gates the startup phase. `loadDiagnostics()` is correctly `void`-ed as a fire-and-forget background task. |
| 5. License blocking existing local data | Clean. `shouldShowActivationPrompt` requires `existingRecordingCount === 0`; users with recordings always pass through. `canAccessExistingData` unconditionally returns `true`. |
| 6. Review/Export without selected recording | Clean. `workspaceViewToRoute` at `navigation.ts:64` redirects to `{ name: "meetings" }` when `recordingId` is empty, making the review and export views structurally unreachable without a recording selection. |
| 7. Rejected data in export | Clean. `reviewedReportItems` filters `"rejected"` states from every category before both `preview` and `buildParams`. No rejected item reaches `api.exportSaveLocal`. |
| 8. Complexity into new monolith | Clean. `CandorWorkspace` (181 lines) and `AppRouteOutlet` (177 lines) are genuine decompositions with independently testable hooks. |

---

## Verdict

**GO WITH REQUIRED FIXES**

Finding 1 (HIGH) must be resolved before ship: the unconditional `setNotesDirty(false)` in both `saveMeetingNotes` and the export-time notes flush creates a window where the user is falsely assured their notes are saved. Finding 2 (MEDIUM) must also be resolved: `reviewStates` not resetting on recording change contaminates review sessions for recurring meetings with colliding `recapItemKey` values. Finding 3 (MEDIUM) should be resolved to eliminate the self-modifying dep fragility, but is not a current runtime defect.
