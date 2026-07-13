import { useCallback, useEffect, useState } from "react";
import {
  asBool,
  asNumber,
  asObject,
  asString,
  formatDuration,
  type AppView,
  type CompactMeetingPane,
  type JsonObject,
  type LibraryFilter,
  type MarkedMoment,
  type RecordingSummary,
} from "../../core/contracts";
import type { RunOperation } from "../jobs/useOperationRunner";
import type { NotesSaveDisposition, NotesSnapshot, NotesUpdate } from "../notes/notes-draft";
import { waitForJob } from "../../core/jobs";

type CoreApi = NonNullable<Window["candor"]>;

interface UseMeetingActionsOptions {
  api: CoreApi | undefined;
  run: RunOperation;
  recordings: RecordingSummary[];
  selectedRecordingId: string;
  selectedTrack: string;
  searchQuery: string;
  transcriptHasMore: boolean;
  setSelectedRecordingId: (recordingId: string) => void;
  setNotesMarkdown: (update: NotesUpdate) => void;
  setMarkedMoments: (update: MarkedMoment[] | ((current: MarkedMoment[]) => MarkedMoment[])) => void;
  refreshLibrary: (offset?: number) => Promise<RecordingSummary[]>;
  refreshPrivacyReceipt: (recordingId?: string) => Promise<void>;
  loadRecording: (recordingId: string) => Promise<void>;
  loadMoreTranscriptPage: () => Promise<void>;
  searchLibrary: () => Promise<void>;
  captureNotesSnapshot: () => NotesSnapshot;
  commitNotesSave: (snapshot: NotesSnapshot, status: JsonObject) => NotesSaveDisposition;
  resetMeetingAi: () => void;
  setView: (view: AppView, recordingId?: string) => void;
  setNotice: (message: string) => void;
  setError: (message: string) => void;
}

export function nextOpenMeetingIds(current: string[], recordingId: string): string[] {
  return [recordingId, ...current.filter((id) => id !== recordingId)].slice(0, 3);
}

