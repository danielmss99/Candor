import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AnimatedTranscript,
  EvidenceTimeline,
  FadePanel,
  VerificationText,
  type EvidenceMarker,
} from "./meeting-motion";
import { RecordAction, RecordGlyph } from "./components/RecordAction";

type LocalJsonValue =
  | null
  | boolean
  | number
  | string
  | LocalJsonValue[]
  | { [key: string]: LocalJsonValue };
type JsonObject = Record<string, LocalJsonValue>;
type AiMode = "quality" | "fast";
type InstructAssetKind = "runner" | "model";
type AppView = "home" | "meeting" | "library" | "detail" | "review" | "settings" | "export" | "proof";
type DetailSection = "summary" | "transcript" | "notes" | "actions" | "audio";
type SettingsSection = "general" | "recording" | "models" | "privacy" | "export" | "license";
type ReviewSection = "summary" | "decisions" | "actions" | "questions" | "risks" | "notes" | "transcript" | "preview";
type LibraryFilter = "all" | "transcribed" | "audio";
type OnboardingStep = "activate" | "yours" | "microphone" | "system-audio" | "storage" | "local-ai" | "app";
type ExportFormat = "markdown" | "docx" | "pdf";
type ExportPaperSize = "letter" | "a4";

interface RecordingSummary {
  recordingId: string;
  label: string;
  state: string;
  audioDurationMs: number;
  audioChunkCount: number;
  transcriptSegmentCount: number;
  updatedAtMs: number;
}

interface TranscriptSegment {
  index: number;
  channel: string;
  speaker: string;
  text: string;
  startMs: number;
  endMs: number;
  confidence?: number;
}

interface MarkedMoment {
  id: string;
  timeMs: number;
  label: string;
}

interface ModelRow {
  modelId: string;
  language: string;
  installed: boolean;
  verified: boolean;
  bytes: number;
  failureCode: string;
}

interface RecapItem {
  category: string;
  text: string;
  speaker: string;
  channel: string;
  startMs: number;
  segmentIndex: number;
  quote: string;
}

interface LocalAiRecap {
  engine: string;
  summary: string;
  markdown: string;
  decisions: RecapItem[];
  actions: RecapItem[];
  risks: RecapItem[];
  questions: RecapItem[];
  citations: RecapItem[];
}

interface LocalAiAnswer {
  engine: string;
  question: string;
  answer: string;
  answerFound: boolean;
  intent: string;
  citations: RecapItem[];
}

function recapItemKey(item: RecapItem): string {
  return `${item.category}-${item.segmentIndex}-${item.text}`;
}

function exportReportItem(item: RecapItem): JsonObject {
  return {
    text: item.text,
    speaker: item.speaker,
    startMs: item.startMs,
    owner: "",
    dueDate: "",
    status: "",
  };
}

function exportFormatLabel(format: ExportFormat): string {
  if (format === "docx") return "Word (.docx)";
  if (format === "pdf") return "PDF";
  return "Markdown";
}

function exportActionLabel(format: ExportFormat): string {
  if (format === "docx") return "Save Word";
  if (format === "pdf") return "Save PDF";
  return "Save Markdown";
}

