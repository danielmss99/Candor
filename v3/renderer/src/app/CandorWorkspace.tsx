import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AnimatedTranscript,
  type EvidenceMarker,
} from "../meeting-motion";
import { AppShell } from "./AppShell";
import { CandorClient } from "../core/candor-client";
import { ExportView } from "../features/export/ExportView";
import { PrivacyReceipt } from "../features/privacy/PrivacyReceipt";
import { HomeView } from "../features/home/HomeView";
import { LibraryView } from "../features/library/LibraryView";
import { LiveMeetingView } from "../features/meeting/LiveMeetingView";
import { ActivationGate, OnboardingSetup } from "../features/onboarding/ActivationFlow";
import { MeetingDetailView } from "../features/detail/MeetingDetailView";
import { ReviewView } from "../features/review/ReviewView";
import { SettingsView } from "../features/settings/SettingsView";
import { useCaptureSession } from "../features/capture/useCaptureSession";
import { useLocalJob } from "../features/ai/useLocalJob";
import { useRuntimeStatus } from "../features/startup/useRuntimeStatus";
import {
  DEFAULT_MODEL,
  LIBRARY_PAGE_SIZE,
  TRANSCRIPT_PAGE_SIZE,
  asArray,
  asBool,
  asNumber,
  asObject,
  asString,
  exportFormatLabel,
  exportReportItem,
  formatDuration,
  metric,
  parseAnswer,
  parseMarkedMoments,
  parseRecap,
  parseModels,
  recapItemKey,
  type AiMode,
  type AppView,
  type CompactMeetingPane,
  type DetailSection,
  type ExportFormat,
  type ExportPaperSize,
  type InstructAssetKind,
  type JsonObject,
  type LibraryFilter,
  type LocalAiAnswer,
  type LocalAiRecap,
  type LocalJsonValue,
  type MarkedMoment,
  type MeetingPrivacyReceipt,
  type OnboardingStep,
  type RecapItem,
  type RecordingSummary,
  type ReviewSection,
  type SettingsSection,
  type TranscriptSegment,
} from "../core/contracts";
import type { JobKind } from "../state/operation-machines";
import { ExclusiveActionRegistry, RequestCoordinator } from "../state/request-coordinator";

