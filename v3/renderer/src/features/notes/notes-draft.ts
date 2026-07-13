export interface NotesSnapshot {
  recordingId: string;
  markdown: string;
  revision: number;
}

export type NotesSaveDisposition = "current" | "newer-edits" | "different-recording";

export type NotesUpdate = string | ((current: string) => string);

export class NotesDraftTracker {
  private current: NotesSnapshot = { recordingId: "", markdown: "", revision: 0 };

  load(recordingId: string, markdown: string): NotesSnapshot {
    this.current = { recordingId, markdown, revision: this.current.revision + 1 };
    return this.snapshot();
  }

  edit(update: NotesUpdate): NotesSnapshot {
    const markdown = typeof update === "function" ? update(this.current.markdown) : update;
    this.current = { ...this.current, markdown, revision: this.current.revision + 1 };
    return this.snapshot();
  }

  snapshot(): NotesSnapshot {
    return { ...this.current };
  }

  isCurrent(snapshot: NotesSnapshot): boolean {
    return snapshot.recordingId === this.current.recordingId
      && snapshot.revision === this.current.revision
      && snapshot.markdown === this.current.markdown;
  }

  disposition(snapshot: NotesSnapshot): NotesSaveDisposition {
    if (snapshot.recordingId !== this.current.recordingId) return "different-recording";
    return this.isCurrent(snapshot) ? "current" : "newer-edits";
  }
}