const DEFAULT_MODEL = "base.en";

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function asArray(value: unknown): LocalJsonValue[] {
  return Array.isArray(value) ? (value as LocalJsonValue[]) : [];
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asBool(value: unknown): boolean {
  return value === true;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "Missing";
  const units = ["B", "KB", "MB", "GB"];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** unitIndex;
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function parseMarkedMoments(markdown: string): MarkedMoment[] {
  const moments: MarkedMoment[] = [];
  const pattern = /^- \[(\d+):(\d{2})\] (.+)$/gm;
  for (const match of markdown.matchAll(pattern)) {
    const minutes = Number(match[1]);
    const seconds = Number(match[2]);
    if (!Number.isFinite(minutes) || !Number.isFinite(seconds) || seconds > 59) continue;
    const timeMs = (minutes * 60 + seconds) * 1000;
    moments.push({
      id: `note-${timeMs}-${moments.length}`,
      timeMs,
      label: match[3] || "Marked moment",
    });
  }
  return moments;
}

function parseRecordings(value: unknown): RecordingSummary[] {
  return asArray(asObject(value).recordings)
    .map((item) => {
      const object = asObject(item);
      const recordingId = asString(object.recordingId);
      return {
        recordingId,
        label: asString(object.label, recordingId || "Untitled recording"),
        state: asString(object.state, "unknown"),
        audioDurationMs: asNumber(object.audioDurationMs),
        audioChunkCount: asNumber(object.audioChunkCount),
        transcriptSegmentCount: asNumber(object.transcriptSegmentCount),
        updatedAtMs: asNumber(object.updatedAtMs),
      };
    })
    .filter((recording) => recording.recordingId);
}

function parseTranscript(value: unknown): TranscriptSegment[] {
  return asArray(asObject(value).segments).map((item) => {
    const object = asObject(item);
    return {
      index: asNumber(object.index),
      channel: asString(object.channel, "mixed"),
      speaker: asString(object.speaker, "Speaker"),
      text: asString(object.text),
      startMs: asNumber(object.startMs),
      endMs: asNumber(object.endMs),
      confidence: typeof object.confidence === "number" ? object.confidence : undefined,
    };
  });
}

function parseModels(value: unknown): ModelRow[] {
  return asArray(asObject(value).models).map((item) => {
    const object = asObject(item);
    return {
      modelId: asString(object.modelId),
      language: asString(object.language),
      installed: asBool(object.installed),
      verified: asBool(object.verified),
      bytes: asNumber(object.bytes),
      failureCode: asString(object.failureCode),
    };
  });
}

function parseRecapItem(value: unknown): RecapItem {
  const object = asObject(value);
  return {
    category: asString(object.category),
    text: asString(object.text),
    speaker: asString(object.speaker, "Speaker"),
    channel: asString(object.channel, "mixed"),
    startMs: asNumber(object.startMs),
    segmentIndex: asNumber(object.segmentIndex),
    quote: asString(object.quote),
  };
}

function parseRecap(value: unknown): LocalAiRecap {
  const object = asObject(value);
  const markdown = asString(object.recapMarkdown);
  return {
    engine: asString(object.engine, "heuristic-local"),
    summary: asString(object.summary, markdown ? "" : "No local recap yet."),
    markdown,
    decisions: asArray(object.decisions).map(parseRecapItem),
    actions: asArray(object.actions).map(parseRecapItem),
    risks: asArray(object.risks).map(parseRecapItem),
    questions: asArray(object.questions).map(parseRecapItem),
    citations: asArray(object.citations).map(parseRecapItem),
  };
}

function parseAnswer(value: unknown): LocalAiAnswer {
  const object = asObject(value);
  const answer = asString(object.answer, "No local answer yet.");
  const engine = asString(object.engine, "heuristic-local");
  return {
    engine,
    question: asString(object.question),
    answer,
    answerFound: typeof object.answerFound === "boolean" ? object.answerFound : Boolean(answer.trim()),
    intent: asString(object.intent, engine === "llama-cpp-local" ? "cited local answer" : "general"),
    citations: asArray(object.citations).map(parseRecapItem),
  };
}

function metric(value: unknown, fallback = "Unknown"): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return fallback;
}

function DocumentPreview({
  title,
  summary,
  decisions,
  actions,
  risks,
  questions,
  includeSummary,
  includeNotes,
  includeTranscript,
}: {
  title: string;
  summary: string;
  decisions: RecapItem[];
  actions: RecapItem[];
  risks: RecapItem[];
  questions: RecapItem[];
  includeSummary: boolean;
  includeNotes: boolean;
  includeTranscript: boolean;
}) {
  return (
    <article className="document-preview" aria-label="Local report preview">
      <p className="document-kicker">{title.toUpperCase()}</p>
      <h3>Meeting Summary</h3>
      <p className="document-date">Local meeting report</p>
      {includeSummary ? <><h4>Executive Summary</h4><p>{summary || "Generate a local recap to populate this report."}</p></> : null}
      {decisions.length ? <><h4>Decisions</h4>{decisions.slice(0, 3).map((item) => <p key={`${item.segmentIndex}-${item.text}`}>- {item.text}</p>)}</> : null}
      {actions.length ? <><h4>Action Items</h4>{actions.slice(0, 3).map((item) => <p key={`${item.segmentIndex}-${item.text}`}>- {item.text}</p>)}</> : null}
      {risks.length ? <><h4>Risks</h4>{risks.slice(0, 2).map((item) => <p key={`${item.segmentIndex}-${item.text}`}>- {item.text}</p>)}</> : null}
      {questions.length ? <><h4>Open Questions</h4>{questions.slice(0, 2).map((item) => <p key={`${item.segmentIndex}-${item.text}`}>- {item.text}</p>)}</> : null}
      {includeNotes ? <p className="document-included">Manual notes included</p> : null}
      {includeTranscript ? <p className="document-included">Transcript appendix included</p> : null}
      <span className="document-page-number">Page 1</span>
    </article>
  );
}

export default function CandorApp() {
  const api = window.candor?.core;
  const licenseApi = window.candor?.license;
  const [view, setView] = useState<AppView>("meeting");
  const [detailSection, setDetailSection] = useState<DetailSection>("summary");
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("models");
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

  const [coreStatus, setCoreStatus] = useState<JsonObject>({});
  const [capabilities, setCapabilities] = useState<JsonObject>({});
  const [privacyAudit, setPrivacyAudit] = useState<JsonObject>({});
  const [updateStatus, setUpdateStatus] = useState<JsonObject>({});
  const [v2ImportStatus, setV2ImportStatus] = useState<JsonObject>({});
  const [consentStatus, setConsentStatus] = useState<JsonObject>({});
  const [vaultStatus, setVaultStatus] = useState<JsonObject>({});
  const [captureStatus, setCaptureStatus] = useState<JsonObject>({});
  const [aiStatus, setAiStatus] = useState<JsonObject>({});
  const [instructAssetsStatus, setInstructAssetsStatus] = useState<JsonObject>({});
  const [instructStatus, setInstructStatus] = useState<JsonObject>({});
  const [schedulerStatus, setSchedulerStatus] = useState<JsonObject>({});
  const [modelStatus, setModelStatus] = useState<JsonObject>({});
  const [transcriptionStatus, setTranscriptionStatus] = useState<JsonObject>({});
  const [retentionStatus, setRetentionStatus] = useState<JsonObject>({});
  const [recordings, setRecordings] = useState<RecordingSummary[]>([]);
  const [selectedRecordingId, setSelectedRecordingId] = useState("");
  const [transcript, setTranscript] = useState<TranscriptSegment[]>([]);
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
  const [instructSetupOpen, setInstructSetupOpen] = useState(true);
  const [markdownExport, setMarkdownExport] = useState("");
  const [audioUrl, setAudioUrl] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const activeCapture = asBool(captureStatus.active);
  const activeRecordingId = asString(asObject(captureStatus.activeSession).recordingId);
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

  const run = useCallback(async (label: string, task: () => Promise<void>) => {
    setBusy(label);
    setError("");
    setNotice("");
    try {
      await task();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy("");
    }
  }, []);

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
    async (recordingId: string) => {
      if (!api || !recordingId) {
        setTranscript([]);
        setReplay({});
        setNotesMarkdown("");
        setNotesStatus({});
        setNotesDirty(false);
        setMarkedMoments([]);
        setRecap(null);
        setAskAnswer(null);
        return;
      }
      const [nextTranscript, nextReplay, nextNotes] = await Promise.all([
        api.recordingDurableTranscript(recordingId),
        api.recordingDurableReplayManifest(recordingId),
        api.recordingNotesRead(recordingId),
      ]);
      const replayObject = asObject(nextReplay);
      setTranscript(parseTranscript(nextTranscript));
      setReplay(replayObject);
      const notesObject = asObject(nextNotes);
      const nextMarkdown = asString(notesObject.markdown);
      setNotesMarkdown(nextMarkdown);
      setNotesStatus(notesObject);
      setNotesDirty(false);
      setMarkedMoments(parseMarkedMoments(nextMarkdown));
      setRecap(null);
      setAskAnswer(null);
      const nextTracks = asArray(replayObject.tracks).map((track) => asString(track)).filter(Boolean);
      if (nextTracks.length > 0 && !nextTracks.includes(selectedTrack)) {
        setSelectedTrack(nextTracks[0]);
      }
    },
    [api, selectedTrack],
  );

  const refresh = useCallback(async () => {
    if (!api) {
      setError("Candor preload API is unavailable");
      return;
    }
    const [
      nextCore,
      nextCapabilities,
      nextPrivacy,
      nextUpdates,
      nextImport,
      nextConsent,
      nextVault,
      nextCapture,
      nextAi,
      nextInstructAssets,
      nextInstruct,
      nextScheduler,
      nextModels,
      nextTranscription,
      nextRetention,
      nextLibrary,
    ] = await Promise.all([
      api.status(),
      api.capabilities(),
      api.privacyAuditSnapshot(),
      api.updateStatus(),
      api.v2ImportStatus(),
      api.consentStatus(),
      api.vaultStatus(),
      api.captureStatus(),
      api.aiStatus(),
      api.aiInstructAssetsStatus(),
      api.aiInstructStatus(),
      api.aiSchedulerStatus(),
      api.modelsStatus(),
      api.transcriptionStatus(),
      api.retentionStatus(),
      api.recordingDurableList(),
    ]);
    setCoreStatus(asObject(nextCore));
    setCapabilities(asObject(nextCapabilities));
    setPrivacyAudit(asObject(nextPrivacy));
    setUpdateStatus(asObject(nextUpdates));
    setV2ImportStatus(asObject(nextImport));
    setConsentStatus(asObject(nextConsent));
    setVaultStatus(asObject(nextVault));
    setCaptureStatus(asObject(nextCapture));
    setAiStatus(asObject(nextAi));
    setInstructAssetsStatus(asObject(nextInstructAssets));
    setInstructStatus(asObject(nextInstruct));
    setSchedulerStatus(asObject(nextScheduler));
    setModelStatus(asObject(nextModels));
    setTranscriptionStatus(asObject(nextTranscription));
    setRetentionStatus(asObject(nextRetention));
    const nextRecordings = parseRecordings(nextLibrary);
    setRecordings(nextRecordings);
    const nextSelected =
      selectedRecordingId && nextRecordings.some((item) => item.recordingId === selectedRecordingId)
        ? selectedRecordingId
        : nextRecordings[0]?.recordingId ?? "";
    setSelectedRecordingId(nextSelected);
    if (nextSelected) await loadSelectedRecording(nextSelected);
  }, [api, loadSelectedRecording, selectedRecordingId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void refreshLicense();
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
        if (next.length >= 6) break;
        if (!next.includes(recording.recordingId)) next.push(recording.recordingId);
      }
      return next;
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
    if (!asBool(consentStatus.readyForMicRecording)) {
      setError("Acknowledge local storage and microphone recording consent before recording.");
      setSettingsSection("recording");
      setView("settings");
      return;
    }
    await run("record", async () => {
      const result = await api.captureStartMic({ label: recordingTitle.trim() || "Untitled local meeting", chunkMs: 500 });
      setNotice(`Recording ${asString(asObject(asObject(result).capture).recordingId, "started")}`);
      setView("meeting");
      await refresh();
    });
  }

  async function startSystemRecording() {
    if (!api) return;
    if (!asBool(asObject(asObject(captureStatus.sources).system).implemented)) {
      setError("System audio capture is not implemented on this OS yet.");
      return;
    }
    if (!asBool(consentStatus.readyForSystemAudioRecording)) {
      setError("Acknowledge local storage and system audio consent before recording system audio.");
      setSettingsSection("recording");
      setView("settings");
      return;
    }
    await run("record", async () => {
      await api.captureStartSystem({ label: recordingTitle.trim() || "Untitled local system audio", chunkMs: 500 });
      setNotice("System audio recording started locally");
      setView("meeting");
      await refresh();
    });
  }

  async function startMicAndSystemRecording() {
    if (!api) return;
    if (!combinedCaptureAvailable) {
      setError("Combined mic and system capture is not implemented on this OS yet.");
      return;
    }
    if (!asBool(consentStatus.readyForMicAndSystemAudioRecording)) {
      setError("Acknowledge local storage, microphone, and system audio consent before combined recording.");
      setSettingsSection("recording");
      setView("settings");
      return;
    }
    await run("record", async () => {
      await api.captureStartMicAndSystem({ label: recordingTitle.trim() || "Untitled local meeting", chunkMs: 500 });
      setNotice("Microphone and system audio recording started locally");
      setView("meeting");
      await refresh();
    });
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
    await run("stop", async () => {
      const result = await api.captureStop();
      const recordingId = asString(asObject(asObject(result).capture).recordingId);
      setNotice("Recording saved locally");
      await refresh();
      if (recordingId) {
        setSelectedRecordingId(recordingId);
        setOpenMeetingIds((current) => [recordingId, ...current.filter((id) => id !== recordingId)].slice(0, 6));
        await loadSelectedRecording(recordingId);
      }
    });
  }

  async function importModel() {
    if (!api) return;
    await run("import", async () => {
      const result = await api.modelsImportFromFile({ modelId: selectedModel, replace: true });
      const object = asObject(result);
      setNotice(asBool(object.canceled) ? "Import canceled" : asBool(object.imported) ? `${selectedModel} verified and installed` : "Model import finished");
      await refresh();
    });
  }

  async function importInstructAsset() {
    if (!api) return;
    const expectedSha256 = instructExpectedSha256.trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
      setInstructAssetError("Enter exactly 64 hexadecimal characters.");
      return;
    }
    setBusy("instruct-asset");
    setError("");
    setNotice("");
    setInstructAssetError("");
    try {
      const result = await api.aiInstructAssetImportFromFile({ assetKind: instructAssetKind, expectedSha256, replace: true });
      const object = asObject(result);
      if (asBool(object.canceled)) {
        setNotice("Local AI import canceled");
        return;
      }
      if (!asBool(object.imported) || !asBool(object.integrityVerified)) {
        throw new Error("Local AI asset was not verified.");
      }
      setInstructExpectedSha256("");
      setNotice(`${instructAssetKind === "runner" ? "Runner" : "GGUF model"} verified and stored locally`);
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setInstructAssetError(message);
      setError(message);
    } finally {
      setBusy("");
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
      await refresh();
      setView("library");
    });
  }

  async function verifyModel() {
    if (!api) return;
    await run("verify", async () => {
      const result = await api.modelsVerifyLocal({ modelId: selectedModel });
      const object = asObject(result);
      setNotice(asBool(object.verified) ? `${selectedModel} verified` : `${selectedModel}: ${asString(object.failureCode, "not ready")}`);
      await refresh();
    });
  }

  async function transcribeRecording() {
    if (!api || !selectedRecordingId) return;
    await run("transcribe", async () => {
      await api.transcriptionRunLocal({ recordingId: selectedRecordingId, channel: selectedTrack || undefined, modelId: selectedModel, language: "en" });
      setNotice("Transcription updated");
      await refresh();
      await loadSelectedRecording(selectedRecordingId);
    });
  }

  async function searchRecordings() {
    if (!api || !searchQuery.trim()) return;
    await run("search", async () => {
      const result = await api.recordingDurableSearch(searchQuery.trim());
      setSearchMatches(asArray(asObject(result).matches));
    });
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
    });
  }

  async function saveMeetingNotes() {
    if (!api || !selectedRecordingId) return;
    await run("notes", async () => {
      const result = await api.recordingNotesSave(selectedRecordingId, notesMarkdown);
      setNotesStatus(asObject(result));
      setNotesDirty(false);
      setNotice("Meeting notes saved locally");
    });
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
      const result = useInstructModel
        ? await api.aiRecapInstruct(selectedRecordingId, 512)
        : await api.aiRecapHeuristic(selectedRecordingId);
      setRecap(parseRecap(result));
      setNotice(useInstructModel ? "Local model recap generated" : aiMode === "quality" ? "Fast local recap generated because the model is unavailable" : "Fast local recap generated");
    });
  }

  async function askSelectedRecording() {
    if (!api || !selectedRecordingId) return;
    const question = askQuestion.trim();
    if (!question) {
      setError("Ask needs a question.");
      return;
    }
    await run("ask", async () => {
      const result = useInstructModel
        ? await api.aiAskInstruct(selectedRecordingId, question, 256)
        : await api.aiAskHeuristic(selectedRecordingId, question);
      setAskAnswer(parseAnswer(result));
      setNotice(useInstructModel ? "Local model answer generated" : "Fast local answer generated");
    });
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
      await refresh();
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
      await refresh();
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
      await refresh();
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
      await refresh();
    });
  }

  async function acknowledgeSystemConsent() {
    if (!api) return;
    const required = asArray(consentStatus.requiredForSystemAudio).map((item) => asString(item)).filter(Boolean);
    await run("consent", async () => {
      const result = await api.consentAcknowledge({ items: required.length ? required : ["localOnlyStorage", "systemAudioRecording"] });
      setConsentStatus(asObject(result));
      setNotice("System audio consent saved locally");
      await refresh();
    });
  }

  async function openRecording(recordingId: string, target: AppView = "meeting") {
    setSelectedRecordingId(recordingId);
    setOpenMeetingIds((current) => [recordingId, ...current.filter((id) => id !== recordingId)].slice(0, 6));
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
  const custodyItems = [
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
      <AnimatedTranscript
        emptyMessage="No transcript segments yet. Record or transcribe a local meeting to populate this view."
        segments={transcript.map((segment) => ({
          id: `${segment.index}-${segment.startMs}`,
          speaker: segment.speaker,
          startMs: segment.startMs,
          channel: segment.channel,
          text: segment.text,
        }))}
      />
    );
  }

  function renderOnboardingProgress() {
    const steps: Array<[OnboardingStep, string]> = [
      ["yours", "License"],
      ["microphone", "Microphone"],
      ["system-audio", "System audio"],
      ["storage", "Storage"],
      ["local-ai", "Local AI"],
    ];
    const activeIndex = Math.max(0, steps.findIndex(([id]) => id === onboardingStep));
    return (
      <ol className="onboarding-progress" aria-label="Setup progress">
        {steps.map(([id, label], index) => (
          <li key={id} data-active={id === onboardingStep} data-complete={index < activeIndex}>
            <span>{index + 1}</span>
            <strong>{label}</strong>
          </li>
        ))}
      </ol>
    );
  }

  function renderActivationGate() {
    return (
      <main className="activation-shell" data-view="activation" aria-label="Candor activation onboarding">
        <section className="activation-hero">
          <p className="activation-kicker">Candor Professional</p>
          <h1>Welcome to Candor</h1>
          <p>Private meeting intelligence that runs on your computer. No subscription, no meeting bot, no cloud account for normal use.</p>
          <div className="activation-proof-grid" aria-label="Ownership promises">
            <article><strong>Buy it once</strong><span>Activate this device with a local license record.</span></article>
            <article><strong>Start locally</strong><span>Use a trial without creating an account.</span></article>
            <article><strong>Stay private</strong><span>Recording, notes, AI, and exports remain local by default.</span></article>
          </div>
        </section>
        <section className="activation-card" aria-label="Activate Candor">
          <form onSubmit={(event) => { event.preventDefault(); void activateLicense(); }}>
            <header>
              <h2>Activate License</h2>
              <p>Enter your purchase key, or start a local trial while production licensing is connected.</p>
            </header>
            <label className="activation-field" htmlFor="candor-license-key">
              <span>License key <em>required for activation</em></span>
              <input
                id="candor-license-key"
                value={licenseKey}
                onBlur={() => setLicenseKeyTouched(true)}
                onChange={(event) => { setLicenseKey(event.target.value); setLicenseKeyTouched(false); }}
                aria-invalid={licenseKeyInvalid}
                aria-describedby="candor-license-key-help"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                placeholder="CANDOR-DEV-LOCAL"
              />
              <small id="candor-license-key-help" role={licenseKeyInvalid ? "alert" : undefined}>{licenseKeyInvalid ? "Enter a license key or choose Start Trial." : "Development accepts CANDOR-DEV keys until production verification is connected."}</small>
            </label>
            <label className="activation-field" htmlFor="candor-license-email">
              <span>Purchase email <em>optional</em></span>
              <input
                id="candor-license-email"
                type="email"
                value={licenseEmail}
                onChange={(event) => setLicenseEmail(event.target.value)}
                autoComplete="email"
                placeholder="you@example.com"
              />
              <small>Stored as a local hash only when provided.</small>
            </label>
            <div className="activation-actions">
              <button className="primary-button" type="submit" disabled={busy === "license"}>{busy === "license" ? "Activating..." : "Activate License"}</button>
              <button className="secondary-button" type="button" onClick={() => void startTrial()} disabled={busy === "license"}>Start Trial</button>
            </div>
          </form>
          <dl className="activation-facts">
            <div><dt>Account required</dt><dd>No</dd></div>
            <div><dt>Storage</dt><dd>{asBool(licenseStatus.secureStorageAvailable) ? "OS protected" : "Local metadata"}</dd></div>
            <div><dt>Network</dt><dd>Disabled by default</dd></div>
          </dl>
        </section>
      </main>
    );
  }

  function renderSetupStep() {
    const systemImplemented = asBool(asObject(asObject(captureStatus.sources).system).implemented);
    const verifiedModelCount = asNumber(modelStatus.verifiedModelCount);
    const trialDays = asNumber(licenseStatus.trialDaysRemaining, -1);
    const licenseLabel = licenseState === "trial" && trialDays >= 0
      ? `${trialDays} trial days remaining`
      : licenseState === "activated"
        ? "Activated on this device"
        : "Local trial";

    if (onboardingStep === "microphone") {
      return (
        <section className="setup-card">
          <header><span>Step 2</span><h1>Microphone Permission</h1><p>Candor needs explicit local consent before recording microphone audio.</p></header>
          <div className="setup-status-row"><span className={asBool(consentStatus.readyForMicRecording) ? "status-dot ok" : "status-dot"} /><strong>{asBool(consentStatus.readyForMicRecording) ? "Microphone consent saved" : "Microphone consent required"}</strong></div>
          <div className="setup-actions"><button className="secondary-button" type="button" onClick={() => setOnboardingStep("yours")}>Back</button><button className="primary-button" type="button" onClick={() => void completeMicOnboarding()} disabled={busy === "consent"}>{asBool(consentStatus.readyForMicRecording) ? "Continue" : "Acknowledge Microphone"}</button></div>
        </section>
      );
    }

    if (onboardingStep === "system-audio") {
      return (
        <section className="setup-card">
          <header><span>Step 3</span><h1>System Audio</h1><p>Enable meeting audio capture from this computer when the OS capture path is available.</p></header>
          <div className="setup-status-row"><span className={systemImplemented && asBool(consentStatus.readyForSystemAudioRecording) ? "status-dot ok" : "status-dot"} /><strong>{!systemImplemented ? "System audio capture unavailable on this OS build" : asBool(consentStatus.readyForSystemAudioRecording) ? "System audio consent saved" : "System audio consent required"}</strong></div>
          <div className="setup-actions"><button className="secondary-button" type="button" onClick={() => setOnboardingStep("microphone")}>Back</button><button className="primary-button" type="button" onClick={() => void completeSystemAudioOnboarding()} disabled={busy === "consent"}>{!systemImplemented || asBool(consentStatus.readyForSystemAudioRecording) ? "Continue" : "Acknowledge System Audio"}</button></div>
        </section>
      );
    }

    if (onboardingStep === "storage") {
      return (
        <section className="setup-card">
          <header><span>Step 4</span><h1>Storage Location</h1><p>Candor uses the protected local vault for recordings, notes, transcripts, and report data.</p></header>
          <dl className="setup-facts"><div><dt>Vault</dt><dd>{metric(vaultStatus.backend, "SQLCipher")}</dd></div><div><dt>OS key storage</dt><dd>{metric(vaultStatus.osKeyStorage, "Checking")}</dd></div><div><dt>Raw paths exposed</dt><dd>{asBool(vaultStatus.rawPathExposed) ? "Yes" : "No"}</dd></div></dl>
          <div className="setup-actions"><button className="secondary-button" type="button" onClick={() => setOnboardingStep("system-audio")}>Back</button><button className="primary-button" type="button" onClick={() => void completeStorageOnboarding()} disabled={busy === "storage"}>Use Local Vault</button></div>
        </section>
      );
    }

    if (onboardingStep === "local-ai") {
      return (
        <section className="setup-card">
          <header><span>Step 5</span><h1>Local AI Model Setup</h1><p>Import a verified local model now, or use the fast local fallback and finish setup.</p></header>
          <dl className="setup-facts"><div><dt>Whisper models</dt><dd>{verifiedModelCount} verified</dd></div><div><dt>Recap mode</dt><dd>{aiModeStatus}</dd></div><div><dt>Managed assets</dt><dd>{instructAssetsReady ? "Ready" : "Optional"}</dd></div></dl>
          <div className="setup-actions"><button className="secondary-button" type="button" onClick={() => void importModel()} disabled={Boolean(busy)}>Import Whisper Model</button><button className="primary-button" type="button" onClick={finishOnboarding}>Finish Setup</button></div>
        </section>
      );
    }

    return (
      <section className="setup-card">
        <header><span>Step 1</span><h1>Candor is yours</h1><p>{licenseLabel}. Normal app use does not require a persistent account or sign-in.</p></header>
        <dl className="setup-facts"><div><dt>Plan</dt><dd>{metric(licenseStatus.planName, "Candor Professional")}</dd></div><div><dt>License</dt><dd>{metric(licenseStatus.licenseId, "Local trial")}</dd></div><div><dt>Verification</dt><dd>{metric(licenseStatus.productionVerification, "pending")}</dd></div></dl>
        <div className="setup-actions"><button className="secondary-button" type="button" onClick={finishOnboarding}>Open App</button><button className="primary-button" type="button" onClick={() => setOnboardingStep("microphone")}>Continue Setup</button></div>
      </section>
    );
  }

  function renderOnboardingSetup() {
    return (
      <main className="activation-shell setup-shell" data-view="onboarding" aria-label="Candor first run setup">
        <aside className="setup-side">
          <button className="wordmark setup-wordmark" type="button" onClick={() => setOnboardingStep("yours")}><img src="./candor-mark.png" width="28" height="28" alt="" aria-hidden="true" /><span>Candor</span></button>
          {renderOnboardingProgress()}
          <p>Everything here is local setup. The License Portal remains optional and is not required for normal use.</p>
        </aside>
        <section className="setup-main">
          {renderSetupStep()}
        </section>
      </main>
    );
  }

  function renderHome() {
    return (
      <section className="page-view" data-view="home">
        <header className="screen-heading">
          <h1>Home</h1>
          <p>Your local meeting workspace</p>
        </header>
        <section className="dashboard-actions" aria-label="Quick actions">
          <RecordAction
            variant="dashboard"
            active={activeCapture}
            captureLabel={combinedCaptureAvailable ? "Microphone and system audio" : "Microphone audio"}
            onClick={() => void startPreferredRecording()}
            disabled={Boolean(busy)}
          />
          <button className="surface-action" type="button" onClick={() => setView("library")}>Open library</button>
          <button className="surface-action" type="button" onClick={() => void importV2Folder()} disabled={Boolean(busy) || !asBool(v2ImportStatus.implemented)}>Import v2 folder</button>
          <label className="quick-title-field">
            <span>Next recording title</span>
            <input value={recordingTitle} onChange={(event) => setRecordingTitle(event.target.value)} />
          </label>
        </section>
        <section className="dashboard-section">
          <div className="section-heading"><h2>Recent meetings</h2><button type="button" onClick={() => setView("library")}>View all</button></div>
          <div className="recent-meeting-grid">
            {recordings.slice(0, 4).map((recording) => (
              <button className="meeting-card" type="button" key={recording.recordingId} onClick={() => void openRecording(recording.recordingId, "detail")}>
                <strong>{recording.label}</strong>
                <span>{formatDuration(recording.audioDurationMs)} local audio</span>
                <small>{recording.transcriptSegmentCount} transcript segments</small>
              </button>
            ))}
            {!recordings.length ? <p className="empty-state dashboard-empty">No local meetings yet.</p> : null}
          </div>
        </section>
        <section className="dashboard-section">
          <h2>Storage and privacy</h2>
          <div className="status-grid">
            <div className="status-panel"><strong>Local vault</strong><p>{recordings.length} meetings stored</p><span>{metric(vaultStatus.backend, "SQLCipher")}</span></div>
            <div className={`status-panel ${instructReady ? "verified" : ""}`}><VerificationText value={instructReady ? "Local AI ready" : "Local AI fallback ready"} /><p>{metric(modelStatus.verifiedModelCount, "0")} verified Whisper models</p><span>{aiModeStatus}</span></div>
          </div>
        </section>
      </section>
    );
  }

  function renderMeeting() {
    return (
      <section className="page-view live-meeting-view" data-view="meeting">
        <header className="screen-heading meeting-heading">
          <div><h1>{selectedTitle}</h1><p>{selectedRecording ? `${formatDuration(selectedRecording.audioDurationMs)} local audio` : "Ready for a new local recording"}</p></div>
          <button className="secondary-button" type="button" onClick={() => setView("detail")} disabled={!selectedRecordingId}>Open summary</button>
        </header>
        {!asBool(consentStatus.readyForMicRecording) ? (
          <div className="consent-callout" role="status">
            <div><strong>Recording consent required</strong><span>Local storage and microphone acknowledgement are not yet recorded.</span></div>
            <button type="button" onClick={() => { setSettingsSection("recording"); setView("settings"); }}>Review consent</button>
          </div>
        ) : null}
        <EvidenceTimeline
          active={activeCapture}
          durationMs={timelineDurationMs}
          audioUrl={audioUrl}
          markers={evidenceMarkers}
          canMark={Boolean(selectedRecordingId)}
          onLoadAudio={() => void loadAudio()}
          onMarkMoment={markMoment}
        />
        <div className="live-workspace-grid">
          <section className="live-transcript" aria-label="Live transcript">
            <div className="section-heading"><div><h2>Live transcript</h2><span className="success-text">{activeCapture ? "Following live" : "Stored locally"}</span></div><button type="button" onClick={() => void transcribeRecording()} disabled={!selectedRecordingId || Boolean(busy)}>Transcribe</button></div>
            {renderTranscriptList()}
          </section>
          <section className="meeting-notes-panel">
            <div className="panel-tabs" role="tablist" aria-label="Notes panel">
              <button type="button" role="tab" aria-selected={notesPanelMode === "notes"} onClick={() => setNotesPanelMode("notes")}>My notes</button>
              <button type="button" role="tab" aria-selected={notesPanelMode === "suggestions"} onClick={() => setNotesPanelMode("suggestions")}>AI suggestions <span>{recapSuggestions.length}</span></button>
            </div>
            {notesPanelMode === "notes" ? (
              <FadePanel panelKey="notes">
              <div className="notes-editor-wrap">
                <textarea
                  aria-label="Meeting notes"
                  value={notesMarkdown}
                  onChange={(event) => { setNotesMarkdown(event.target.value); setNotesDirty(true); }}
                  placeholder="Write local meeting notes..."
                />
                <div className="notes-footer"><span>{notesDirty ? "Unsaved" : asBool(notesStatus.savedLocally) ? "Saved locally" : "Local draft"}</span><button type="button" onClick={() => void saveMeetingNotes()} disabled={!selectedRecordingId || !notesDirty || Boolean(busy)}>Save notes</button></div>
              </div>
              </FadePanel>
            ) : (
              <FadePanel panelKey="suggestions">
                <div className="suggestion-pane">
                  <div className="suggestion-list">
                    <button className="secondary-button full-width" type="button" onClick={() => void generateRecap()} disabled={!selectedRecordingId || Boolean(busy)}>Generate local suggestions</button>
                    {recapSuggestions.map((item) => <article className="suggestion-row" key={`${item.category}-${item.segmentIndex}-${item.text}`}><strong>{item.category || "Insight"}</strong><p>{item.text}</p><span>{formatDuration(item.startMs)}</span></article>)}
                    {!recapSuggestions.length ? <p className="empty-state">No AI suggestions generated.</p> : null}
                  </div>
                  <div className="ai-mode-row">
                    <div className="ai-mode-copy"><strong>Local AI</strong><span id="local-ai-mode-status">{aiModeStatus}</span></div>
                    <div className="segmented-control" role="group" aria-label="Local AI mode" aria-describedby="local-ai-mode-status">
                      <button type="button" aria-pressed={aiMode === "quality"} onClick={() => setAiMode("quality")}>Quality</button>
                      <button type="button" aria-pressed={aiMode === "fast"} onClick={() => setAiMode("fast")}>Fast</button>
                    </div>
                  </div>
                </div>
              </FadePanel>
            )}
          </section>
        </div>
        <footer className="recording-transport">
          <div><RecordGlyph active={activeCapture} /><strong>{activeCapture ? "Recording" : "Ready"}</strong><span>{activeRecordingId || selectedRecordingId || "No active session"}</span></div>
          <div className="transport-actions">
            <button type="button" onClick={() => void startPreferredRecording()} disabled={Boolean(busy)}>{activeCapture ? "Stop" : "Record"}</button>
            <button type="button" onClick={() => setView("review")} disabled={!selectedRecordingId}>Review</button>
          </div>
          <span className="success-text">{activeCapture ? "Writing durable chunks" : "Processing stays local"}</span>
        </footer>
      </section>
    );
  }

  function renderLibrary() {
    return (
      <section className="page-view" data-view="library">
        <header className="screen-heading"><h1>Recording Library</h1><p>Search and organize meetings stored on this machine.</p></header>
        <div className="library-toolbar">
          <div className="search-control"><input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void searchRecordings(); }} placeholder="Search transcripts and notes" aria-label="Search local meetings" /><button type="button" onClick={() => void searchRecordings()} disabled={!searchQuery.trim() || Boolean(busy)}>Search</button></div>
          <div className="filter-control" role="group" aria-label="Library filter">
            {(["all", "transcribed", "audio"] as LibraryFilter[]).map((filter) => <button type="button" key={filter} aria-pressed={libraryFilter === filter} onClick={() => setLibraryFilter(filter)}>{filter === "all" ? "All" : filter === "transcribed" ? "Transcribed" : "Has audio"}</button>)}
          </div>
        </div>
        {searchMatches.length ? <div className="search-results" aria-label="Search results">{searchMatches.slice(0, 8).map((match, index) => { const object = asObject(match); return <button type="button" key={`${asString(object.recordingId)}-${index}`} onClick={() => void openRecording(asString(object.recordingId), "detail")}><strong>{asString(object.label, "Meeting match")}</strong><span>{asString(object.snippet, asString(object.text, "Local match"))}</span></button>; })}</div> : null}
        <div className="library-list">
          <div className="library-count">{filteredRecordings.length} local recordings</div>
          {filteredRecordings.map((recording) => (
            <button type="button" className="library-row" key={recording.recordingId} onClick={() => void openRecording(recording.recordingId, "detail")}>
              <span><strong>{recording.label}</strong><small>{recording.transcriptSegmentCount} transcript segments</small></span>
              <span><small>{formatDuration(recording.audioDurationMs)}</small><em>{recording.state}</em></span>
            </button>
          ))}
          {!filteredRecordings.length ? <p className="empty-state">No local recordings match this view.</p> : null}
        </div>
      </section>
    );
  }

  function renderSummaryContent() {
    if (detailSection === "transcript") return renderTranscriptList();
    if (detailSection === "notes") return <div className="detail-notes"><textarea aria-label="Meeting notes" value={notesMarkdown} onChange={(event) => { setNotesMarkdown(event.target.value); setNotesDirty(true); }} /><button type="button" onClick={() => void saveMeetingNotes()} disabled={!notesDirty || Boolean(busy)}>Save notes</button></div>;
    if (detailSection === "actions") return <div className="structured-list"><h2>Action items</h2>{recap?.actions.map((item) => <article key={`${item.segmentIndex}-${item.text}`}><span className="check-box" aria-hidden="true" /><strong>{item.text}</strong><small>{item.speaker} at {formatDuration(item.startMs)}</small></article>)}{!recap?.actions.length ? <p className="empty-state">Generate a local recap to extract action items.</p> : null}</div>;
    if (detailSection === "audio") return <div className="audio-detail"><div className="track-tabs" role="tablist" aria-label="Audio tracks">{(tracks.length ? tracks : ["mic"]).map((track) => <button type="button" role="tab" aria-selected={selectedTrack === track} key={track} onClick={() => setSelectedTrack(track)}>{track}</button>)}</div><button type="button" className="secondary-button" onClick={() => void loadAudio()} disabled={!selectedRecordingId || Boolean(busy)}>Load local audio</button>{audioUrl ? <audio className="audio-player" controls src={audioUrl} /> : null}</div>;
    return (
      <div className="summary-content">
        <div className="summary-copy"><div className="section-heading"><h2>Executive summary</h2><button type="button" onClick={() => void generateRecap()} disabled={!selectedRecordingId || Boolean(busy)}>Generate local recap</button></div><p>{recap?.summary || "Generate a local recap from this meeting's transcript."}</p>{recap?.citations.length ? <ul className="recap-citations" aria-label="Recap citations">{recap.citations.map((citation) => <li key={`${citation.segmentIndex}-${citation.startMs}-${citation.text}`}><button type="button"><span>{formatDuration(citation.startMs)}</span>{citation.quote || citation.text}</button></li>)}</ul> : null}</div>
        <div className="structured-list"><h2>Decisions</h2>{recap?.decisions.map((item) => <article key={`${item.segmentIndex}-${item.text}`}><span className="decision-mark" aria-hidden="true">OK</span><strong>{item.text}</strong><small>{formatDuration(item.startMs)}</small></article>)}{!recap?.decisions.length ? <p className="empty-state">No reviewed decisions yet.</p> : null}</div>
        <div className="structured-list"><h2>Action items</h2>{recap?.actions.slice(0, 4).map((item) => <article key={`${item.segmentIndex}-${item.text}`}><span className="check-box" aria-hidden="true" /><strong>{item.text}</strong><small>{item.speaker}</small></article>)}{!recap?.actions.length ? <p className="empty-state">No reviewed actions yet.</p> : null}</div>
      </div>
    );
  }

  function renderDetail() {
    const detailTabs: Array<[DetailSection, string]> = [["summary", "Summary"], ["transcript", "Transcript"], ["notes", "Notes"], ["actions", "Action items"], ["audio", "Audio"]];
    return (
      <section className="page-view" data-view="detail">
        <header className="screen-heading meeting-heading"><div><h1>{selectedTitle}</h1><p>{selectedRecording ? `${formatDuration(selectedRecording.audioDurationMs)} local meeting` : "Select a meeting from the local library"}</p></div><button type="button" className="primary-button" onClick={() => setView("review")} disabled={!selectedRecordingId}>Review report</button></header>
        <div className="content-tabs" role="tablist" aria-label="Meeting detail sections">{detailTabs.map(([id, label]) => <button type="button" role="tab" aria-selected={detailSection === id} key={id} onClick={() => setDetailSection(id)}>{label}</button>)}</div>
        <div className="detail-grid">
          <section className="detail-main">{renderSummaryContent()}</section>
          <aside className="meeting-intelligence">
            <h2>Ask Candor</h2>
            <div className="ask-control"><input value={askQuestion} onChange={(event) => setAskQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void askSelectedRecording(); }} placeholder="Ask about this meeting" /><button type="button" onClick={() => void askSelectedRecording()} disabled={!selectedRecordingId || Boolean(busy)}>Ask</button></div>
            {askAnswer ? <div className="answer-panel"><strong>{askAnswer.engine}</strong><p>{askAnswer.answer}</p>{askAnswer.citations.map((citation) => <button type="button" key={`${citation.segmentIndex}-${citation.startMs}`}>{formatDuration(citation.startMs)} {citation.quote || citation.text}</button>)}</div> : null}
            <h3>Meeting facts</h3>
            <dl className="compact-facts"><div><dt>Audio</dt><dd>{selectedRecording ? formatDuration(selectedRecording.audioDurationMs) : "None"}</dd></div><div><dt>Transcript</dt><dd>{transcript.length} segments</dd></div><div><dt>Notes</dt><dd>{notesDirty ? "Unsaved" : "Local"}</dd></div><div><dt>AI</dt><dd>{aiModeStatus}</dd></div></dl>
          </aside>
        </div>
      </section>
    );
  }

  function reviewItems(section: ReviewSection): RecapItem[] {
    if (!recap) return [];
    if (section === "decisions") return recap.decisions;
    if (section === "actions") return recap.actions;
    if (section === "questions") return recap.questions;
    if (section === "risks") return recap.risks;
    return [...recap.decisions, ...recap.actions].slice(0, 4);
  }

  function renderReviewCenter() {
    if (reviewSection === "notes") return <div className="review-editor"><h2>Manual notes</h2><textarea aria-label="Meeting notes" value={notesMarkdown} onChange={(event) => { setNotesMarkdown(event.target.value); setNotesDirty(true); }} /><button type="button" onClick={() => void saveMeetingNotes()} disabled={!notesDirty || Boolean(busy)}>Save notes</button></div>;
    if (reviewSection === "transcript") return <div className="review-editor"><h2>Transcript</h2>{renderTranscriptList()}</div>;
    if (reviewSection === "preview") return <div className="review-editor"><h2>Export preview</h2><p className="empty-state">The verified local document preview remains visible beside this review area.</p><button type="button" className="primary-button" onClick={() => setView("export")}>Open export flow</button></div>;
    if (reviewSection !== "summary") {
      const items = reviewItems(reviewSection);
      return <div className="review-editor"><h2>{reviewSection === "actions" ? "Action items" : reviewSection === "questions" ? "Open questions" : reviewSection[0].toUpperCase() + reviewSection.slice(1)}</h2><div className="review-item-list">{items.map((item) => { const key = recapItemKey(item); const state = reviewStates[key]; return <article key={key}><div><strong>{item.category || reviewSection}</strong><p>{item.text}</p></div><div className="review-actions"><button type="button" aria-pressed={state === "accepted"} onClick={() => setReviewStates((current) => ({ ...current, [key]: "accepted" }))}>Accept</button><button type="button" aria-pressed={state === "rejected"} onClick={() => setReviewStates((current) => ({ ...current, [key]: "rejected" }))}>Reject</button></div></article>; })}{!items.length ? <p className="empty-state">Generate a local recap to review this section.</p> : null}</div></div>;
    }
    const items = reviewItems("summary");
    return (
      <div className="review-editor">
        <h2>Executive summary</h2><p className="review-subtitle">Review local AI output before export.</p>
        <textarea className="summary-editor" value={reviewSummaryDraft} onChange={(event) => setReviewSummaryDraft(event.target.value)} placeholder="Generate a local recap to begin review." />
        <div className="section-heading"><h3>AI review</h3><button type="button" onClick={() => void generateRecap()} disabled={!selectedRecordingId || Boolean(busy)}>Refresh recap</button></div>
        <div className="review-item-list">{items.map((item) => { const key = recapItemKey(item); const state = reviewStates[key]; return <article key={key}><div><strong>{item.category || "Insight"}</strong><p>{item.text}</p></div><div className="review-actions"><button type="button" aria-pressed={state === "accepted"} onClick={() => setReviewStates((current) => ({ ...current, [key]: "accepted" }))}>Accept</button><button type="button" aria-pressed={state === "rejected"} onClick={() => setReviewStates((current) => ({ ...current, [key]: "rejected" }))}>Reject</button></div></article>; })}{!items.length ? <p className="empty-state">No AI review items yet.</p> : null}</div>
      </div>
    );
  }

  function renderReview() {
    const sections: Array<[ReviewSection, string]> = [["summary", "Executive summary"], ["decisions", "Decisions"], ["actions", "Action items"], ["questions", "Open questions"], ["risks", "Risks"], ["notes", "Manual notes"], ["transcript", "Transcript"], ["preview", "Export preview"]];
    const reviewed = Object.keys(reviewStates).length;
    const previewDecisions = exportSections.decisions ? reviewedItems(recap?.decisions ?? []) : [];
    const previewActions = exportSections.actions ? reviewedItems(recap?.actions ?? []) : [];
    const previewRisks = exportSections.risks ? reviewedItems(recap?.risks ?? []) : [];
    const previewQuestions = exportSections.questions ? reviewedItems(recap?.questions ?? []) : [];
    return (
      <section className="review-mode" data-view="review">
        <nav className="review-navigation" aria-label="Review sections"><span>REVIEW SECTIONS</span>{sections.map(([id, label]) => <button type="button" aria-current={reviewSection === id ? "page" : undefined} key={id} onClick={() => setReviewSection(id)}>{label}</button>)}<div className="review-progress"><strong>{Math.min(8, reviewed)} of 8 sections reviewed</strong><span>{Object.values(reviewStates).filter((state) => state === "rejected").length} items need attention</span></div></nav>
        <main className="review-main">{renderReviewCenter()}</main>
        <aside className="review-preview"><div className="section-heading"><div><h2>Export preview</h2><span>{exportFormatLabel(exportFormat)}, local</span></div><button type="button" onClick={() => setView("export")}>Edit</button></div><DocumentPreview title={selectedTitle} summary={reviewSummaryDraft || recap?.summary || ""} decisions={previewDecisions} actions={previewActions} risks={previewRisks} questions={previewQuestions} includeSummary={exportSections.summary} includeNotes={exportSections.notes} includeTranscript={exportSections.transcript} /><button type="button" className="primary-button full-width" onClick={() => setView("export")}>Open export flow</button></aside>
      </section>
    );
  }

  function renderModelSettings() {
    const availableModels = models.length ? models : [{ modelId: DEFAULT_MODEL, language: "english", installed: false, verified: false, bytes: 0, failureCode: "" }];
    return (
      <div className="settings-panel-content">
        <header><h2>AI models</h2><p>Verified local assets only</p></header>
        <section className="settings-group"><div className="settings-row-title"><div><strong>Transcription model</strong><span>{asBool(transcriptionStatus.whisperFeatureEnabled) ? "Local Whisper enabled" : "Feature gated"}</span></div><div className="settings-actions"><button type="button" onClick={() => void verifyModel()} disabled={Boolean(busy)}>Verify</button><button type="button" onClick={() => void importModel()} disabled={Boolean(busy)}>Import</button></div></div><div className="model-choice-list">{availableModels.slice(0, 6).map((model) => <button type="button" key={model.modelId} aria-pressed={selectedModel === model.modelId} onClick={() => setSelectedModel(model.modelId)}><span><strong>{model.modelId}</strong><small>{model.language}</small></span><em>{model.verified ? "Verified" : model.installed ? "Needs check" : "Missing"}</em></button>)}</div></section>
        <section className="settings-group"><div className="settings-row-title"><div><strong>Generation mode</strong><span id="local-ai-mode-status-settings">{aiModeStatus}</span></div><div className="segmented-control" role="group" aria-label="Settings local AI mode"><button type="button" aria-pressed={aiMode === "quality"} onClick={() => setAiMode("quality")}>Quality</button><button type="button" aria-pressed={aiMode === "fast"} onClick={() => setAiMode("fast")}>Fast</button></div></div></section>
        <details className="instruct-setup" open={instructSetupOpen} onToggle={(event) => setInstructSetupOpen(event.currentTarget.open)}>
          <summary><span><strong>Managed local instruct assets</strong><em>{instructAssetsReady ? "Ready" : "Needs assets"}</em></span></summary>
          <div className="instruct-setup-body">
            <dl className="asset-status-list" aria-label="Managed local AI assets"><div><dt>Runner</dt><dd className={asBool(instructRunnerAsset.verified) ? "ok" : ""}>{asBool(instructRunnerAsset.verified) ? `Verified, ${formatBytes(asNumber(instructRunnerAsset.bytes))}` : "Missing"}</dd></div><div><dt>GGUF model</dt><dd className={asBool(instructModelAsset.verified) ? "ok" : ""}>{asBool(instructModelAsset.verified) ? `Verified, ${formatBytes(asNumber(instructModelAsset.bytes))}` : "Missing"}</dd></div></dl>
            <div className="segmented-control asset-kind-control" role="group" aria-label="Local AI asset type"><button type="button" aria-pressed={instructAssetKind === "runner"} onClick={() => { setInstructAssetKind("runner"); setInstructAssetError(""); }}>Runner</button><button type="button" aria-pressed={instructAssetKind === "model"} onClick={() => { setInstructAssetKind("model"); setInstructAssetError(""); }}>Model</button></div>
            <label className="asset-hash-field" htmlFor="instruct-asset-sha256"><span>Expected SHA-256</span><input id="instruct-asset-sha256" value={instructExpectedSha256} onChange={(event) => { setInstructExpectedSha256(event.target.value); setInstructAssetError(""); }} aria-invalid={Boolean(instructAssetError)} aria-describedby="instruct-asset-sha256-status" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="64 hexadecimal characters" /><small id="instruct-asset-sha256-status" className={instructAssetError ? "asset-hash-error" : ""} role={instructAssetError ? "alert" : undefined}>{instructAssetError || "Required before local copy"}</small></label>
            <button type="button" className="secondary-button full-width" onClick={() => void importInstructAsset()} disabled={Boolean(busy)}>{busy === "instruct-asset" ? "Verifying..." : `Import ${instructAssetKind === "runner" ? "runner" : "model"}`}</button>
          </div>
        </details>
      </div>
    );
  }

  function renderLicenseSettings() {
    const portalActions = asArray(licensePortalInfo.actions).map((item) => asObject(item));
    return (
      <div className="settings-panel-content">
        <header><h2>License Portal</h2><p>Optional ownership tools. Sign-in is not required for normal app use.</p></header>
        <section className="settings-group">
          <div className="settings-row-title"><div><strong>{metric(licenseStatus.planName, "Candor Professional")}</strong><span>{licenseActive ? "Activated or trialing locally" : "No local activation"}</span></div><div className="settings-actions"><button type="button" onClick={() => void refreshLicense()} disabled={Boolean(busy)}>Refresh</button><button type="button" onClick={() => void deactivateLicense()} disabled={Boolean(busy) || !licenseActive}>Deactivate device</button></div></div>
          <dl className="settings-facts license-facts"><div><dt>Status</dt><dd>{metric(licenseStatus.state, "inactive")}</dd></div><div><dt>License ID</dt><dd>{metric(licenseStatus.licenseId, "Not activated")}</dd></div><div><dt>Device</dt><dd>{metric(licenseStatus.deviceLabel, "This device")}</dd></div><div><dt>Secure storage</dt><dd>{asBool(licenseStatus.secureStorageAvailable) ? "Available" : "Metadata only"}</dd></div><div><dt>Account required</dt><dd>No</dd></div><div><dt>Portal</dt><dd>{asBool(licensePortalInfo.available) ? "Available" : "Production pending"}</dd></div></dl>
        </section>
        <section className="settings-group">
          <h3>Portal actions</h3>
          <div className="portal-action-list">
            {portalActions.map((action) => <article key={asString(action.id)}><span className={asBool(action.enabled) ? "status-dot ok" : "status-dot"} /><div><strong>{asString(action.label)}</strong><small>{asString(action.note)}</small></div></article>)}
          </div>
        </section>
      </div>
    );
  }

  function renderSettingsPanel() {
    if (settingsSection === "models") return renderModelSettings();
    if (settingsSection === "license") return renderLicenseSettings();
    if (settingsSection === "recording") return <div className="settings-panel-content"><header><h2>Recording</h2><p>Explicit local capture consent</p></header><section className="settings-group"><div className="consent-grid">{asArray(consentStatus.items).map((item) => { const object = asObject(item); return <article key={asString(object.id)}><span className={asBool(object.acknowledged) ? "status-dot ok" : "status-dot"} /><div><strong>{asString(object.label)}</strong><small>{asBool(object.acknowledged) ? "Acknowledged locally" : "Required"}</small></div></article>; })}</div><div className="settings-actions"><button type="button" onClick={() => void acknowledgeMicConsent()} disabled={Boolean(busy)}>Acknowledge microphone</button><button type="button" onClick={() => void acknowledgeSystemConsent()} disabled={Boolean(busy)}>Acknowledge system audio</button></div></section><section className="settings-group"><h3>Capture sources</h3><dl className="settings-facts"><div><dt>Microphone</dt><dd>{asBool(asObject(asObject(captureStatus.sources).microphone).implemented) ? "Available" : "Unavailable"}</dd></div><div><dt>System audio</dt><dd>{asBool(asObject(asObject(captureStatus.sources).system).implemented) ? "Available" : "Unavailable"}</dd></div><div><dt>Combined</dt><dd>{combinedCaptureAvailable ? "Available" : "Unavailable"}</dd></div></dl><div className="settings-actions"><button type="button" onClick={() => void startSystemRecording()} disabled={Boolean(busy) || activeCapture}>Record system audio</button><button type="button" onClick={() => void startMicAndSystemRecording()} disabled={Boolean(busy) || activeCapture || !combinedCaptureAvailable}>Record both</button></div></section></div>;
    if (settingsSection === "privacy") return <div className="settings-panel-content" aria-label="Local custody"><header><h2>Privacy</h2><p>Facts reported by the local core</p></header><dl className="settings-facts privacy-facts">{custodyItems.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></div>;
    if (settingsSection === "export") return <div className="settings-panel-content"><header><h2>Export</h2><p>Local files only</p></header><dl className="settings-facts"><div><dt>Markdown</dt><dd>Available locally</dd></div><div><dt>WAV</dt><dd>Available locally</dd></div><div><dt>Word</dt><dd>Editable, local</dd></div><div><dt>PDF</dt><dd>Searchable, local</dd></div><div><dt>Public links</dt><dd>Unavailable</dd></div></dl><button className="primary-button" type="button" onClick={() => setView("export")}>Open export flow</button></div>;
    return <div className="settings-panel-content"><header><h2>General</h2><p>Local desktop configuration</p></header><dl className="settings-facts"><div><dt>Core transport</dt><dd>{metric(coreStatus.sidecarTransport, "stdio-json-lines")}</dd></div><div><dt>Vault</dt><dd>{metric(vaultStatus.backend, "SQLCipher")}</dd></div><div><dt>Update policy</dt><dd>{metric(updateStatus.policy, "manual-check-only")}</dd></div><div><dt>Retention</dt><dd>{metric(retentionStatus.policy, "manual-delete-only")}</dd></div></dl><button type="button" className="secondary-button" onClick={() => void refresh()} disabled={Boolean(busy)}>Refresh local status</button></div>;
  }

  function renderSettings() {
    const sections: Array<[SettingsSection, string]> = [["general", "General"], ["recording", "Recording"], ["models", "AI models"], ["privacy", "Privacy"], ["export", "Export"], ["license", "License Portal"]];
    return <section className="page-view" data-view="settings"><header className="screen-heading"><h1>Settings</h1><p>Local controls and verified assets</p></header><div className="settings-layout"><nav aria-label="Settings sections">{sections.map(([id, label]) => <button type="button" aria-current={settingsSection === id ? "page" : undefined} key={id} onClick={() => setSettingsSection(id)}>{label}</button>)}</nav><section className="settings-panel">{renderSettingsPanel()}</section></div></section>;
  }

  function toggleExportSection(key: keyof typeof exportSections) {
    setExportSections((current) => ({ ...current, [key]: !current[key] }));
  }

  function renderExport() {
    const previewDecisions = exportSections.decisions ? reviewedItems(recap?.decisions ?? []) : [];
    const previewActions = exportSections.actions ? reviewedItems(recap?.actions ?? []) : [];
    const previewRisks = exportSections.risks ? reviewedItems(recap?.risks ?? []) : [];
    const previewQuestions = exportSections.questions ? reviewedItems(recap?.questions ?? []) : [];
    return (
      <section className="page-view export-view" data-view="export">
        <header className="screen-heading"><h1>Export Meeting</h1><p>Prepare a report without sending data off this device.</p></header>
        <div className="export-dialog-surface">
          <div className="export-options">
            <header><h2>Export meeting</h2><p>Current local renderer: {exportFormatLabel(exportFormat)}</p></header>
            <fieldset><legend>Format</legend><div className="format-options"><button type="button" aria-pressed={exportFormat === "docx"} onClick={() => setExportFormat("docx")}>Word (.docx)<small>Editable</small></button><button type="button" aria-pressed={exportFormat === "pdf"} onClick={() => setExportFormat("pdf")}>PDF<small>Searchable</small></button><button type="button" aria-pressed={exportFormat === "markdown"} onClick={() => setExportFormat("markdown")}>Markdown<small>Plain text</small></button></div></fieldset>
            <fieldset><legend>Paper size</legend><div className="segmented-control paper-size-control" role="group" aria-label="Paper size"><button type="button" aria-pressed={exportPaperSize === "letter"} onClick={() => setExportPaperSize("letter")}>Letter</button><button type="button" aria-pressed={exportPaperSize === "a4"} onClick={() => setExportPaperSize("a4")}>A4</button></div></fieldset>
            <fieldset><legend>Include sections</legend><label><input type="checkbox" checked={exportSections.summary} onChange={() => toggleExportSection("summary")} /> Executive summary</label><label><input type="checkbox" checked={exportSections.decisions} onChange={() => toggleExportSection("decisions")} /> Decisions</label><label><input type="checkbox" checked={exportSections.actions} onChange={() => toggleExportSection("actions")} /> Action items</label><label><input type="checkbox" checked={exportSections.risks} onChange={() => toggleExportSection("risks")} /> Risks</label><label><input type="checkbox" checked={exportSections.questions} onChange={() => toggleExportSection("questions")} /> Open questions</label><label><input type="checkbox" checked={exportSections.notes} onChange={() => toggleExportSection("notes")} /> Manual notes</label><label><input type="checkbox" checked={exportSections.transcript} onChange={() => toggleExportSection("transcript")} /> Full transcript</label><label><input type="checkbox" checked={exportSections.timestamps} onChange={() => toggleExportSection("timestamps")} /> Audio timestamps</label></fieldset>
            <div className="export-actions"><button type="button" className="secondary-button" onClick={() => setView("review")}>Back to review</button><button type="button" className="primary-button" data-export-save onClick={() => void saveLocalReport()} disabled={!selectedRecordingId || Boolean(busy)}>{busy === "export" ? "Saving..." : exportActionLabel(exportFormat)}</button></div>
          </div>
          <div className="export-preview-wrap"><div className="export-preview-heading"><strong>Report preview</strong><span>{exportFormatLabel(exportFormat)} / {exportPaperSize === "letter" ? "Letter" : "A4"} / Local</span></div><DocumentPreview title={selectedTitle} summary={reviewSummaryDraft || recap?.summary || ""} decisions={previewDecisions} actions={previewActions} risks={previewRisks} questions={previewQuestions} includeSummary={exportSections.summary} includeNotes={exportSections.notes} includeTranscript={exportSections.transcript} /></div>
        </div>
        {exportFormat === "markdown" && markdownExport ? <details className="markdown-output"><summary>Saved Markdown</summary><pre>{markdownExport}</pre></details> : null}
      </section>
    );
  }

  function renderProof() {
    return <section className="page-view" data-view="proof" aria-label="Local custody"><header className="screen-heading"><h1>Local Custody</h1><p>Queryable facts from candor-core</p></header><div className="proof-grid"><section><h2>Custody facts</h2><dl className="settings-facts privacy-facts">{custodyItems.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></section><section><h2>Boundary</h2><dl className="settings-facts"><div><dt>Allowed RPCs</dt><dd>{asArray(capabilities.allowedMethods).length}</dd></div><div><dt>Denied capabilities</dt><dd>{asArray(capabilities.deniedCapabilities).length}</dd></div><div><dt>External attempts</dt><dd>{metric(privacyAudit.externalCallsAttempted, "0")}</dd></div><div><dt>Background downloads</dt><dd>{asBool(instructAssetsStatus.backgroundDownloads) ? "On" : "Off"}</dd></div><div><dt>Managed paths exposed</dt><dd>{asBool(instructAssetsStatus.managedPathExposed) ? "Yes" : "No"}</dd></div></dl></section></div></section>;
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

  const navigation: Array<[AppView, string]> = [["home", "Home"], ["meeting", "Live meeting"], ["library", "Recording library"], ["detail", "Meeting summary"], ["review", "Review mode"], ["export", "Local export"], ["settings", "Settings"], ["proof", "Custody proof"]];
  const openTabs = openMeetingIds.map((id) => recordings.find((recording) => recording.recordingId === id)).filter((recording): recording is RecordingSummary => Boolean(recording));

  return (
    <main className="candor-desktop">
      <header className="session-rail">
        <button className="wordmark" type="button" onClick={() => setView("home")}><img src="./candor-mark.png" width="28" height="28" alt="" aria-hidden="true" /><span>Candor</span></button>
        <div className="session-tabs" role="tablist" aria-label="Open meetings">
          {openTabs.length ? openTabs.map((recording) => <div className="session-tab" key={recording.recordingId} data-active={selectedRecordingId === recording.recordingId}><button type="button" role="tab" aria-selected={selectedRecordingId === recording.recordingId} onClick={() => void openRecording(recording.recordingId, "meeting")}><span className="tab-dot" />{recording.label}</button><button className="tab-close" type="button" aria-label={`Close ${recording.label}`} title="Close meeting tab" onClick={() => closeMeetingTab(recording.recordingId)}>x</button></div>) : <div className="session-tab placeholder" data-active="true"><button type="button" role="tab" aria-selected="true" onClick={() => setView("meeting")}><span className="tab-dot" />New local meeting</button></div>}
        </div>
        <span className="local-only-status"><span className="status-dot ok" />Local only</span>
      </header>
      <div className="desktop-body">
        <aside className="desktop-sidebar" aria-label="Candor navigation">
          <RecordAction
            variant="sidebar"
            active={activeCapture}
            captureLabel={combinedCaptureAvailable ? "Mic + system audio" : "Microphone audio"}
            onClick={() => void startPreferredRecording()}
            disabled={Boolean(busy)}
          />
          <nav className="desktop-nav" aria-label="Primary">{navigation.map(([id, label], index) => <React.Fragment key={id}>{index === 0 ? <span>WORKSPACE</span> : index === 4 ? <span>REPORT</span> : index === 6 ? <span>LOCAL CONTROLS</span> : null}<button type="button" aria-current={view === id ? "page" : undefined} onClick={() => setView(id)} disabled={(id === "detail" || id === "review" || id === "export") && !selectedRecordingId}>{label}</button></React.Fragment>)}</nav>
          <footer><strong><span className="status-dot ok" />Local processing active</strong><span>No meeting data leaves this device</span></footer>
        </aside>
        <section className="desktop-content">
          <div className="message-stack" aria-live="polite">
            {notice ? <div className="app-message success" role="status"><span>{notice}</span><button type="button" aria-label="Dismiss notification" title="Dismiss" onClick={() => setNotice("")}>x</button></div> : null}
            {error ? <div className="app-message error" role="alert"><span>{error}</span><button type="button" aria-label="Dismiss error" title="Dismiss" onClick={() => setError("")}>x</button></div> : null}
          </div>
          {renderCurrentView()}
        </section>
      </div>
    </main>
  );
}
