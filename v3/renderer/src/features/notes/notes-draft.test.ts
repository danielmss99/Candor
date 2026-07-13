import { describe, expect, it } from "vitest";
import { NotesDraftTracker } from "./notes-draft";

describe("notes draft revisions", () => {
  it("keeps edits made during an in-flight save dirty", () => {
    const notes = new NotesDraftTracker();
    notes.load("meeting-a", "Original note");
    const saving = notes.snapshot();
    notes.edit((current) => `${current}\nTyped while saving`);

    expect(notes.isCurrent(saving)).toBe(false);
    expect(notes.snapshot().markdown).toContain("Typed while saving");
  });

  it("recognizes a save snapshot when no newer edit exists", () => {
    const notes = new NotesDraftTracker();
    notes.load("meeting-a", "Stable note");
    expect(notes.isCurrent(notes.snapshot())).toBe(true);
  });

  it("does not apply a completed save to a newly selected meeting", () => {
    const notes = new NotesDraftTracker();
    notes.load("meeting-a", "First meeting");
    const saving = notes.snapshot();
    notes.load("meeting-b", "Second meeting");
    expect(notes.disposition(saving)).toBe("different-recording");
  });
});
