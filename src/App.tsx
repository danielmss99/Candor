import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/v2.css";
import { Home } from "./screens/Home";
import { Landing } from "./screens/Landing";
import { Library } from "./screens/Library";
import { Search } from "./screens/Search";
import { Tasks } from "./screens/Tasks";
import { Live } from "./screens/LiveTranscription";
import { Recap } from "./screens/Recap";
import { People } from "./screens/People";
import { Files } from "./screens/Files";
import { RecordingBar } from "./components/RecordingBar";
import { ConnectCalendarModal } from "./components/ConnectCalendarModal";
import { NamePrompt } from "./components/NamePrompt";
import { SettingsModal, type Theme } from "./components/SettingsModal";
import { loadMeetingDetail, loadPrivacySettings, stopRecordingWithNotes, checkRecordingRecovery, recoverPartialRecording } from "./api/local";
import { formatRecordingTime } from "./utils/time";
import { invokeError } from "./api/calendar";
import {
  loadCompletedActions,
  loadUserTasks,
  persistCompletedActions,
  persistUserTasks,
  newUserTask,
  type CompletedAction,
  type UserTask,
} from "./api/actions";
import type { RecapData } from "./data/mock";
import { actionItems, meetings as mockMeetings } from "./data/mock";
import { generateRecapFromRecording, placeholderRecap } from "./recapGenerate";
import { MeetingMenuHost } from "./components/MeetingMenuHost";
import { CommandPalette } from "./components/CommandPalette";
import { KeyboardShortcuts } from "./components/KeyboardShortcuts";
import type { ContextMenuState, MeetingTarget } from "./meetingEdit";
import { UserContext, deriveUser, NAME_KEY } from "./user";
import {
  loadOnboarding,
  patchOnboarding,
  saveMoments,
  addPendingTasks,
  type MeetingMoments,
  type OnboardingState,
} from "./v2/metadata";
import { resolveActionId } from "./api/actions";
import { loadSavedMeetings, pickAndImportAudio } from "./api/local";
import { loadSummaryTemplate } from "./v2/summaryTemplates";

export type View =
  | "landing"
  | "home"
  | "library"
  | "people"
  | "files"
  | "actions"
  | "search"
  | "live"
  | "recap";
export interface TranscriptSegment {
  time: string;
  text: string;
  speaker?: string;
}
export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  attendees: string[];
  organizer: string;
  location: string;
  onlineUrl: string | null;
  allDay: boolean;
  provider: string;
  eventUrl?: string | null;
}

// "preparing" | "countdown" show a brief overlay; "recording" | "transcribing"
// render inline on the Live screen (no full-screen blocker).
type Rec = "idle" | "preparing" | "countdown" | "recording" | "transcribing";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const RECORDING_SESSION_KEY = "candor-v2.recording-session";

function format(elapsed: number): string {
  return formatRecordingTime(elapsed);
}

