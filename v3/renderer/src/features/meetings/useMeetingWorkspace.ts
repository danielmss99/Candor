import { useCallback, useEffect, useRef, useState } from "react";
import type { CandorClient } from "../../core/candor-client";
import {
  LIBRARY_PAGE_SIZE,
  TRANSCRIPT_PAGE_SIZE,
  asArray,
  asObject,
  asString,
  parseMarkedMoments,
  type JsonObject,
  type LocalJsonValue,
  type MarkedMoment,
  type MeetingPrivacyReceipt,
  type QuarantinedRecording,
  type RecordingSummary,
  type TranscriptSegment,
} from "../../core/contracts";
import { RequestCoordinator } from "../../state/request-coordinator";
import {
  NotesDraftTracker,
  type NotesSaveDisposition,
  type NotesSnapshot,
  type NotesUpdate,
} from "../notes/notes-draft";

type CoreApi = NonNullable<Window["candor"]>["core"];

interface UseMeetingWorkspaceOptions {
  api: CoreApi | undefined;
  client: CandorClient | null;
}

export function mergeRecordingPages(current: RecordingSummary[], incoming: RecordingSummary[]): RecordingSummary[] {
  return [...current, ...incoming.filter((item) => !current.some((existing) => existing.recordingId === item.recordingId))];
}

export function mergeTranscriptPages(current: TranscriptSegment[], incoming: TranscriptSegment[]): TranscriptSegment[] {
  return [...current, ...incoming.filter((item) => !current.some((existing) => existing.index === item.index))];
}

export function chooseInitialSelection(currentId: string, recordings: RecordingSummary[]): string {
  return currentId && recordings.some((recording) => recording.recordingId === currentId)
    ? currentId
    : recordings[0]?.recordingId ?? "";
}

