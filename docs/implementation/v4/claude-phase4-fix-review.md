Now I have everything I need. Let me work through each claim systematically.

---

## Claim 1: Notes typed mid-save remain dirty and cannot trigger a false-clean indicator

**Mechanism in the fix:**

`NotesDraftTracker` (`notes-draft.ts:1-39`) maintains a `revision` counter. Every `edit()` call (line 19-23) increments revision. `captureNotesSnapshot()` (`useMeetingWorkspace.ts:161`) is called *before* entering `run`, so any user edit that arrives during the async API call increments revision past the saved snapshot.

`commitNotesSave` (`useMeetingWorkspace.ts:164-170`) calls `notesDraft.current.disposition(snapshot)` — returns `"newer-edits"` when same recording but revision doesn't match — and only calls `setNotesDirty(false)` on `"current"`. Same guard applies in `saveLocalReport` (`useReportWorkflow.ts:126-132`).

**Test coverage:** `notes-draft.test.ts:5-13` directly exercises this path — `isCurrent(saving)` is `false` after an `edit()` call.

**Claim 1: CONFIRMED.**

---

## Claim 2: Save completion for Meeting A cannot affect Meeting B state

**Mechanism:**

`loadSelectedRecording` at `useMeetingWorkspace.ts:102` calls `notesDraft.current.load(recordingId, nextMarkdown)` after the `isCurrent(token)` guard (line 96), which changes `this.current.recordingId` to meeting B. Any in-flight save for meeting A that calls `commitNotesSave(snapshotA, status)` hits `notesDraft.current.disposition(snapshotA)` at line 165, where `snapshotA.recordingId ("meeting-a") !== this.current.recordingId ("meeting-b")` — returns `"different-recording"` and the early return at line 166 fires before either `setNotesStatus(status)` or `setNotesDirty(false)`.

Stale load race is also blocked: the `!requests.current.isCurrent(token)` guard at line 96 prevents `notesDraft.current.load` from firing for a superseded load, so the tracker never sees a stale recording ID.

**Claim 2: CONFIRMED.**

---

## Claim 3: Review accept/reject state resets when `selectedRecordingId` changes

**Mechanism:**

`reviewStates` was migrated from `useState` to `useReducer(reviewStatesReducer, {})` (`useReportWorkflow.ts:72`). The reducer at lines 37-40 returns `{}` unconditionally on `"recording-changed"`. The effect at line 89 fires on every `selectedRecordingId` change:

```ts
useEffect(() => dispatchReview({ type: "recording-changed" }), [selectedRecordingId]);
```

**Test coverage:** `useReportWorkflow.test.ts:21-25` directly tests that the reducer clears state on `"recording-changed"`.

**Claim 3: CONFIRMED.**

---

## Claim 4: Onboarding license effect no longer depends on state it mutates

**Before the fix** (from prior review): `step` appeared in both the dep array and the body via `else if (step === "activate")`.

**After the fix** (`useOnboardingSettings.ts:74-85`):

```ts
} else {
  setStep((current) => current === "activate" ? "app" : current);
}
}, [licenseAvailable, licenseLoaded, licensePromptDismissed, licenseStatus, recordingCount]);
```

`step` is removed from the dep array. The `else if (step === "activate")` reads-via-closure was replaced by a functional-updater form that reads `current` inside the setter, which does not constitute a captured dependency. ESLint `react-hooks/exhaustive-deps` is now clean. The functional update fires only when `licenseStatus` transitions (which is in the dep array), not on every `step` change.

Behavioral equivalence: the prior code's `setStep("app")` only ran when `step === "activate"`. The replacement `setStep((current) => current === "activate" ? "app" : current)` produces identical state transitions while being idempotent (returns same value when already past "activate").

**Claim 4: CONFIRMED.**

---

## Residual defect scan

**`commitNotesSave` has no deps but closes over `setNotesStatus` and `setNotesDirty`** — these are stable React state setters, so this is safe.

**`captureNotesSnapshot` and `commitNotesSave` both have `[]` deps** — both operate only on the stable `notesDraft` ref, so no staleness risk.

**`clearSelectedRecording` calls `setNotesDirty(false)` unconditionally** (`useMeetingWorkspace.ts:78`) — correct, because it also calls `notesDraft.current.load("", "")` which changes the tracker's `recordingId` to `""`, so any in-flight save for the previous recording will see `disposition === "different-recording"` and not override.

**No edge case with `notesDirty` in `saveLocalReport` closure** — `notesDirty` is in the `useCallback` deps (line 151), so `saveLocalReport` is always current when called. The `notesSnapshot` is captured immediately before `run`, and `commitNotesSave` uses the tracker, not the closure, to decide disposition.

No Critical, High, or required Medium defects remain or were introduced.

---

`GO`