function App() {
  const [view, setView] = useState<View>("landing");
  const [rec, setRec] = useState<Rec>("idle");
  const [count, setCount] = useState(3);
  const [elapsed, setElapsed] = useState(0);
  const [downloadPct, setDownloadPct] = useState<number | null>(null);
  const [transcriptionPct, setTranscriptionPct] = useState<number | null>(null);
  const [transcript, setTranscript] = useState<TranscriptSegment[] | null>(null);
  const [sessionNotes, setSessionNotes] = useState("");
  const [activeRecap, setActiveRecap] = useState<RecapData | null>(null);
  const [meetingsRefreshKey, setMeetingsRefreshKey] = useState(0);
  const [completedActions, setCompletedActions] = useState<CompletedAction[]>([]);
  const [userTasks, setUserTasks] = useState<UserTask[]>([]);
  const [meetingMenu, setMeetingMenu] = useState<ContextMenuState | null>(null);
  const [pendingMeetingEdit, setPendingMeetingEdit] = useState<MeetingTarget | null>(null);
  const [recapRenameTarget, setRecapRenameTarget] = useState<MeetingTarget | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  const [paletteMeetings, setPaletteMeetings] = useState<{ id: string; title: string }[]>([]);
  const [onboarding, setOnboarding] = useState<OnboardingState>(() => loadOnboarding());
  const [liveMoments, setLiveMoments] = useState<MeetingMoments>({ bookmarks: [], highlights: [] });
  const [recapTranscript, setRecapTranscript] = useState<TranscriptSegment[] | null>(null);
  const [recapSessionNotes, setRecapSessionNotes] = useState("");
  const [recapProcessing, setRecapProcessing] = useState(false);
  const [recapProcessingMessage, setRecapProcessingMessage] = useState("Transcribing your recording…");
  const [transcriptionError, setTranscriptionError] = useState<string | null>(null);
  const [recordingEvent, setRecordingEvent] = useState<CalendarEvent | null>(null);
  const [showConsent, setShowConsent] = useState(false);
  const [pendingRecord, setPendingRecord] = useState<(() => void) | null>(null);
  const [calendarToast, setCalendarToast] = useState<CalendarEvent | null>(null);
  const [captureSystemAudio, setCaptureSystemAudio] = useState(false);
  const [diskWarning, setDiskWarning] = useState<string | null>(null);
  const [recoveryOffer, setRecoveryOffer] = useState<{
    meetingId: string;
    liveWavPath: string;
    durationSeconds: number;
    title?: string | null;
  } | null>(null);
  const [recovering, setRecovering] = useState(false);

  // Navigation context for search + recap
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedMeetingId, setSelectedMeetingId] = useState("q3-roadmap");
  const [jumpTimestamp, setJumpTimestamp] = useState<string | null>(null);

  // Calendar
  const [calStatus, setCalStatus] = useState({ microsoft: false, google: false, apple: false });
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [calError, setCalError] = useState<string | null>(null);
  const [showConnect, setShowConnect] = useState(false);
  const calConnected = calStatus.microsoft || calStatus.google || calStatus.apple;

  // User name — asked once on first run, persisted in localStorage.
  const [userName, setUserName] = useState<string>(() => localStorage.getItem(NAME_KEY) || "");
  const [editingName, setEditingName] = useState(false);
  const saveName = useCallback((n: string) => {
    localStorage.setItem(NAME_KEY, n);
    setUserName(n);
    setEditingName(false);
  }, []);

  // Settings + theme
  const [showSettings, setShowSettings] = useState(false);
  const [theme, setThemeState] = useState<Theme>(
    () => (localStorage.getItem("candor-v2.theme") as Theme) || "light",
  );
  const changeTheme = useCallback((t: Theme) => {
    localStorage.setItem("candor-v2.theme", t);
    setThemeState(t);
  }, []);
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  const signOut = useCallback(() => {
    if (!window.confirm("Sign out? This clears your name and disconnects your calendars.")) return;
    invoke("ms_disconnect").catch(() => {});
    invoke("google_disconnect").catch(() => {});
    invoke("apple_disconnect").catch(() => {});
    localStorage.removeItem(NAME_KEY);
    setCalStatus({ microsoft: false, google: false, apple: false });
    setEvents([]);
    setUserName("");
  }, []);

  const refreshCalendar = useCallback(async () => {
    if (!isTauri()) {
      setCalStatus({ microsoft: false, google: false, apple: false });
      setEvents([]);
      return;
    }
    try {
      const status = await invoke<{ microsoft: boolean; google: boolean; apple: boolean }>(
        "calendar_status",
      );
      setCalStatus(status);
      if (status.microsoft || status.google || status.apple) {
        try {
          const evs = await invoke<CalendarEvent[]>("list_events");
          setEvents(evs);
          setCalError(null);
        } catch (e) {
          setEvents([]);
          setCalError(invokeError(e));
        }
      } else {
        setEvents([]);
        setCalError(null);
      }
    } catch (e) {
      setCalError(invokeError(e));
    }
  }, []);

  const disconnectCalendar = useCallback(
    async (provider: "microsoft" | "google" | "apple") => {
      try {
        const cmd =
          provider === "microsoft"
            ? "ms_disconnect"
            : provider === "google"
              ? "google_disconnect"
              : "apple_disconnect";
        await invoke(cmd);
      } catch {
        /* ignore */
      }
      refreshCalendar();
    },
    [refreshCalendar],
  );

  useEffect(() => {
    refreshCalendar();
  }, [refreshCalendar]);

  useEffect(() => {
    if (calConnected) {
      patchOnboarding({ calendarConnected: true });
      setOnboarding(loadOnboarding());
    }
  }, [calConnected]);

  useEffect(() => {
    loadPrivacySettings().then((p) => setCaptureSystemAudio(p.captureSystemAudio)).catch(() => {});
  }, [showSettings]);

  // Notify when a calendar meeting starts within 2 minutes.
  useEffect(() => {
    if (!calConnected || events.length === 0) return;
    const tick = () => {
      const now = Date.now();
      const soon = events.find((ev) => {
        const start = Date.parse(ev.start);
        const diff = start - now;
        return diff > 0 && diff <= 2 * 60 * 1000;
      });
      if (soon) setCalendarToast(soon);
    };
    tick();
    const id = window.setInterval(tick, 30_000);
    return () => window.clearInterval(id);
  }, [calConnected, events]);

  useEffect(() => {
    loadSavedMeetings().then((m) =>
      setPaletteMeetings(
        (m.length > 0 ? m : mockMeetings).map((x) => ({ id: x.id, title: x.title })),
      ),
    );
  }, [meetingsRefreshKey]);

  const recapCtx = useCallback(
    (partial: {
      transcript: TranscriptSegment[];
      sessionNotes: string;
      durationSeconds: number;
      recordedAt: Date;
      titleOverride?: string;
    }) => ({
      ...partial,
      userInitials: deriveUser(userName).initials,
      template: loadSummaryTemplate(),
    }),
    [userName],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (showPalette) {
          setShowPalette(false);
          return;
        }
        if (showShortcuts) {
          setShowShortcuts(false);
          return;
        }
        if (showSettings) {
          setShowSettings(false);
          return;
        }
        if (showConnect) {
          setShowConnect(false);
          return;
        }
        if (editingName) {
          setEditingName(false);
          return;
        }
        if (showConsent) {
          setShowConsent(false);
          setPendingRecord(null);
          return;
        }
        if (meetingMenu) {
          setMeetingMenu(null);
          return;
        }
      }
      const overlayOpen =
        showPalette ||
        showShortcuts ||
        showSettings ||
        showConnect ||
        editingName ||
        showConsent ||
        meetingMenu !== null;
      if (e.key === "?" && !e.metaKey && !e.ctrlKey) {
        const tag = (e.target as HTMLElement)?.tagName;
        if (overlayOpen || tag === "INPUT" || tag === "TEXTAREA") return;
        e.preventDefault();
        setShowShortcuts(true);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        if (overlayOpen) return;
        e.preventDefault();
        setShowPalette(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editingName, meetingMenu, showConnect, showConsent, showPalette, showSettings, showShortcuts]);

  useEffect(() => {
    loadCompletedActions().then((loaded) => {
      if (loaded.length === 0) {
        const seeded = actionItems
          .filter((a) => a.done)
          .map((a) => ({
            id: a.id,
            text: a.text,
            owner: a.owner,
            due: a.due,
            meeting: a.meeting,
            meetingId: a.meetingId,
            soon: a.soon,
            completedAt: new Date().toISOString(),
          }));
        if (seeded.length > 0) {
          persistCompletedActions(seeded).then(() => setCompletedActions(seeded));
          return;
        }
      }
      setCompletedActions(loaded);
    });
    loadUserTasks().then(setUserTasks);
  }, []);

  const completedIds = useMemo(
    () => new Set(completedActions.map((a) => a.id)),
    [completedActions],
  );

  const completeAction = useCallback((item: Omit<CompletedAction, "completedAt">) => {
    const record: CompletedAction = { ...item, completedAt: new Date().toISOString() };
    setCompletedActions((prev) => {
      const next = [...prev.filter((a) => a.id !== record.id), record];
      void persistCompletedActions(next);
      return next;
    });
    patchOnboarding({ taskCompleted: true });
    setOnboarding(loadOnboarding());
  }, []);

  const uncompleteAction = useCallback((id: string) => {
    setCompletedActions((prev) => {
      const next = prev.filter((a) => a.id !== id);
      void persistCompletedActions(next);
      return next;
    });
  }, []);

  const addUserTask = useCallback(
    (params: { text: string; owner: string; dueDate?: string; meeting?: string }) => {
      const task = newUserTask(params);
      setUserTasks((prev) => {
        const next = [task, ...prev];
        void persistUserTasks(next);
        return next;
      });
    },
    [],
  );

  const openMeetingContextMenu = useCallback((x: number, y: number, target: ContextMenuState["target"]) => {
    setMeetingMenu({ x, y, target });
  }, []);

  const clearPendingMeetingEdit = useCallback(() => setPendingMeetingEdit(null), []);

  const handleSavedMeetingUpdated = useCallback(
    async (id: string) => {
      if (selectedMeetingId !== id) return;
      const detail = await loadMeetingDetail(id);
      if (!detail) return;
      setActiveRecap(
        generateRecapFromRecording(
          recapCtx({
            transcript: detail.transcript,
            sessionNotes: detail.userNotes,
            durationSeconds: detail.durationSeconds,
            recordedAt: detail.date ? new Date(detail.date) : new Date(),
            titleOverride: detail.title,
          }),
        ),
      );
      setRecapTranscript(detail.transcript);
      setRecapRenameTarget({
        kind: "saved",
        meeting: {
          id: detail.id,
          title: detail.title,
          date: detail.date,
          whenLabel: "",
          blurb: "",
          durationMinutes: Math.max(1, Math.round(detail.durationSeconds / 60)),
          path: "",
        },
      });
    },
    [selectedMeetingId, recapCtx],
  );

  const timerRef = useRef<number | undefined>(undefined);
  const cancelRef = useRef(false);
  const stopTimer = useCallback(() => {
    if (timerRef.current) window.clearInterval(timerRef.current);
  }, []);

  // Backend events: model download progress + audio errors.
  useEffect(() => {
    if (!isTauri()) {
      return () => stopTimer();
    }
    const unlisteners: Array<() => void> = [];
    listen<{ downloaded: number; total: number }>("model-download-progress", (e) => {
      const { downloaded, total } = e.payload;
      if (total > 0) setDownloadPct(Math.round((downloaded / total) * 100));
    }).then((u) => unlisteners.push(u));
    listen<{ chunk: number; totalChunks: number; percent: number }>(
      "transcription-progress",
      (e) => {
        setTranscriptionPct(e.payload.percent);
        if (e.payload.percent > 0) {
          setRecapProcessingMessage(
            `Transcribing your recording… ${e.payload.percent}% (chunk ${e.payload.chunk}/${e.payload.totalChunks})`,
          );
        }
      },
    ).then((u) => unlisteners.push(u));
    listen<{
      meetingId: string;
      durationSeconds: number;
      audioPath: string;
      freeDiskBytes?: number | null;
      lowDisk: boolean;
    }>("recording-checkpoint", (e) => {
      localStorage.setItem(
        RECORDING_SESSION_KEY,
        JSON.stringify({
          meetingId: e.payload.meetingId,
          durationSeconds: e.payload.durationSeconds,
          audioPath: e.payload.audioPath,
          savedAt: new Date().toISOString(),
        }),
      );
      if (e.payload.lowDisk && e.payload.freeDiskBytes != null) {
        const gb = (e.payload.freeDiskBytes / (1024 * 1024 * 1024)).toFixed(1);
        setDiskWarning(`Low disk space (${gb} GB free). Long recordings need ~115 MB/hour.`);
      }
    }).then((u) => unlisteners.push(u));
    listen<string>("recording-error", (e) => {
      setError(String(e.payload));
      stopTimer();
      setRec("idle");
      setView("live");
    }).then((u) => unlisteners.push(u));
    return () => {
      unlisteners.forEach((u) => u());
      stopTimer();
    };
  }, [stopTimer]);

  const openSavedRecap = useCallback(
    (id: string, detail: NonNullable<Awaited<ReturnType<typeof loadMeetingDetail>>>) => {
      setActiveRecap(
        generateRecapFromRecording(
          recapCtx({
            transcript: detail.transcript,
            sessionNotes: detail.userNotes,
            durationSeconds: detail.durationSeconds,
            recordedAt: detail.date ? new Date(detail.date) : new Date(),
            titleOverride: detail.title,
          }),
        ),
      );
      setRecapTranscript(detail.transcript);
      setRecapRenameTarget({
        kind: "saved",
        meeting: {
          id: detail.id,
          title: detail.title,
          date: detail.date,
          whenLabel: "",
          blurb: "",
          durationMinutes: Math.max(1, Math.round(detail.durationSeconds / 60)),
          path: "",
        },
      });
      setSelectedMeetingId(id);
      setJumpTimestamp(null);
      setView("recap");
    },
    [userName],
  );

  const openMeeting = useCallback(
    async (id: string) => {
      setJumpTimestamp(null);
      if (isTauri()) {
        const detail = await loadMeetingDetail(id);
        if (detail) {
          openSavedRecap(id, detail);
          return;
        }
      }
      setActiveRecap(null);
      setRecapRenameTarget(null);
      setSelectedMeetingId(id);
      setView("recap");
    },
    [openSavedRecap],
  );

  const openSearch = useCallback((query?: string) => {
    setSearchQuery(query ?? "");
    setView("search");
  }, []);

  const navigate = useCallback((v: View) => {
    if (v === "search") setSearchQuery("");
    setView(v);
  }, []);

  const jumpToMeeting = useCallback((meetingId: string, timestamp?: string) => {
    setSelectedMeetingId(meetingId);
    setJumpTimestamp(timestamp ?? null);
    setView("recap");
  }, []);

  const navigateToRecapAfterRecording = useCallback(
    async (params: {
      meetingId: string | null;
      segments: TranscriptSegment[];
      notes: string;
      duration: number;
      processing?: boolean;
      transcriptionError?: string | null;
    }) => {
      const { meetingId, segments, notes, duration, processing, transcriptionError: txErr } = params;
      setRecapProcessing(processing ?? false);
      setTranscriptionError(txErr ?? null);
      setRecapSessionNotes(notes);

      if (processing) {
        setActiveRecap(
          placeholderRecap({
            recordedAt: new Date(),
            durationSeconds: duration,
            titleOverride: recordingEvent?.title,
          }),
        );
        setRecapTranscript([]);
        setSelectedMeetingId(meetingId ?? `recording-${Date.now()}`);
        setRecapRenameTarget(null);
        setJumpTimestamp(null);
        setView("recap");
        return;
      }

      if (meetingId && isTauri()) {
        const detail = await loadMeetingDetail(meetingId);
        if (detail) {
          openSavedRecap(meetingId, detail);
          return;
        }
      }
      setActiveRecap(
        generateRecapFromRecording(
          recapCtx({
            transcript: segments,
            sessionNotes: notes,
            durationSeconds: duration,
            recordedAt: new Date(),
            titleOverride: recordingEvent?.title,
          }),
        ),
      );
      setRecapTranscript(segments);
      setSelectedMeetingId(meetingId ?? `recording-${Date.now()}`);
      setRecapRenameTarget(null);
      setJumpTimestamp(null);
      setView("recap");
    },
    [openSavedRecap, recapCtx, recordingEvent?.title],
  );

  // Offer recovery if a previous recording was interrupted.
  useEffect(() => {
    if (!isTauri() || rec !== "idle") return;
    checkRecordingRecovery()
      .then((r) => {
        if (r && r.durationSeconds > 0) setRecoveryOffer(r);
      })
      .catch(() => {});
  }, [rec, meetingsRefreshKey]);

  const handleRecoverPartial = useCallback(async () => {
    if (!recoveryOffer) return;
    setRecovering(true);
    setError(null);
    try {
      const result = await recoverPartialRecording(
        recoveryOffer.liveWavPath,
        recoveryOffer.meetingId,
        recoveryOffer.title ?? undefined,
      );
      localStorage.removeItem(RECORDING_SESSION_KEY);
      setRecoveryOffer(null);
      setMeetingsRefreshKey((k) => k + 1);
      await navigateToRecapAfterRecording({
        meetingId: result.meetingId,
        segments: result.segments,
        notes: "",
        duration: recoveryOffer.durationSeconds,
        processing: false,
        transcriptionError:
          result.status === "transcription_failed"
            ? result.transcriptionError ?? "Transcription failed"
            : null,
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setRecovering(false);
    }
  }, [recoveryOffer, navigateToRecapAfterRecording]);

  // Start: ensure model → countdown → begin mic capture.
  const runRecording = useCallback(async () => {
    if (rec !== "idle") return;
    setError(null);
    cancelRef.current = false;

    if (!isTauri()) {
      setError(
        "Recording requires the Candor desktop app. Run npm run tauri dev instead of opening the browser.",
      );
      setView("live");
      return;
    }

    try {
      setDownloadPct(null);
      setRec("preparing");
      setView("live");
      await invoke("ensure_model");
      if (cancelRef.current) return;

      setRec("countdown");
      for (let c = 3; c >= 1; c--) {
        if (cancelRef.current) return;
        setCount(c);
        await sleep(850);
      }
      if (cancelRef.current) return;

      setTranscript(null);
      setSessionNotes(
        recordingEvent
          ? `Meeting: ${recordingEvent.title}\n${recordingEvent.attendees.length ? `Attendees: ${recordingEvent.attendees.join(", ")}\n` : ""}`
          : "",
      );
      setLiveMoments({ bookmarks: [], highlights: [] });
      setElapsed(0);
      setDiskWarning(null);
      await invoke("start_recording", {
        captureSystemAudio,
        titleOverride: recordingEvent?.title ?? null,
      });
      setRec("recording");
      timerRef.current = window.setInterval(() => setElapsed((e) => e + 1), 1000);
    } catch (e) {
      setError(String(e));
      setRec("idle");
      setView("live");
    }
  }, [rec, captureSystemAudio, recordingEvent]);

  const startRecording = useCallback(async () => {
    setRecordingEvent(null);
    const privacy = await loadPrivacySettings().catch(() => null);
    const sys = privacy?.captureSystemAudio ?? false;
    setCaptureSystemAudio(sys);
    if (sys) {
      setPendingRecord(() => runRecording);
      setShowConsent(true);
      return;
    }
    await runRecording();
  }, [runRecording]);

  const startRecordingFromEvent = useCallback(
    async (ev: CalendarEvent) => {
      setRecordingEvent(ev);
      const privacy = await loadPrivacySettings().catch(() => null);
      const sys = privacy?.captureSystemAudio ?? false;
      setCaptureSystemAudio(sys);
      if (sys) {
        setPendingRecord(() => runRecording);
        setShowConsent(true);
        return;
      }
      await runRecording();
    },
    [runRecording],
  );

  // Stop: navigate to recap immediately, then transcribe + save in background.
  const stopRecording = useCallback(async () => {
    stopTimer();
    setTranscriptionPct(0);
    setError(null);
    const duration = elapsed;
    const notes = sessionNotes;
    const eventTitle = recordingEvent?.title;

    await navigateToRecapAfterRecording({
      meetingId: null,
      segments: [],
      notes,
      duration,
      processing: true,
    });
    setRec("transcribing");

    try {
      const result = await stopRecordingWithNotes(notes.trim() || null, duration, {
        titleOverride: eventTitle,
        calendarEventId: recordingEvent?.id,
      });
      setTranscript(result.segments);
      const txErr =
        result.status === "transcription_failed"
          ? result.transcriptionError ?? "Transcription failed"
          : null;
      if (result.meetingId) {
        saveMoments(result.meetingId, liveMoments);
        if (result.status === "complete") {
          const recap = generateRecapFromRecording(
            recapCtx({
              transcript: result.segments,
              sessionNotes: notes,
              durationSeconds: duration,
              recordedAt: new Date(),
              titleOverride: eventTitle,
            }),
          );
          addPendingTasks(
            recap.actions.map((a, i) => ({
              id: resolveActionId(result.meetingId, i, a.text, recap.title),
              meetingId: result.meetingId,
              meetingTitle: recap.title,
              text: a.text,
              owner: a.owner,
              due: a.due,
              soon: a.soon,
            })),
          );
        }
      }
      patchOnboarding({ firstRecording: true });
      setOnboarding(loadOnboarding());
      setMeetingsRefreshKey((k) => k + 1);
      await navigateToRecapAfterRecording({
        meetingId: result.meetingId,
        segments: result.segments,
        notes,
        duration,
        processing: false,
        transcriptionError: txErr,
      });
    } catch (e) {
      setError(String(e));
      setRecapProcessing(false);
      setTranscriptionError(String(e));
    } finally {
      setTranscriptionPct(null);
      setRec("idle");
      setRecordingEvent(null);
      setDiskWarning(null);
      localStorage.removeItem(RECORDING_SESSION_KEY);
    }
  }, [stopTimer, sessionNotes, elapsed, navigateToRecapAfterRecording, liveMoments, recordingEvent, recapCtx]);

  // Cancel the pre-roll (preparing/countdown) and unblock the UI.
  const cancelPreroll = useCallback(() => {
    cancelRef.current = true;
    stopTimer();
    setRec("idle");
  }, [stopTimer]);

  // Esc dismisses the pre-roll overlay so it can never trap the user.
  useEffect(() => {
    if (rec !== "preparing" && rec !== "countdown") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancelPreroll();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rec, cancelPreroll]);

  const importAudio = useCallback(async () => {
    if (!isTauri()) {
      setError(
        "Importing audio requires the Candor desktop app. Run npm run tauri dev instead of opening the browser.",
      );
      return;
    }
    try {
      const result = await pickAndImportAudio();
      if (!result) return;
      setMeetingsRefreshKey((k) => k + 1);
      await navigateToRecapAfterRecording({
        meetingId: result.meetingId,
        segments: result.segments,
        notes: "",
        duration: 0,
      });
    } catch (e) {
      setError(String(e));
    }
  }, [navigateToRecapAfterRecording]);

  const timeLabel = format(elapsed);

  // First run: ask the user's name before showing the app.
  if (!userName) {
    return <NamePrompt onSubmit={saveName} />;
  }

  return (
    <UserContext.Provider
      value={{
        ...deriveUser(userName),
        onEditName: () => setEditingName(true),
        onConnectCalendar: () => setShowConnect(true),
        calendar: calStatus,
        onDisconnect: disconnectCalendar,
        onOpenSettings: () => setShowSettings(true),
        onSignOut: signOut,
      }}
    >
      {view === "landing" && (
        <Landing onNavigate={navigate} onStartRecording={startRecording} />
      )}
      {view !== "landing" && (
        <div key={view} className="workspace-view">
      {view === "home" && (
        <Home
          onNavigate={navigate}
          onStartRecording={startRecording}
          onOpenMeeting={openMeeting}
          calendarConnected={calConnected}
          events={events}
          onConnectCalendar={() => setShowConnect(true)}
          onRecordEvent={startRecordingFromEvent}
          completedIds={completedIds}
          onCompleteAction={completeAction}
          userTasks={userTasks}
          onMeetingContextMenu={openMeetingContextMenu}
          meetingsRefreshKey={meetingsRefreshKey}
          onboarding={onboarding}
        />
      )}
      {view === "library" && (
        <Library
          onNavigate={navigate}
          onStartRecording={startRecording}
          onOpenMeeting={openMeeting}
          onSearch={openSearch}
          calendarConnected={calConnected}
          events={events}
          onConnectCalendar={() => setShowConnect(true)}
          onRecordEvent={startRecordingFromEvent}
          meetingsRefreshKey={meetingsRefreshKey}
          onMeetingContextMenu={openMeetingContextMenu}
          onImportAudio={importAudio}
        />
      )}
      {view === "people" && <People onNavigate={navigate} onOpenMeeting={openMeeting} />}
      {view === "files" && (
        <Files
          onNavigate={navigate}
          onOpenMeeting={openMeeting}
          refreshKey={meetingsRefreshKey}
          onMeetingContextMenu={openMeetingContextMenu}
        />
      )}
      {view === "actions" && (
        <Tasks
          onNavigate={navigate}
          completedIds={completedIds}
          completedActions={completedActions}
          onCompleteAction={completeAction}
          onUncompleteAction={uncompleteAction}
          userTasks={userTasks}
          onAddTask={addUserTask}
          onJumpToMeeting={jumpToMeeting}
          onTaskCompleted={() => {
            patchOnboarding({ taskCompleted: true });
            setOnboarding(loadOnboarding());
          }}
        />
      )}
      {view === "search" && (
        <Search
          onNavigate={navigate}
          query={searchQuery}
          onQueryChange={setSearchQuery}
          onJump={jumpToMeeting}
          meetingsRefreshKey={meetingsRefreshKey}
        />
      )}
      {view === "live" && (
        <Live
          timeLabel={timeLabel}
          sessionNotes={sessionNotes}
          onSessionNotesChange={setSessionNotes}
          recording={rec === "recording"}
          error={error}
          onNavigate={navigate}
          moments={liveMoments}
          onMomentsChange={setLiveMoments}
        />
      )}
      {view === "recap" && (
        <Recap
          meetingId={selectedMeetingId}
          recapData={activeRecap}
          transcript={recapTranscript ?? transcript ?? undefined}
          sessionNotes={recapSessionNotes || sessionNotes}
          jumpTimestamp={jumpTimestamp}
          onNavigate={navigate}
          completedIds={completedIds}
          onCompleteAction={completeAction}
          onRecapReviewed={() => {
            patchOnboarding({ recapReviewed: true });
            setOnboarding(loadOnboarding());
          }}
          canRename={recapRenameTarget !== null}
          onRename={() => recapRenameTarget && setPendingMeetingEdit(recapRenameTarget)}
          processing={recapProcessing}
          processingMessage={recapProcessingMessage}
          transcriptionError={transcriptionError}
        />
      )}
        </div>
      )}

      {rec !== "idle" && (
        <RecordingBar
          phase={rec}
          count={count}
          timeLabel={timeLabel}
          downloadPct={downloadPct}
          transcriptionPct={transcriptionPct}
          onStop={stopRecording}
          onCancel={cancelPreroll}
        />
      )}

      {error && rec === "idle" && view !== "live" && (
        <div className="rec-error-toast" role="alert">
          ⚠ {error}
          <button type="button" className="rec-error-dismiss" onClick={() => setError(null)}>
            ×
          </button>
        </div>
      )}

      {recoveryOffer && rec === "idle" && (
        <div className="rec-error-toast" role="status">
          Interrupted recording found ({formatRecordingTime(recoveryOffer.durationSeconds)}).{" "}
          <button
            type="button"
            className="btn-ghost"
            disabled={recovering}
            onClick={() => void handleRecoverPartial()}
          >
            {recovering ? "Recovering…" : "Save & transcribe"}
          </button>
          <button
            type="button"
            className="rec-error-dismiss"
            onClick={() => setRecoveryOffer(null)}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      {diskWarning && rec === "recording" && (
        <div className="rec-error-toast" role="status">
          ⚠ {diskWarning}
          <button type="button" className="rec-error-dismiss" onClick={() => setDiskWarning(null)}>
            ×
          </button>
        </div>
      )}

      {calError && rec === "idle" && view !== "live" && (
        <div className="rec-error-toast" role="alert">
          ⚠ Calendar: {calError}
          <button type="button" className="rec-error-dismiss" onClick={() => setCalError(null)}>
            ×
          </button>
        </div>
      )}

      {showConnect && (
        <ConnectCalendarModal
          onClose={() => setShowConnect(false)}
          onConnected={() => {
            setShowConnect(false);
            refreshCalendar();
          }}
        />
      )}

      {editingName && (
        <NamePrompt
          initial={userName}
          canCancel
          onSubmit={saveName}
          onCancel={() => setEditingName(false)}
        />
      )}

      {showConsent && (
        <div className="modal-backdrop">
          <div className="modal-card consent-card">
            <div className="modal-head">
              <span className="modal-title">Recording consent</span>
            </div>
            <div className="modal-body">
              <p>
                System audio capture records sound from your computer, including other meeting
                participants. Ensure you have consent from everyone on the call and follow your
                local laws and company policy.
              </p>
              <div className="consent-actions">
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => {
                    setShowConsent(false);
                    setPendingRecord(null);
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => {
                    setShowConsent(false);
                    pendingRecord?.();
                    setPendingRecord(null);
                  }}
                >
                  I have consent — start recording
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {calendarToast && rec === "idle" && (
        <div className="calendar-toast" role="status">
          <span>
            <strong>{calendarToast.title}</strong> starts soon
          </span>
          <button
            type="button"
            className="btn-record-sm"
            onClick={() => {
              void startRecordingFromEvent(calendarToast);
              setCalendarToast(null);
            }}
          >
            Record
          </button>
          <button type="button" className="rec-error-dismiss" onClick={() => setCalendarToast(null)}>
            ×
          </button>
        </div>
      )}

      {showSettings && (
        <SettingsModal
          theme={theme}
          onThemeChange={changeTheme}
          onClose={() => setShowSettings(false)}
        />
      )}

      <MeetingMenuHost
        menu={meetingMenu}
        onCloseMenu={() => setMeetingMenu(null)}
        onRefreshCalendar={refreshCalendar}
        onRefreshSaved={() => setMeetingsRefreshKey((k) => k + 1)}
        onOpenSaved={openMeeting}
        onRecord={startRecording}
        onRecordEvent={startRecordingFromEvent}
        pendingEdit={pendingMeetingEdit}
        onPendingEditHandled={clearPendingMeetingEdit}
        onSavedMeetingUpdated={handleSavedMeetingUpdated}
      />

      {showShortcuts && <KeyboardShortcuts onClose={() => setShowShortcuts(false)} />}

      <CommandPalette
        open={showPalette}
        onClose={() => setShowPalette(false)}
        onNavigate={navigate}
        onStartRecording={startRecording}
        onSearch={(q) => {
          setSearchQuery(q);
          setView("search");
        }}
        meetingTitles={paletteMeetings}
        onOpenMeeting={openMeeting}
      />
    </UserContext.Provider>
  );
}

export default App;