export function useMeetingActions(options: UseMeetingActionsOptions) {
  const {
    api,
    run,
    recordings,
    selectedRecordingId,
    selectedTrack,
    searchQuery,
    transcriptHasMore,
    setSelectedRecordingId,
    setNotesMarkdown,
    setMarkedMoments,
    refreshLibrary,
    refreshPrivacyReceipt,
    loadRecording,
    loadMoreTranscriptPage,
    searchLibrary,
    captureNotesSnapshot,
    commitNotesSave,
    resetMeetingAi,
    setView,
    setNotice,
    setError,
  } = options;
  const [libraryFilter, setLibraryFilter] = useState<LibraryFilter>("all");
  const [notesPanelMode, setNotesPanelMode] = useState<"notes" | "suggestions">("notes");
  const [compactMeetingPane, setCompactMeetingPane] = useState<CompactMeetingPane>("transcript");
  const [openMeetingIds, setOpenMeetingIds] = useState<string[]>([]);
  const [audioUrl, setAudioUrl] = useState("");

  useEffect(() => {
    setOpenMeetingIds((current) => {
      const valid = current.filter((id) => recordings.some((recording) => recording.recordingId === id));
      const next = [...valid];
      for (const recording of recordings) {
        if (next.length >= 3) break;
        if (!next.includes(recording.recordingId)) next.push(recording.recordingId);
      }
      return next.slice(0, 3);
    });
  }, [recordings]);

  useEffect(() => () => {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
  }, [audioUrl]);

  const importV2Folder = useCallback(async () => {
    if (!api) return;
    await run("import", async () => {
      const accepted = asObject(await api.meetings.importLegacy());
      if (asBool(accepted.canceled)) {
        setNotice("Import canceled");
        return;
      }
      const result = asObject(await waitForJob(api, accepted));
      setNotice(`Imported ${asNumber(result.importedCount)} v2 meetings, ${asNumber(result.audioImportedCount)} with audio`);
      await refreshLibrary(0);
      setView("library");
    }, "v2-import");
  }, [api, refreshLibrary, run, setNotice, setView]);

  const searchRecordings = useCallback(async () => {
    if (!searchQuery.trim()) return;
    await run("search", searchLibrary);
  }, [run, searchLibrary, searchQuery]);

  const loadMoreRecordings = useCallback(async () => {
    await run("load meetings", async () => {
      await refreshLibrary(recordings.length);
    }, "library-page");
  }, [recordings.length, refreshLibrary, run]);

  const loadMoreTranscript = useCallback(async () => {
    if (!selectedRecordingId || !transcriptHasMore) return;
    await run("load transcript", loadMoreTranscriptPage, "transcript-page");
  }, [loadMoreTranscriptPage, run, selectedRecordingId, transcriptHasMore]);

  const saveMeetingNotes = useCallback(async () => {
    if (!api || !selectedRecordingId) return;
    const snapshot = captureNotesSnapshot();
    await run("notes", async () => {
      const status = asObject(await api.meetings.updateNotes(selectedRecordingId, snapshot.markdown));
      const disposition = commitNotesSave(snapshot, status);
      setNotice(disposition === "current"
        ? "Meeting notes saved locally"
        : disposition === "newer-edits"
          ? "Earlier edits saved; newer note changes remain unsaved"
          : "Notes saved for the original meeting; current meeting notes were unchanged");
      await Promise.all([refreshLibrary(0), refreshPrivacyReceipt()]);
    }, "document-write", "notes-save");
  }, [api, captureNotesSnapshot, commitNotesSave, refreshLibrary, refreshPrivacyReceipt, run, selectedRecordingId, setNotice]);

  const markMoment = useCallback((timeMs: number) => {
    if (!selectedRecordingId) {
      setError("Select or start a local meeting before marking a moment.");
      return;
    }
    const roundedMs = Math.max(0, Math.floor(timeMs / 1000) * 1000);
    setMarkedMoments((current) => [...current, {
      id: `note-${roundedMs}-${Date.now()}`,
      timeMs: roundedMs,
      label: "Moment marked",
    }]);
    setNotesMarkdown((current) => {
      const prefix = current.trimEnd();
      const line = `- [${formatDuration(roundedMs)}] Moment marked`;
      return prefix ? `${prefix}\n${line}` : line;
    });
    setError("");
    setNotice(`Moment linked to notes at ${formatDuration(roundedMs)}`);
  }, [selectedRecordingId, setError, setMarkedMoments, setNotesMarkdown, setNotice]);

  const loadAudio = useCallback(async () => {
    if (!api || !selectedRecordingId) return;
    await run("audio", async () => {
      const accepted = await api.exports.create({
        recordingId: selectedRecordingId,
        format: "wav",
        ...(selectedTrack ? { channel: selectedTrack } : {}),
      });
      const result = asObject(await waitForJob(api, accepted));
      const data = asString(result.dataBase64);
      if (!data) throw new Error("No WAV payload returned");
      const bytes = Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
      const blob = new Blob([bytes], { type: "audio/wav" });
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      setAudioUrl(URL.createObjectURL(blob));
      setNotice("Audio ready");
      await refreshPrivacyReceipt();
    });
  }, [api, audioUrl, refreshPrivacyReceipt, run, selectedRecordingId, selectedTrack, setNotice]);

  const deleteRecording = useCallback(async () => {
    if (!api || !selectedRecordingId) return;
    const recordingId = selectedRecordingId;
    await run("delete meeting", async () => {
      const result = asObject(await api.meetings.delete(recordingId));
      if (asBool(result.canceled)) {
        setNotice("Deletion canceled");
        return;
      }
      const dataRemoved = asBool(result.recordingDataRemoved);
      if (!dataRemoved) {
        setOpenMeetingIds((current) => current.filter((id) => id !== recordingId));
        setSelectedRecordingId("");
        resetMeetingAi();
        await loadRecording("");
        await refreshLibrary(0);
        setView("library");
        throw new Error("Deletion is incomplete. Candor will retry the local tombstone during recovery.");
      }
      if (audioUrl) {
        URL.revokeObjectURL(audioUrl);
        setAudioUrl("");
      }
      setOpenMeetingIds((current) => current.filter((id) => id !== recordingId));
      setSelectedRecordingId("");
      resetMeetingAi();
      await loadRecording("");
      await refreshLibrary(0);
      setView("library");
      setNotice(asBool(result.deleted)
        ? "Meeting permanently deleted from this device"
        : "Meeting data removed; encrypted index cleanup will retry locally");
    }, "recording-delete");
  }, [api, audioUrl, loadRecording, refreshLibrary, resetMeetingAi, run, selectedRecordingId, setNotice, setSelectedRecordingId, setView]);

  const openRecording = useCallback(async (recordingId: string, target: AppView = "meeting") => {
    if (recordingId !== selectedRecordingId) resetMeetingAi();
    setSelectedRecordingId(recordingId);
    setOpenMeetingIds((current) => nextOpenMeetingIds(current, recordingId));
    await loadRecording(recordingId);
    setView(target, recordingId);
  }, [loadRecording, resetMeetingAi, selectedRecordingId, setSelectedRecordingId, setView]);

  const closeMeetingTab = useCallback((recordingId: string) => {
    const remaining = openMeetingIds.filter((id) => id !== recordingId);
    setOpenMeetingIds(remaining);
    if (selectedRecordingId === recordingId) {
      const next = remaining[0] ?? "";
      setSelectedRecordingId(next);
      if (next) void loadRecording(next);
    }
  }, [loadRecording, openMeetingIds, selectedRecordingId, setSelectedRecordingId]);

  const pinRecording = useCallback((recordingId: string) => {
    setOpenMeetingIds((current) => nextOpenMeetingIds(current, recordingId));
  }, []);

  return {
    libraryFilter,
    notesPanelMode,
    compactMeetingPane,
    openMeetingIds,
    audioUrl,
    setLibraryFilter,
    setNotesPanelMode,
    setCompactMeetingPane,
    importV2Folder,
    searchRecordings,
    loadMoreRecordings,
    loadMoreTranscript,
    saveMeetingNotes,
    markMoment,
    loadAudio,
    deleteRecording,
    openRecording,
    closeMeetingTab,
    pinRecording,
  };
}