export function CandorWorkspace() {
  const api = window.candor?.core;
  const licenseApi = window.candor?.license;
  const client = useMemo(() => (api ? new CandorClient(api) : null), [api]);
  const requestCoordinator = useRef(new RequestCoordinator());
  const exclusiveActions = useRef(new ExclusiveActionRegistry());
  const startupLoaded = useRef(false);
  const [view, setView] = useState<AppView>("meeting");
  const [detailSection, setDetailSection] = useState<DetailSection>("summary");
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [reviewSection, setReviewSection] = useState<ReviewSection>("summary");
  const [libraryFilter, setLibraryFilter] = useState<LibraryFilter>("all");
  const [onboardingStep, setOnboardingStep] = useState<OnboardingStep>("activate");
  const [licenseStatus, setLicenseStatus] = useState<JsonObject>({});
  const [licensePortalInfo, setLicensePortalInfo] = useState<JsonObject>({});
  const [licenseLoaded, setLicenseLoaded] = useState(false);
  const [licenseKey, setLicenseKey] = useState("");
  const [licenseEmail, setLicenseEmail] = useState("");
  const [licenseKeyTouched, setLicenseKeyTouched] = useState(false);
  const [notesPanelMode, setNotesPanelMode] = useState<"notes" | "suggestions">("notes");
  const [compactMeetingPane, setCompactMeetingPane] = useState<CompactMeetingPane>("transcript");
  const [advancedSettingsOpen, setAdvancedSettingsOpen] = useState(false);
  const [openMeetingIds, setOpenMeetingIds] = useState<string[]>([]);
  const [reviewStates, setReviewStates] = useState<Record<string, "accepted" | "rejected">>({});
  const [reviewSummaryDraft, setReviewSummaryDraft] = useState("");
  const [exportFormat, setExportFormat] = useState<ExportFormat>("docx");
  const [exportPaperSize, setExportPaperSize] = useState<ExportPaperSize>("letter");
  const [exportSections, setExportSections] = useState({
    summary: true,
    decisions: true,
    actions: true,
    risks: true,
    questions: true,
    notes: true,
    transcript: false,
    timestamps: false,
  });

  const [recordings, setRecordings] = useState<RecordingSummary[]>([]);
  const [recordingTotalCount, setRecordingTotalCount] = useState(0);
  const [recordingsHaveMore, setRecordingsHaveMore] = useState(false);
  const [selectedRecordingId, setSelectedRecordingId] = useState("");
  const [transcript, setTranscript] = useState<TranscriptSegment[]>([]);
  const [transcriptTotalCount, setTranscriptTotalCount] = useState(0);
  const [transcriptHasMore, setTranscriptHasMore] = useState(false);
  const [privacyReceipt, setPrivacyReceipt] = useState<MeetingPrivacyReceipt | null>(null);
  const [replay, setReplay] = useState<JsonObject>({});
  const [notesMarkdown, setNotesMarkdown] = useState("");
  const [notesStatus, setNotesStatus] = useState<JsonObject>({});
  const [notesDirty, setNotesDirty] = useState(false);
  const [markedMoments, setMarkedMoments] = useState<MarkedMoment[]>([]);
  const [selectedTrack, setSelectedTrack] = useState("mic");
  const [recordingTitle, setRecordingTitle] = useState("Untitled local meeting");
  const [selectedModel, setSelectedModel] = useState(DEFAULT_MODEL);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMatches, setSearchMatches] = useState<LocalJsonValue[]>([]);
  const [askQuestion, setAskQuestion] = useState("What are the action items?");
  const [askAnswer, setAskAnswer] = useState<LocalAiAnswer | null>(null);
  const [recap, setRecap] = useState<LocalAiRecap | null>(null);
  const [aiMode, setAiMode] = useState<AiMode>("quality");
  const [instructAssetKind, setInstructAssetKind] = useState<InstructAssetKind>("runner");
  const [instructExpectedSha256, setInstructExpectedSha256] = useState("");
  const [instructAssetError, setInstructAssetError] = useState("");
  const [instructSetupOpen, setInstructSetupOpen] = useState(false);
  const [markdownExport, setMarkdownExport] = useState("");
  const [audioUrl, setAudioUrl] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const {
    coreStatus,
    capabilities,
    privacyAudit,
    networkCapabilities,
    updateStatus,
    v2ImportStatus,
    consentStatus,
    vaultStatus,
    captureStatus,
    aiStatus,
    instructAssetsStatus,
    instructStatus,
    schedulerStatus,
    modelStatus,
    transcriptionStatus,
    retentionStatus,
    diagnosticFailures,
    setConsentStatus,
    loadCritical,
    loadDiagnostics,
    refreshCapture,
    refreshModelsAndAi,
    refreshPrivacyFacts,
    refreshVaultAndRetention,
  } = useRuntimeStatus(api, client);

  const activeCapture = asBool(captureStatus.active);
  const activeRecordingId = asString(asObject(captureStatus.activeSession).recordingId);
  const captureSession = useCaptureSession(activeCapture, activeRecordingId);
  const localJob = useLocalJob();
  const captureMachine = captureSession.state;
  const jobMachine = localJob.state;
  const instructReady = asBool(instructStatus.ready);
  const instructAssetsReady = asBool(instructAssetsStatus.ready);
  const instructRunnerAsset = asObject(instructAssetsStatus.runner);
  const instructModelAsset = asObject(instructAssetsStatus.model);
  const useInstructModel = aiMode === "quality" && instructReady;
  const models = useMemo(() => parseModels(modelStatus), [modelStatus]);
  const selectedRecording = recordings.find((item) => item.recordingId === selectedRecordingId);
  const tracks = useMemo(
    () => asArray(replay.tracks).map((track) => asString(track)).filter(Boolean),
    [replay],
  );
  const selectedTitle = selectedRecording?.label || recordingTitle || "Untitled local meeting";
  const combinedCaptureAvailable = asBool(asObject(asObject(captureStatus.sources).system).simultaneousMicAndSystem);
  const licenseState = asString(licenseStatus.state, "inactive");
  const licenseActive = licenseState === "activated" || licenseState === "trial";
  const licenseKeyInvalid = licenseKeyTouched && !licenseKey.trim();

  const run = useCallback(async (
    label: string,
    task: () => Promise<void>,
    exclusiveScope = label,
    jobKind?: JobKind,
  ) => {
    const release = exclusiveActions.current.acquire(exclusiveScope);
    if (!release) {
      setNotice(`${label} is already in progress`);
      return;
    }
    const requestId = jobKind ? localJob.begin(jobKind) : 0;
    setBusy(label);
    setError("");
    setNotice("");
    try {
      await task();
      if (jobKind) localJob.complete(requestId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      if (exclusiveScope === "capture") captureSession.failed(message);
      if (jobKind) localJob.fail(requestId, message);
    } finally {
      setBusy("");
      release();
    }
  }, [captureSession, localJob]);

  const refreshLicense = useCallback(async () => {
    if (!licenseApi) {
      setLicenseLoaded(true);
      return;
    }
    const [nextLicenseStatus, nextPortalInfo] = await Promise.all([
      licenseApi.status(),
      licenseApi.portalInfo(),
    ]);
    setLicenseStatus(asObject(nextLicenseStatus));
    setLicensePortalInfo(asObject(nextPortalInfo));
    setLicenseLoaded(true);
  }, [licenseApi]);

  const loadSelectedRecording = useCallback(
    async (recordingId: string, preserveAi = false) => {
      requestCoordinator.current.invalidate("transcript-page");
      requestCoordinator.current.invalidate("privacy-receipt");
      if (!api || !client || !recordingId) {
        setTranscript([]);
        setTranscriptTotalCount(0);
        setTranscriptHasMore(false);
        setReplay({});
        setNotesMarkdown("");
        setNotesStatus({});
        setNotesDirty(false);
        setMarkedMoments([]);
        setPrivacyReceipt(null);
        setRecap(null);
        setAskAnswer(null);
        return;
      }
      const token = requestCoordinator.current.begin("selected-recording");
      const [nextTranscript, replayObject, notesObject, nextReceipt] = await Promise.all([
        client.transcriptPage(recordingId, 0, TRANSCRIPT_PAGE_SIZE),
        client.object("recording.durable.replayManifest", () => api.recordingDurableReplayManifest(recordingId)),
        client.object("recording.notes.read", () => api.recordingNotesRead(recordingId)),
        client.privacyReceipt(recordingId),
      ]);
      if (!requestCoordinator.current.isCurrent(token)) return;
      setTranscript(nextTranscript.segments);
      setTranscriptTotalCount(nextTranscript.segmentCount);
      setTranscriptHasMore(nextTranscript.hasMore);
      setReplay(replayObject);
      const nextMarkdown = asString(notesObject.markdown);
      setNotesMarkdown(nextMarkdown);
      setNotesStatus(notesObject);
      setNotesDirty(false);
      setMarkedMoments(parseMarkedMoments(nextMarkdown));
      setPrivacyReceipt(nextReceipt);
      if (!preserveAi) {
        setRecap(null);
        setAskAnswer(null);
      }
      const nextTracks = asArray(replayObject.tracks).map((track) => asString(track)).filter(Boolean);
      setSelectedTrack((current) => nextTracks.length > 0 && !nextTracks.includes(current) ? nextTracks[0] : current);
    },
    [api, client],
  );

  const refreshLibrary = useCallback(async (offset = 0) => {
    if (!client) return [] as RecordingSummary[];
    const token = requestCoordinator.current.begin("library-page");
    const page = await client.recordingPage(offset, LIBRARY_PAGE_SIZE);
    if (!requestCoordinator.current.isCurrent(token)) return [] as RecordingSummary[];
    setRecordings((current) => offset === 0
      ? page.recordings
      : [...current, ...page.recordings.filter((item) => !current.some((existing) => existing.recordingId === item.recordingId))]);
    setRecordingTotalCount(page.totalCount);
    setRecordingsHaveMore(page.hasMore);
    return page.recordings;
  }, [client]);

  const refreshPrivacyReceipt = useCallback(async (recordingId = selectedRecordingId) => {
    if (!client || !recordingId) {
      setPrivacyReceipt(null);
      return;
    }
    const token = requestCoordinator.current.begin("privacy-receipt");
    const nextReceipt = await client.privacyReceipt(recordingId);
    if (requestCoordinator.current.isCurrent(token)) setPrivacyReceipt(nextReceipt);
  }, [client, selectedRecordingId]);

  const refresh = useCallback(async () => {
    if (!api || !client) {
      setError("Candor preload API is unavailable");
      return;
    }
    const [, nextLibraryPage] = await Promise.all([
      loadCritical(),
      client.recordingPage(0, LIBRARY_PAGE_SIZE),
    ]);
    const nextRecordings = nextLibraryPage.recordings;
    setRecordings(nextRecordings);
    setRecordingTotalCount(nextLibraryPage.totalCount);
    setRecordingsHaveMore(nextLibraryPage.hasMore);
    const nextSelected =
      selectedRecordingId && nextRecordings.some((item) => item.recordingId === selectedRecordingId)
        ? selectedRecordingId
        : nextRecordings[0]?.recordingId ?? "";
    setSelectedRecordingId(nextSelected);
    if (nextSelected) await loadSelectedRecording(nextSelected);
    void loadDiagnostics();
  }, [api, client, loadCritical, loadDiagnostics, loadSelectedRecording, selectedRecordingId]);

  useEffect(() => {
    if (startupLoaded.current) return;
    startupLoaded.current = true;
    void refresh().catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [refresh]);

  useEffect(() => {
    void refreshLicense().catch((reason) => {
      setLicenseLoaded(true);
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  }, [refreshLicense]);

  useEffect(() => {
    if (!licenseLoaded) return;
    if (!licenseApi) {
      setOnboardingStep("app");
      return;
    }
    const currentState = asString(licenseStatus.state, "inactive");
    if (currentState === "inactive") {
      setOnboardingStep("activate");
    } else if (onboardingStep === "activate") {
      setOnboardingStep("app");
    }
  }, [licenseApi, licenseLoaded, licenseStatus, onboardingStep]);

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

  useEffect(() => {
    setReviewSummaryDraft(recap?.summary ?? "");
  }, [recap]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(""), 5000);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
  }, [audioUrl]);

  async function startRecording() {
    if (!api) return;
    captureSession.requestPermission();
    if (!asBool(consentStatus.readyForMicRecording)) {
      setError("Acknowledge local storage and microphone recording consent before recording.");
      captureSession.failed("Microphone consent is required.");
      setSettingsSection("recording");
      setView("settings");
      return;
    }
    captureSession.permissionGranted();
    await run("record", async () => {
      const result = await api.captureStartMic({ label: recordingTitle.trim() || "Untitled local meeting", chunkMs: 500 });
      const recordingId = asString(asObject(asObject(result).capture).recordingId, "started");
      captureSession.started(recordingId);
      setNotice(`Recording ${recordingId}`);
      setView("meeting");
      await Promise.all([refreshCapture(), refreshLibrary(0)]);
    }, "capture");
  }

  async function startSystemRecording() {
    if (!api) return;
    captureSession.requestPermission();
    if (!asBool(asObject(asObject(captureStatus.sources).system).implemented)) {
      setError("System audio capture is not implemented on this OS yet.");
      captureSession.failed("System audio is unavailable on this OS.");
      return;
    }
    if (!asBool(consentStatus.readyForSystemAudioRecording)) {
      setError("Acknowledge local storage and system audio consent before recording system audio.");
      captureSession.failed("System audio consent is required.");
      setSettingsSection("recording");
      setView("settings");
      return;
    }
    captureSession.permissionGranted();
    await run("record", async () => {
      const result = await api.captureStartSystem({ label: recordingTitle.trim() || "Untitled local system audio", chunkMs: 500 });
      const recordingId = asString(asObject(asObject(result).capture).recordingId, "started");
      captureSession.started(recordingId);
      setNotice("System audio recording started locally");
      setView("meeting");
      await Promise.all([refreshCapture(), refreshLibrary(0)]);
    }, "capture");
  }

  async function startMicAndSystemRecording() {
    if (!api) return;
    captureSession.requestPermission();
    if (!combinedCaptureAvailable) {
      setError("Combined mic and system capture is not implemented on this OS yet.");
      captureSession.failed("Combined capture is unavailable on this OS.");
      return;
    }
    if (!asBool(consentStatus.readyForMicAndSystemAudioRecording)) {
      setError("Acknowledge local storage, microphone, and system audio consent before combined recording.");
      captureSession.failed("Microphone and system audio consent are required.");
      setSettingsSection("recording");
      setView("settings");
      return;
    }
    captureSession.permissionGranted();
    await run("record", async () => {
      const result = await api.captureStartMicAndSystem({ label: recordingTitle.trim() || "Untitled local meeting", chunkMs: 500 });
      const recordingId = asString(asObject(asObject(result).capture).recordingId, "started");
      captureSession.started(recordingId);
      setNotice("Microphone and system audio recording started locally");
      setView("meeting");
      await Promise.all([refreshCapture(), refreshLibrary(0)]);
    }, "capture");
  }

  async function startPreferredRecording() {
    if (activeCapture) {
      await stopRecording();
    } else if (combinedCaptureAvailable && asBool(consentStatus.readyForMicAndSystemAudioRecording)) {
      await startMicAndSystemRecording();
    } else {
      await startRecording();
    }
  }

  async function stopRecording() {
    if (!api) return;
    captureSession.stopRequested();
    await run("stop", async () => {
      captureSession.finalizing();
      const result = await api.captureStop();
      const recordingId = asString(asObject(asObject(result).capture).recordingId);
      setNotice("Recording saved locally");
      await Promise.all([refreshCapture(), refreshLibrary(0)]);
      if (recordingId) {
        captureSession.saved(recordingId);
        setSelectedRecordingId(recordingId);
        setOpenMeetingIds((current) => [recordingId, ...current.filter((id) => id !== recordingId)].slice(0, 3));
        await loadSelectedRecording(recordingId);
      }
    }, "capture");
  }

  async function importModel() {
    if (!api) return;
    await run("import", async () => {
      const result = await api.modelsImportFromFile({ modelId: selectedModel, replace: true });
      const object = asObject(result);
      setNotice(asBool(object.canceled) ? "Import canceled" : asBool(object.imported) ? `${selectedModel} verified and installed` : "Model import finished");
      await refreshModelsAndAi();
    }, "local-model", "model-import");
  }

  async function importInstructAsset() {
    if (!api) return;
    const expectedSha256 = instructExpectedSha256.trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
      setInstructAssetError("Enter exactly 64 hexadecimal characters.");
      return;
    }
    const release = exclusiveActions.current.acquire("local-model");
    if (!release) {
      setNotice("A local model import is already in progress");
      return;
    }
    const requestId = localJob.begin("model-import");
    setBusy("instruct-asset");
    setError("");
    setNotice("");
    setInstructAssetError("");
    try {
      const result = await api.aiInstructAssetImportFromFile({ assetKind: instructAssetKind, expectedSha256, replace: true });
      const object = asObject(result);
      if (asBool(object.canceled)) {
        localJob.cancel(requestId);
        localJob.reset();
        setNotice("Local AI import canceled");
        return;
      }
      if (!asBool(object.imported) || !asBool(object.integrityVerified)) {
        throw new Error("Local AI asset was not verified.");
      }
      setInstructExpectedSha256("");
      setNotice(`${instructAssetKind === "runner" ? "Processing engine" : "Language model"} verified and stored locally`);
      await refreshModelsAndAi();
      localJob.complete(requestId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setInstructAssetError(message);
      setError(message);
      localJob.fail(requestId, message);
    } finally {
      setBusy("");
      release();
    }
  }

  async function importV2Folder() {
    if (!api) return;
    await run("import", async () => {
      const result = await api.v2ImportFromFolder();
      const object = asObject(result);
      if (asBool(object.canceled)) {
        setNotice("Import canceled");
        return;
      }
      setNotice(`Imported ${asNumber(object.importedCount)} v2 meetings, ${asNumber(object.audioImportedCount)} with audio`);
      await refreshLibrary(0);
      setView("library");
    }, "v2-import");
  }

  async function verifyModel() {
    if (!api) return;
    await run("verify", async () => {
      const result = await api.modelsVerifyLocal({ modelId: selectedModel });
      const object = asObject(result);
      setNotice(asBool(object.verified) ? `${selectedModel} verified` : `${selectedModel}: ${asString(object.failureCode, "not ready")}`);
      await refreshModelsAndAi();
    }, "local-model");
  }

  async function transcribeRecording() {
    if (!api || !selectedRecordingId) return;
    await run("transcribe", async () => {
      await api.transcriptionRunLocal({ recordingId: selectedRecordingId, channel: selectedTrack || undefined, modelId: selectedModel, language: "en" });
      setNotice("Transcription updated");
      await Promise.all([
        loadSelectedRecording(selectedRecordingId, true),
        refreshLibrary(0),
        refreshModelsAndAi(),
      ]);
    }, "local-model", "transcription");
  }

  async function searchRecordings() {
    if (!api || !searchQuery.trim()) return;
    await run("search", async () => {
      const result = await api.recordingDurableSearch(searchQuery.trim());
      setSearchMatches(asArray(asObject(result).matches));
    });
  }

  async function loadMoreRecordings() {
    await run("load meetings", async () => {
      await refreshLibrary(recordings.length);
    }, "library-page");
  }

  async function loadMoreTranscript() {
    if (!client || !selectedRecordingId || !transcriptHasMore) return;
    await run("load transcript", async () => {
      const token = requestCoordinator.current.begin("transcript-page");
      const page = await client.transcriptPage(selectedRecordingId, transcript.length, TRANSCRIPT_PAGE_SIZE);
      if (!requestCoordinator.current.isCurrent(token)) return;
      setTranscript((current) => [
        ...current,
        ...page.segments.filter((segment) => !current.some((existing) => existing.index === segment.index)),
      ]);
      setTranscriptTotalCount(page.segmentCount);
      setTranscriptHasMore(page.hasMore);
    }, "transcript-page");
  }

  function reviewedItems(items: RecapItem[]): RecapItem[] {
    return items.filter((item) => reviewStates[recapItemKey(item)] !== "rejected");
  }

  function buildLocalExportParams(format: ExportFormat) {
    return {
      recordingId: selectedRecordingId,
      format,
      report: {
        summary: reviewSummaryDraft || recap?.summary || "",
        decisions: reviewedItems(recap?.decisions ?? []).map(exportReportItem),
        actions: reviewedItems(recap?.actions ?? []).map(exportReportItem),
        risks: reviewedItems(recap?.risks ?? []).map(exportReportItem),
        questions: reviewedItems(recap?.questions ?? []).map(exportReportItem),
      },
      options: {
        includeSummary: exportSections.summary,
        includeDecisions: exportSections.decisions,
        includeActions: exportSections.actions,
        includeRisks: exportSections.risks,
        includeQuestions: exportSections.questions,
        includeNotes: exportSections.notes,
        includeTranscript: exportSections.transcript,
        includeTimestamps: exportSections.timestamps,
        paperSize: exportPaperSize,
      },
    };
  }

  async function saveLocalReport() {
    if (!api || !selectedRecordingId) return;
    await run("export", async () => {
      if (notesDirty) {
        const notesResult = await api.recordingNotesSave(selectedRecordingId, notesMarkdown);
        setNotesStatus(asObject(notesResult));
        setNotesDirty(false);
      }
      const result = await api.exportSaveLocal(buildLocalExportParams(exportFormat));
      const object = asObject(result);
      if (asBool(object.canceled)) {
        setNotice("Export canceled. No file was written.");
        return;
      }
      if (!asBool(object.saved) || !asBool(object.savedLocally)) {
        throw new Error("The local report was not saved.");
      }
      setMarkdownExport(exportFormat === "markdown" ? asString(object.markdown) : "");
      setNotice(`Saved ${asString(object.fileName, exportFormatLabel(exportFormat))} locally`);
      await refreshPrivacyReceipt();
    }, "document-write", "export");
  }

  async function saveMeetingNotes() {
    if (!api || !selectedRecordingId) return;
    await run("notes", async () => {
      const result = await api.recordingNotesSave(selectedRecordingId, notesMarkdown);
      setNotesStatus(asObject(result));
      setNotesDirty(false);
      setNotice("Meeting notes saved locally");
      await Promise.all([refreshLibrary(0), refreshPrivacyReceipt()]);
    }, "document-write", "notes-save");
  }

  function markMoment(timeMs: number) {
    if (!selectedRecordingId) {
      setError("Select or start a local meeting before marking a moment.");
      return;
    }
    const roundedMs = Math.max(0, Math.floor(timeMs / 1000) * 1000);
    const marker: MarkedMoment = {
      id: `note-${roundedMs}-${Date.now()}`,
      timeMs: roundedMs,
      label: "Moment marked",
    };
    setMarkedMoments((current) => [...current, marker]);
    setNotesMarkdown((current) => {
      const prefix = current.trimEnd();
      const line = `- [${formatDuration(roundedMs)}] Moment marked`;
      return prefix ? `${prefix}\n${line}` : line;
    });
    setNotesDirty(true);
    setError("");
    setNotice(`Moment linked to notes at ${formatDuration(roundedMs)}`);
  }

  async function generateRecap() {
    if (!api || !selectedRecordingId) return;
    await run("recap", async () => {
      const nextRecap = client
        ? await client.recap(() => useInstructModel
          ? api.aiRecapInstruct(selectedRecordingId, 512)
          : api.aiRecapHeuristic(selectedRecordingId))
        : parseRecap(useInstructModel
          ? await api.aiRecapInstruct(selectedRecordingId, 512)
          : await api.aiRecapHeuristic(selectedRecordingId));
      setRecap(nextRecap);
      setNotice(useInstructModel ? "Local model recap generated" : aiMode === "quality" ? "Fast local recap generated because the model is unavailable" : "Fast local recap generated");
      await refreshPrivacyReceipt();
    }, "local-model", "recap");
  }

  async function askSelectedRecording() {
    if (!api || !selectedRecordingId) return;
    const question = askQuestion.trim();
    if (!question) {
      setError("Ask needs a question.");
      return;
    }
    await run("ask", async () => {
      const nextAnswer = client
        ? await client.answer(() => useInstructModel
          ? api.aiAskInstruct(selectedRecordingId, question, 256)
          : api.aiAskHeuristic(selectedRecordingId, question))
        : parseAnswer(useInstructModel
          ? await api.aiAskInstruct(selectedRecordingId, question, 256)
          : await api.aiAskHeuristic(selectedRecordingId, question));
      setAskAnswer(nextAnswer);
      setNotice(useInstructModel ? "Local model answer generated" : "Fast local answer generated");
      await refreshPrivacyReceipt();
    }, "local-model", "ask");
  }

  async function loadAudio() {
    if (!api || !selectedRecordingId) return;
    await run("audio", async () => {
      const result = await api.exportCreate({ recordingId: selectedRecordingId, format: "wav", channel: selectedTrack || undefined });
      const data = asString(asObject(result).dataBase64);
      if (!data) throw new Error("No WAV payload returned");
      const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
      const blob = new Blob([bytes], { type: "audio/wav" });
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      setAudioUrl(URL.createObjectURL(blob));
      setNotice("Audio ready");
      await refreshPrivacyReceipt();
    });
  }

  async function activateLicense() {
    if (!licenseApi) return;
    setLicenseKeyTouched(true);
    if (!licenseKey.trim()) {
      setError("Enter a license key or start a local trial.");
      return;
    }
    await run("license", async () => {
      const status = await licenseApi.activate({
        licenseKey: licenseKey.trim(),
        purchaserEmail: licenseEmail.trim() || undefined,
      });
      setLicenseStatus(asObject(status));
      await refreshLicense();
      setOnboardingStep("yours");
      setNotice("Candor activated locally");
    });
  }

  async function startTrial() {
    if (!licenseApi) return;
    await run("license", async () => {
      const status = await licenseApi.startTrial();
      setLicenseStatus(asObject(status));
      await refreshLicense();
      setOnboardingStep("yours");
      setNotice("Local trial started");
    });
  }

  async function deactivateLicense() {
    if (!licenseApi) return;
    await run("license", async () => {
      const status = await licenseApi.deactivateDevice();
      setLicenseStatus(asObject(status));
      await refreshLicense();
      setOnboardingStep("activate");
      setView("home");
      setNotice("Local activation removed from this device");
    });
  }

  async function completeMicOnboarding() {
    if (!api) return;
    if (asBool(consentStatus.readyForMicRecording)) {
      setOnboardingStep("system-audio");
      return;
    }
    await run("consent", async () => {
      const result = await api.consentAcknowledge({ items: ["localOnlyStorage", "micRecording"] });
      setConsentStatus(asObject(result));
      await refreshCapture();
      setOnboardingStep("system-audio");
      setNotice("Microphone recording consent saved locally");
    });
  }

  async function completeSystemAudioOnboarding() {
    if (!api) return;
    const systemImplemented = asBool(asObject(asObject(captureStatus.sources).system).implemented);
    if (!systemImplemented || asBool(consentStatus.readyForSystemAudioRecording)) {
      setOnboardingStep("storage");
      return;
    }
    const required = asArray(consentStatus.requiredForSystemAudio).map((item) => asString(item)).filter(Boolean);
    await run("consent", async () => {
      const result = await api.consentAcknowledge({ items: required.length ? required : ["localOnlyStorage", "systemAudioRecording"] });
      setConsentStatus(asObject(result));
      await refreshCapture();
      setOnboardingStep("storage");
      setNotice("System audio consent saved locally");
    });
  }

  async function completeStorageOnboarding() {
    if (!api) return;
    await run("storage", async () => {
      if (asBool(vaultStatus.localOpenAvailable)) {
        await api.vaultOpenLocal();
      }
      await refreshVaultAndRetention();
      setOnboardingStep("local-ai");
      setNotice("Local storage is ready");
    });
  }

  function finishOnboarding() {
    setOnboardingStep("app");
    setView("home");
    setNotice("Candor is ready");
  }

  async function acknowledgeMicConsent() {
    if (!api) return;
    await run("consent", async () => {
      const result = await api.consentAcknowledge({ items: ["localOnlyStorage", "micRecording"] });
      setConsentStatus(asObject(result));
      setNotice("Microphone recording consent saved locally");
      await refreshCapture();
    });
  }

  async function acknowledgeSystemConsent() {
    if (!api) return;
    const required = asArray(consentStatus.requiredForSystemAudio).map((item) => asString(item)).filter(Boolean);
    await run("consent", async () => {
      const result = await api.consentAcknowledge({ items: required.length ? required : ["localOnlyStorage", "systemAudioRecording"] });
      setConsentStatus(asObject(result));
      setNotice("System audio consent saved locally");
      await refreshCapture();
    });
  }

  async function refreshLocalSettings() {
    await run("refresh settings", async () => {
      await Promise.all([
        refreshCapture(),
        refreshModelsAndAi(),
        refreshPrivacyFacts(),
        refreshVaultAndRetention(),
      ]);
      setNotice("Local settings refreshed");
    }, "settings-refresh");
  }

  function toggleAdvancedSettings() {
    setAdvancedSettingsOpen((current) => {
      if (!current) void refreshPrivacyFacts().catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
      return !current;
    });
  }

  async function openRecording(recordingId: string, target: AppView = "meeting") {
    setSelectedRecordingId(recordingId);
    setOpenMeetingIds((current) => [recordingId, ...current.filter((id) => id !== recordingId)].slice(0, 3));
    await loadSelectedRecording(recordingId);
    setView(target);
  }

  function closeMeetingTab(recordingId: string) {
    const remaining = openMeetingIds.filter((id) => id !== recordingId);
    setOpenMeetingIds(remaining);
    if (selectedRecordingId === recordingId) {
      const next = remaining[0] ?? "";
      setSelectedRecordingId(next);
      if (next) void loadSelectedRecording(next);
    }
  }

  const aiModeStatus = aiMode === "fast" ? "Heuristic local" : instructReady ? "Hash-verified local model" : "Fast fallback, model unavailable";
  const captureStatusLabel = captureMachine.phase === "idle"
    ? "Ready"
    : captureMachine.phase === "recording"
      ? "Recording"
      : captureMachine.phase === "requesting-permission"
        ? "Checking permission"
        : captureMachine.phase[0].toUpperCase() + captureMachine.phase.slice(1).replace("-", " ");
  const jobStatusLabel = jobMachine.phase === "running" && jobMachine.kind
    ? `${jobMachine.kind.replace("-", " ")} running locally`
    : jobMachine.phase === "failed"
      ? "Local job needs attention"
      : "Processing stays local";
  const custodyItems: Array<[string, string]> = [
    ["Network", metric(coreStatus.networkPolicy, "disabled-by-default")],
    ["Updates", asBool(updateStatus.backgroundChecks) ? "background" : metric(updateStatus.policy, "manual-check-only")],
    ["Vault", metric(vaultStatus.backend, "sqlcipher")],
    ["Consent", asBool(consentStatus.readyForMicAndSystemAudioRecording) ? "all ready" : asBool(consentStatus.readyForMicRecording) ? "mic ready" : "required"],
    ["Notes", notesDirty ? "unsaved" : asBool(notesStatus.savedLocally) ? "saved" : "empty"],
    ["Retention", metric(retentionStatus.policy, "manual-delete-only")],
    ["External calls", metric(privacyAudit.externalCallsAttempted, "0")],
    ["Transport", metric(coreStatus.sidecarTransport, "stdio-json-lines")],
    ["Local AI", instructReady ? "model ready" : asBool(aiStatus.heuristicRecapImplemented) ? "fast fallback" : "pending"],
    ["V2 import", asBool(v2ImportStatus.implemented) ? "native picker" : "pending"],
    ["Scheduler", asBool(schedulerStatus.whisperLlmConcurrent) ? "unsafe" : "single job"],
    ["Model import", metric(modelStatus.manualImportMethod, "native picker")],
    ["Diagnostics", diagnosticFailures.length ? `${diagnosticFailures.length} unavailable` : "ready"],
  ];

  const filteredRecordings = recordings.filter((recording) => {
    if (libraryFilter === "transcribed") return recording.transcriptSegmentCount > 0;
    if (libraryFilter === "audio") return recording.audioChunkCount > 0;
    return true;
  });

  const recapSuggestions = recap ? [...recap.decisions, ...recap.actions, ...recap.risks, ...recap.questions] : [];
  const timelineDurationMs = Math.max(
    asNumber(replay.durationMs),
    selectedRecording?.audioDurationMs ?? 0,
    asNumber(asObject(captureStatus.activeSession).durationMs),
    transcript.length ? transcript[transcript.length - 1].endMs : 0,
  );
  const evidenceMarkers = useMemo<EvidenceMarker[]>(() => {
    const transcriptMarkers = transcript.slice(0, 24).map((segment) => ({
      id: `transcript-${segment.index}-${segment.startMs}`,
      timeMs: segment.startMs,
      label: `${segment.speaker}: ${segment.text.slice(0, 64)}`,
      kind: "transcript" as const,
    }));
    const noteMarkers = markedMoments.map((moment) => ({
      id: moment.id,
      timeMs: moment.timeMs,
      label: moment.label,
      kind: "note" as const,
    }));
    const decisionMarkers = (recap?.decisions ?? []).map((item) => ({
      id: `decision-${item.segmentIndex}-${item.startMs}`,
      timeMs: item.startMs,
      label: item.text,
      kind: "decision" as const,
    }));
    const actionMarkers = (recap?.actions ?? []).map((item) => ({
      id: `action-${item.segmentIndex}-${item.startMs}`,
      timeMs: item.startMs,
      label: item.text,
      kind: "action" as const,
    }));
    return [...transcriptMarkers, ...noteMarkers, ...decisionMarkers, ...actionMarkers];
  }, [markedMoments, recap, transcript]);

  function renderTranscriptList() {
    return (
      <div className="transcript-page-wrap">
        <AnimatedTranscript
          emptyMessage="No transcript yet. Record or transcribe this meeting locally to begin."
          segments={transcript.map((segment) => ({
            id: `${segment.index}-${segment.startMs}`,
            speaker: segment.speaker,
            startMs: segment.startMs,
            channel: segment.channel,
            text: segment.text,
          }))}
        />
        {transcriptHasMore ? <button type="button" className="load-more-button" onClick={() => void loadMoreTranscript()} disabled={Boolean(busy)}>Load more transcript</button> : null}
        {transcriptTotalCount > 0 ? <span className="page-count">Showing {transcript.length} of {transcriptTotalCount} segments</span> : null}
      </div>
    );
  }

  function renderActivationGate() {
    return (
      <ActivationGate
        licenseKey={licenseKey}
        licenseEmail={licenseEmail}
        licenseKeyInvalid={licenseKeyInvalid}
        licenseBusy={busy === "license"}
        licenseStatus={licenseStatus}
        onLicenseKeyChange={(value) => { setLicenseKey(value); setLicenseKeyTouched(false); }}
        onLicenseEmailChange={setLicenseEmail}
        onLicenseKeyBlur={() => setLicenseKeyTouched(true)}
        onActivate={() => void activateLicense()}
        onStartTrial={() => void startTrial()}
      />
    );
  }

  function renderOnboardingSetup() {
    return (
      <OnboardingSetup
        step={onboardingStep}
        licenseState={licenseState}
        licenseStatus={licenseStatus}
        captureStatus={captureStatus}
        consentStatus={consentStatus}
        vaultStatus={vaultStatus}
        modelStatus={modelStatus}
        aiModeStatus={aiModeStatus}
        instructAssetsReady={instructAssetsReady}
        busy={busy}
        onStepChange={setOnboardingStep}
        onCompleteMic={() => void completeMicOnboarding()}
        onCompleteSystemAudio={() => void completeSystemAudioOnboarding()}
        onCompleteStorage={() => void completeStorageOnboarding()}
        onImportSpeechModel={() => void importModel()}
        onFinish={finishOnboarding}
      />
    );
  }

  function renderHome() {
    return (
      <HomeView
        recordings={recordings}
        activeCapture={activeCapture}
        combinedCaptureAvailable={combinedCaptureAvailable}
        busy={Boolean(busy)}
        importAvailable={asBool(v2ImportStatus.implemented)}
        recordingTitle={recordingTitle}
        vaultBackend={vaultStatus.backend}
        instructReady={instructReady}
        verifiedModelCount={modelStatus.verifiedModelCount}
        aiModeStatus={aiModeStatus}
        onStartRecording={() => void startPreferredRecording()}
        onOpenLibrary={() => setView("library")}
        onImport={() => void importV2Folder()}
        onRecordingTitleChange={setRecordingTitle}
        onOpenRecording={(recordingId) => void openRecording(recordingId, "detail")}
      />
    );
  }

  function renderMeeting() {
    return (
      <LiveMeetingView
        title={selectedTitle}
        selectedRecording={selectedRecording}
        selectedRecordingId={selectedRecordingId}
        activeRecordingId={activeRecordingId}
        activeCapture={activeCapture}
        consentReady={asBool(consentStatus.readyForMicRecording)}
        durationMs={timelineDurationMs}
        audioUrl={audioUrl}
        markers={evidenceMarkers}
        compactPane={compactMeetingPane}
        notesPanelMode={notesPanelMode}
        notesMarkdown={notesMarkdown}
        notesDirty={notesDirty}
        notesSaved={asBool(notesStatus.savedLocally)}
        recapSuggestions={recapSuggestions}
        aiMode={aiMode}
        aiModeStatus={aiModeStatus}
        captureStatusLabel={captureStatusLabel}
        jobStatusLabel={jobStatusLabel}
        busy={Boolean(busy)}
        transcriptContent={renderTranscriptList()}
        onReview={() => setView("review")}
        onReviewConsent={() => { setSettingsSection("recording"); setView("settings"); }}
        onLoadAudio={() => void loadAudio()}
        onMarkMoment={markMoment}
        onCompactPaneChange={setCompactMeetingPane}
        onNotesPanelModeChange={setNotesPanelMode}
        onTranscribe={() => void transcribeRecording()}
        onNotesChange={(value) => { setNotesMarkdown(value); setNotesDirty(true); }}
        onSaveNotes={() => void saveMeetingNotes()}
        onGenerateRecap={() => void generateRecap()}
        onAiModeChange={setAiMode}
        onStartStop={() => void startPreferredRecording()}
      />
    );
  }

  function renderLibrary() {
    return (
      <LibraryView
        recordings={recordings}
        filteredRecordings={filteredRecordings}
        recordingTotalCount={recordingTotalCount}
        recordingsHaveMore={recordingsHaveMore}
        searchQuery={searchQuery}
        searchMatches={searchMatches}
        libraryFilter={libraryFilter}
        busy={Boolean(busy)}
        onSearchQueryChange={setSearchQuery}
        onSearch={() => void searchRecordings()}
        onFilterChange={setLibraryFilter}
        onOpenRecording={(recordingId) => void openRecording(recordingId, "detail")}
        onStartRecording={() => void startPreferredRecording()}
        onLoadMore={() => void loadMoreRecordings()}
      />
    );
  }

  function renderDetail() {
    return (
      <MeetingDetailView
        title={selectedTitle}
        selectedRecording={selectedRecording}
        selectedRecordingId={selectedRecordingId}
        detailSection={detailSection}
        transcriptContent={renderTranscriptList()}
        transcriptTotalCount={transcriptTotalCount}
        notesMarkdown={notesMarkdown}
        notesDirty={notesDirty}
        recap={recap}
        tracks={tracks}
        selectedTrack={selectedTrack}
        audioUrl={audioUrl}
        askQuestion={askQuestion}
        askAnswer={askAnswer}
        aiModeStatus={aiModeStatus}
        privacyReceipt={privacyReceipt}
        networkCapabilities={networkCapabilities}
        busy={Boolean(busy)}
        onDetailSectionChange={setDetailSection}
        onReview={() => setView("review")}
        onNotesChange={(value) => { setNotesMarkdown(value); setNotesDirty(true); }}
        onSaveNotes={() => void saveMeetingNotes()}
        onGenerateRecap={() => void generateRecap()}
        onTrackChange={setSelectedTrack}
        onLoadAudio={() => void loadAudio()}
        onAskQuestionChange={setAskQuestion}
        onAsk={() => void askSelectedRecording()}
      />
    );
  }

  function renderReview() {
    const previewDecisions = exportSections.decisions ? reviewedItems(recap?.decisions ?? []) : [];
    const previewActions = exportSections.actions ? reviewedItems(recap?.actions ?? []) : [];
    const previewRisks = exportSections.risks ? reviewedItems(recap?.risks ?? []) : [];
    const previewQuestions = exportSections.questions ? reviewedItems(recap?.questions ?? []) : [];
    return (
      <ReviewView
        title={selectedTitle}
        reviewSection={reviewSection}
        reviewStates={reviewStates}
        summaryDraft={reviewSummaryDraft}
        recap={recap}
        notesMarkdown={notesMarkdown}
        notesDirty={notesDirty}
        transcriptContent={renderTranscriptList()}
        exportFormat={exportFormat}
        includeSummary={exportSections.summary}
        includeNotes={exportSections.notes}
        includeTranscript={exportSections.transcript}
        previewDecisions={previewDecisions}
        previewActions={previewActions}
        previewRisks={previewRisks}
        previewQuestions={previewQuestions}
        selectedRecordingId={selectedRecordingId}
        busy={Boolean(busy)}
        onSectionChange={setReviewSection}
        onSummaryDraftChange={setReviewSummaryDraft}
        onNotesChange={(value) => { setNotesMarkdown(value); setNotesDirty(true); }}
        onSaveNotes={() => void saveMeetingNotes()}
        onGenerateRecap={() => void generateRecap()}
        onReviewItem={(key, state) => setReviewStates((current) => ({ ...current, [key]: state }))}
        onOpenExport={() => setView("export")}
      />
    );
  }

  function renderSettings() {
    return (
      <SettingsView
        section={settingsSection}
        advancedOpen={advancedSettingsOpen}
        busy={busy}
        activeCapture={activeCapture}
        combinedCaptureAvailable={combinedCaptureAvailable}
        statuses={{
          core: coreStatus,
          consent: consentStatus,
          capture: captureStatus,
          vault: vaultStatus,
          updates: updateStatus,
          retention: retentionStatus,
          transcription: transcriptionStatus,
        }}
        models={models}
        selectedModel={selectedModel}
        defaultModel={DEFAULT_MODEL}
        aiMode={aiMode}
        aiModeStatus={aiModeStatus}
        instructSetupOpen={instructSetupOpen}
        instructAssetsReady={instructAssetsReady}
        instructRunnerAsset={instructRunnerAsset}
        instructModelAsset={instructModelAsset}
        instructAssetKind={instructAssetKind}
        instructExpectedSha256={instructExpectedSha256}
        instructAssetError={instructAssetError}
        licenseStatus={licenseStatus}
        licensePortalInfo={licensePortalInfo}
        licenseActive={licenseActive}
        privacyReceipt={privacyReceipt}
        networkCapabilities={networkCapabilities}
        custodyItems={custodyItems}
        onSectionChange={setSettingsSection}
        onToggleAdvanced={toggleAdvancedSettings}
        onVerifyModel={() => void verifyModel()}
        onImportModel={() => void importModel()}
        onSelectedModelChange={setSelectedModel}
        onAiModeChange={setAiMode}
        onInstructSetupOpenChange={setInstructSetupOpen}
        onInstructAssetKindChange={(kind) => { setInstructAssetKind(kind); setInstructAssetError(""); }}
        onInstructExpectedShaChange={(value) => { setInstructExpectedSha256(value); setInstructAssetError(""); }}
        onImportInstructAsset={() => void importInstructAsset()}
        onRefreshLicense={() => void refreshLicense()}
        onDeactivateLicense={() => void deactivateLicense()}
        onAcknowledgeMic={() => void acknowledgeMicConsent()}
        onAcknowledgeSystem={() => void acknowledgeSystemConsent()}
        onRecordSystem={() => void startSystemRecording()}
        onRecordBoth={() => void startMicAndSystemRecording()}
        onOpenDiagnostics={() => setView("proof")}
        onOpenExport={() => setView("export")}
        onRefreshLocalSettings={() => void refreshLocalSettings()}
      />
    );
  }

  function toggleExportSection(key: keyof typeof exportSections) {
    setExportSections((current) => ({ ...current, [key]: !current[key] }));
  }

  function renderExport() {
    const previewDecisions = exportSections.decisions ? reviewedItems(recap?.decisions ?? []) : [];
    const previewActions = exportSections.actions ? reviewedItems(recap?.actions ?? []) : [];
    const previewRisks = exportSections.risks ? reviewedItems(recap?.risks ?? []) : [];
    const previewQuestions = exportSections.questions ? reviewedItems(recap?.questions ?? []) : [];
    return <ExportView title={selectedTitle} summary={reviewSummaryDraft || recap?.summary || ""} format={exportFormat} paperSize={exportPaperSize} sections={exportSections} decisions={previewDecisions} actions={previewActions} risks={previewRisks} questions={previewQuestions} markdownExport={markdownExport} canExport={Boolean(selectedRecordingId)} saving={busy === "export"} onFormatChange={setExportFormat} onPaperSizeChange={setExportPaperSize} onToggleSection={toggleExportSection} onBack={() => setView("review")} onSave={() => void saveLocalReport()} />;
  }

  function renderProof() {
    return <section className="page-view" data-view="proof" aria-label="Local custody"><header className="screen-heading"><div><h1>Local Custody</h1><p>Queryable facts from the Candor core</p></div><button type="button" className="secondary-button" onClick={() => { setSettingsSection("privacy"); setView("settings"); }}>Back to settings</button></header><PrivacyReceipt receipt={privacyReceipt} network={networkCapabilities} /><div className="proof-grid"><section><h2>Custody facts</h2><dl className="settings-facts privacy-facts">{custodyItems.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></section><section><h2>Boundary</h2><dl className="settings-facts"><div><dt>Allowed commands</dt><dd>{asArray(capabilities.allowedMethods).length}</dd></div><div><dt>Blocked capabilities</dt><dd>{asArray(capabilities.deniedCapabilities).length}</dd></div><div><dt>External attempts</dt><dd>{metric(privacyAudit.externalCallsAttempted, "0")}</dd></div><div><dt>Background downloads</dt><dd>{asBool(instructAssetsStatus.backgroundDownloads) ? "On" : "Off"}</dd></div><div><dt>Managed paths exposed</dt><dd>{asBool(instructAssetsStatus.managedPathExposed) ? "Yes" : "No"}</dd></div></dl></section></div></section>;
  }

  function renderCurrentView() {
    if (view === "home") return renderHome();
    if (view === "meeting") return renderMeeting();
    if (view === "library") return renderLibrary();
    if (view === "detail") return renderDetail();
    if (view === "review") return renderReview();
    if (view === "settings") return renderSettings();
    if (view === "export") return renderExport();
    return renderProof();
  }

  if (!licenseLoaded) {
    return (
      <main className="activation-shell loading-shell" data-view="activation-loading" aria-label="Loading Candor activation">
        <section className="setup-card">
          <header><span>Loading</span><h1>Opening Candor</h1><p>Checking local activation and setup status.</p></header>
        </section>
      </main>
    );
  }

  if (licenseApi && (!licenseActive || onboardingStep !== "app")) {
    return !licenseActive || onboardingStep === "activate"
      ? renderActivationGate()
      : renderOnboardingSetup();
  }

  return (
    <AppShell
      view={view}
      recordings={recordings}
      openMeetingIds={openMeetingIds}
      selectedRecordingId={selectedRecordingId}
      activeCapture={activeCapture}
      combinedCaptureAvailable={combinedCaptureAvailable}
      busy={Boolean(busy)}
      notice={notice}
      error={error}
      onHome={() => setView("home")}
      onStartRecording={() => void startPreferredRecording()}
      onNavigate={setView}
      onOpenRecording={(recordingId) => void openRecording(recordingId, "meeting")}
      onCloseMeeting={closeMeetingTab}
      onDismissNotice={() => setNotice("")}
      onDismissError={() => setError("")}
    >
      {renderCurrentView()}
    </AppShell>
  );
}