export function useMeetingWorkspace({ api, client }: UseMeetingWorkspaceOptions) {
  const requests = useRef(new RequestCoordinator());
  const notesDraft = useRef(new NotesDraftTracker());
  const [recordings, setRecordings] = useState<RecordingSummary[]>([]);
  const [recordingTotalCount, setRecordingTotalCount] = useState(0);
  const [recordingsHaveMore, setRecordingsHaveMore] = useState(false);
  const [quarantinedRecordings, setQuarantinedRecordings] = useState<QuarantinedRecording[]>([]);
  const [quarantinedCount, setQuarantinedCount] = useState(0);
  const [selectedRecordingId, setSelectedRecordingId] = useState("");
  const [transcript, setTranscript] = useState<TranscriptSegment[]>([]);
  const [transcriptTotalCount, setTranscriptTotalCount] = useState(0);
  const [transcriptHasMore, setTranscriptHasMore] = useState(false);
  const [privacyReceipt, setPrivacyReceipt] = useState<MeetingPrivacyReceipt | null>(null);
  const [replay, setReplay] = useState<JsonObject>({});
  const [notesMarkdown, setNotesMarkdownState] = useState("");
  const [notesStatus, setNotesStatus] = useState<JsonObject>({});
  const [notesDirty, setNotesDirty] = useState(false);
  const [markedMoments, setMarkedMoments] = useState<MarkedMoment[]>([]);
  const [selectedTrack, setSelectedTrack] = useState("mic");
  const [recordingTitle, setRecordingTitle] = useState("Untitled local meeting");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMatches, setSearchMatches] = useState<LocalJsonValue[]>([]);

  const clearSelectedRecording = useCallback(() => {
    requests.current.invalidate("selected-recording");
    requests.current.invalidate("transcript-page");
    requests.current.invalidate("privacy-receipt");
    setTranscript([]);
    setTranscriptTotalCount(0);
    setTranscriptHasMore(false);
    setReplay({});
    const clearedNotes = notesDraft.current.load("", "");
    setNotesMarkdownState(clearedNotes.markdown);
    setNotesStatus({});
    setNotesDirty(false);
    setMarkedMoments([]);
    setPrivacyReceipt(null);
  }, []);

  const loadSelectedRecording = useCallback(async (recordingId: string, _preserveAi = false) => {
    requests.current.invalidate("transcript-page");
    requests.current.invalidate("privacy-receipt");
    if (!api || !client || !recordingId) {
      clearSelectedRecording();
      return;
    }
    const token = requests.current.begin("selected-recording");
    const [nextTranscript, replayObject, notesObject] = await Promise.all([
      client.transcriptPage(recordingId, 0, TRANSCRIPT_PAGE_SIZE),
      client.object("recording.durable.replayManifest", () => api.recordingDurableReplayManifest(recordingId)),
      client.object("recording.notes.read", () => api.recordingNotesRead(recordingId)),
    ]);
    if (!requests.current.isCurrent(token)) return;
    setTranscript(nextTranscript.segments);
    setTranscriptTotalCount(nextTranscript.segmentCount);
    setTranscriptHasMore(nextTranscript.hasMore);
    setReplay(replayObject);
    const nextMarkdown = asString(notesObject.markdown);
    notesDraft.current.load(recordingId, nextMarkdown);
    setNotesMarkdownState(nextMarkdown);
    setNotesStatus(notesObject);
    setNotesDirty(false);
    setMarkedMoments(parseMarkedMoments(nextMarkdown));
    setPrivacyReceipt(null);
    const receiptToken = requests.current.begin("privacy-receipt");
    void client.privacyReceipt(recordingId).then((receipt) => {
      if (requests.current.isCurrent(receiptToken)) setPrivacyReceipt(receipt);
    }).catch(() => {
      if (requests.current.isCurrent(receiptToken)) setPrivacyReceipt(null);
    });
    const tracks = asArray(replayObject.tracks).map((track) => asString(track)).filter(Boolean);
    setSelectedTrack((current) => tracks.length > 0 && !tracks.includes(current) ? tracks[0] : current);
  }, [api, clearSelectedRecording, client]);

  const refreshLibrary = useCallback(async (offset = 0) => {
    if (!client) return [] as RecordingSummary[];
    const token = requests.current.begin("library-page");
    const page = await client.recordingPage(offset, LIBRARY_PAGE_SIZE);
    if (!requests.current.isCurrent(token)) return [] as RecordingSummary[];
    setRecordings((current) => offset === 0 ? page.recordings : mergeRecordingPages(current, page.recordings));
    setRecordingTotalCount(page.totalCount);
    setRecordingsHaveMore(page.hasMore);
    setQuarantinedRecordings(page.quarantinedRecordings);
    setQuarantinedCount(page.quarantinedCount);
    return page.recordings;
  }, [client]);

  const refreshPrivacyReceipt = useCallback(async (recordingId = selectedRecordingId) => {
    if (!client || !recordingId) {
      setPrivacyReceipt(null);
      return;
    }
    const token = requests.current.begin("privacy-receipt");
    const receipt = await client.privacyReceipt(recordingId);
    if (requests.current.isCurrent(token)) setPrivacyReceipt(receipt);
  }, [client, selectedRecordingId]);

  const loadMoreTranscript = useCallback(async () => {
    if (!client || !selectedRecordingId || !transcriptHasMore) return;
    const token = requests.current.begin("transcript-page");
    const page = await client.transcriptPage(selectedRecordingId, transcript.length, TRANSCRIPT_PAGE_SIZE);
    if (!requests.current.isCurrent(token)) return;
    setTranscript((current) => mergeTranscriptPages(current, page.segments));
    setTranscriptTotalCount(page.segmentCount);
    setTranscriptHasMore(page.hasMore);
  }, [client, selectedRecordingId, transcript.length, transcriptHasMore]);

  const search = useCallback(async () => {
    if (!api || !searchQuery.trim()) return;
    const result = await api.recordingDurableSearch(searchQuery.trim());
    setSearchMatches(asArray(asObject(result).matches));
  }, [api, searchQuery]);

  const updateNotes = useCallback((update: NotesUpdate) => {
    const draft = notesDraft.current.edit(update);
    setNotesMarkdownState(draft.markdown);
    setNotesDirty(true);
  }, []);

  const captureNotesSnapshot = useCallback((): NotesSnapshot => notesDraft.current.snapshot(), []);
  const notesSnapshotDisposition = useCallback((snapshot: NotesSnapshot): NotesSaveDisposition => notesDraft.current.disposition(snapshot), []);

  const commitNotesSave = useCallback((snapshot: NotesSnapshot, status: JsonObject): NotesSaveDisposition => {
    const disposition = notesDraft.current.disposition(snapshot);
    if (disposition === "different-recording") return disposition;
    setNotesStatus(status);
    if (disposition === "current") setNotesDirty(false);
    return disposition;
  }, []);

  useEffect(() => () => {
    for (const scope of ["selected-recording", "transcript-page", "privacy-receipt", "library-page"]) {
      requests.current.invalidate(scope);
    }
  }, []);

  return {
    recordings,
    recordingTotalCount,
    recordingsHaveMore,
    quarantinedRecordings,
    quarantinedCount,
    selectedRecordingId,
    transcript,
    transcriptTotalCount,
    transcriptHasMore,
    privacyReceipt,
    replay,
    notesMarkdown,
    notesStatus,
    notesDirty,
    markedMoments,
    selectedTrack,
    recordingTitle,
    searchQuery,
    searchMatches,
    setSelectedRecordingId,
    setNotesMarkdown: updateNotes,
    setMarkedMoments,
    setSelectedTrack,
    setRecordingTitle,
    setSearchQuery,
    loadSelectedRecording,
    refreshLibrary,
    refreshPrivacyReceipt,
    loadMoreTranscript,
    search,
    updateNotes,
    captureNotesSnapshot,
    notesSnapshotDisposition,
    commitNotesSave,
  };
}
