import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import {
  asBool,
  asObject,
  asString,
  exportFormatLabel,
  exportReportItem,
  recapItemKey,
  type ExportFormat,
  type ExportPaperSize,
  type JsonObject,
  type LocalAiRecap,
  type RecapItem,
} from "../../core/contracts";
import type { RunOperation } from "../jobs/useOperationRunner";
import type { NotesSaveDisposition, NotesSnapshot } from "../notes/notes-draft";

type CoreApi = NonNullable<Window["candor"]>["core"];

export interface ExportSections {
  summary: boolean;
  decisions: boolean;
  actions: boolean;
  risks: boolean;
  questions: boolean;
  notes: boolean;
  transcript: boolean;
  timestamps: boolean;
}

export type ReviewState = "accepted" | "rejected";
export type ReviewStates = Record<string, ReviewState>;
export type ReviewStatesAction =
  | { type: "review"; key: string; state: ReviewState }
  | { type: "recording-changed" };

export function reviewStatesReducer(state: ReviewStates, action: ReviewStatesAction): ReviewStates {
  if (action.type === "recording-changed") return {};
  return { ...state, [action.key]: action.state };
}

interface UseReportWorkflowOptions {
  api: CoreApi | undefined;
  selectedRecordingId: string;
  notesDirty: boolean;
  recap: LocalAiRecap | null;
  run: RunOperation;
  captureNotesSnapshot: () => NotesSnapshot;
  notesSnapshotDisposition: (snapshot: NotesSnapshot) => NotesSaveDisposition;
  commitNotesSave: (snapshot: NotesSnapshot, status: JsonObject) => NotesSaveDisposition;
  setNotice: (message: string) => void;
  refreshPrivacyReceipt: () => Promise<void>;
}

export function reviewedReportItems(items: RecapItem[], states: Record<string, ReviewState>): RecapItem[] {
  return items.filter((item) => states[recapItemKey(item)] !== "rejected");
}

export function useReportWorkflow(options: UseReportWorkflowOptions) {
  const {
    api,
    selectedRecordingId,
    notesDirty,
    recap,
    run,
    captureNotesSnapshot,
    notesSnapshotDisposition,
    commitNotesSave,
    setNotice,
    refreshPrivacyReceipt,
  } = options;
  const [reviewStates, dispatchReview] = useReducer(reviewStatesReducer, {});
  const [summaryDraft, setSummaryDraft] = useState("");
  const [format, setFormat] = useState<ExportFormat>("docx");
  const [paperSize, setPaperSize] = useState<ExportPaperSize>("letter");
  const [sections, setSections] = useState<ExportSections>({
    summary: true,
    decisions: true,
    actions: true,
    risks: true,
    questions: true,
    notes: true,
    transcript: false,
    timestamps: false,
  });
  const [markdownExport, setMarkdownExport] = useState("");

  useEffect(() => setSummaryDraft(recap?.summary ?? ""), [recap]);
  useEffect(() => dispatchReview({ type: "recording-changed" }), [selectedRecordingId]);

  const reviewedItems = useCallback((items: RecapItem[]) => reviewedReportItems(items, reviewStates), [reviewStates]);

  const preview = useMemo(() => ({
    decisions: sections.decisions ? reviewedItems(recap?.decisions ?? []) : [],
    actions: sections.actions ? reviewedItems(recap?.actions ?? []) : [],
    risks: sections.risks ? reviewedItems(recap?.risks ?? []) : [],
    questions: sections.questions ? reviewedItems(recap?.questions ?? []) : [],
  }), [recap, reviewedItems, sections.actions, sections.decisions, sections.questions, sections.risks]);

  const buildParams = useCallback((nextFormat: ExportFormat) => ({
    recordingId: selectedRecordingId,
    format: nextFormat,
    report: {
      summary: summaryDraft || recap?.summary || "",
      decisions: reviewedItems(recap?.decisions ?? []).map(exportReportItem),
      actions: reviewedItems(recap?.actions ?? []).map(exportReportItem),
      risks: reviewedItems(recap?.risks ?? []).map(exportReportItem),
      questions: reviewedItems(recap?.questions ?? []).map(exportReportItem),
    },
    options: {
      includeSummary: sections.summary,
      includeDecisions: sections.decisions,
      includeActions: sections.actions,
      includeRisks: sections.risks,
      includeQuestions: sections.questions,
      includeNotes: sections.notes,
      includeTranscript: sections.transcript,
      includeTimestamps: sections.timestamps,
      paperSize,
    },
  }), [paperSize, recap, reviewedItems, sections, selectedRecordingId, summaryDraft]);

  const saveLocalReport = useCallback(async () => {
    if (!api || !selectedRecordingId) return;
    const notesSnapshot = captureNotesSnapshot();
    await run("export", async () => {
      if (notesDirty) {
        commitNotesSave(
          notesSnapshot,
          asObject(await api.recordingNotesSave(selectedRecordingId, notesSnapshot.markdown)),
        );
      }
      const result = asObject(await api.exportSaveLocal(buildParams(format)));
      if (asBool(result.canceled)) {
        setNotice("Export canceled. No file was written.");
        return;
      }
      if (!asBool(result.saved) || !asBool(result.savedLocally)) {
        throw new Error("The local report was not saved.");
      }
      setMarkdownExport(format === "markdown" ? asString(result.markdown) : "");
      const fileName = asString(result.fileName, exportFormatLabel(format));
      const notesDisposition = notesSnapshotDisposition(notesSnapshot);
      setNotice(notesDisposition === "current"
        ? `Saved ${fileName} locally`
        : notesDisposition === "newer-edits"
          ? `Saved ${fileName} locally; newer note changes remain unsaved`
          : `Saved ${fileName} locally for the original meeting`);
      await refreshPrivacyReceipt();
    }, "document-write", "export");
  }, [api, buildParams, captureNotesSnapshot, commitNotesSave, format, notesDirty, notesSnapshotDisposition, refreshPrivacyReceipt, run, selectedRecordingId, setNotice]);

  const toggleSection = useCallback((key: keyof ExportSections) => {
    setSections((current) => ({ ...current, [key]: !current[key] }));
  }, []);

  const reviewItem = useCallback((key: string, state: ReviewState) => {
    dispatchReview({ type: "review", key, state });
  }, []);

  return {
    reviewStates,
    summaryDraft,
    format,
    paperSize,
    sections,
    markdownExport,
    preview,
    setSummaryDraft,
    setFormat,
    setPaperSize,
    toggleSection,
    reviewItem,
    save: saveLocalReport,
  };
}
