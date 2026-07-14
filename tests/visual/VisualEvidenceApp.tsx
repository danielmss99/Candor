import { useEffect, useState, type ReactNode } from "react";
import { DesktopShell } from "../../v3/renderer/src/components/DesktopShell";
import { EmptyState } from "../../v3/renderer/src/components/EmptyState";
import {
  type AppView,
  type BundledAiStatus,
  type MeetingPrivacyReceipt,
  type NetworkCapabilities,
  type PersistentAlert,
  type RecapItem,
  type RecordingSummary,
  type TerminologyStatus,
  type TranscriptionQualityStatus,
} from "../../v3/renderer/src/core/contracts";
import { MeetingDetailView } from "../../v3/renderer/src/features/detail/MeetingDetailView";
import { ExportView, type ExportSectionState } from "../../v3/renderer/src/features/export/ExportView";
import { HomeView } from "../../v3/renderer/src/features/home/HomeView";
import { LibraryView } from "../../v3/renderer/src/features/library/LibraryView";
import { LiveMeetingView } from "../../v3/renderer/src/features/meeting/LiveMeetingView";
import { ReviewView } from "../../v3/renderer/src/features/review/ReviewView";
import { SettingsView } from "../../v3/renderer/src/features/settings/SettingsView";
import { StartupRecovery } from "../../v3/renderer/src/features/startup/StartupState";
import { AnimatedTranscript, type MotionTranscriptSegment } from "../../v3/renderer/src/meeting-motion";

export const VISUAL_SCENARIOS = [
  "home-empty",
  "home-populated",
  "live-recording",
  "live-finalizing",
  "live-low-disk",
  "live-degraded-core",
  "meetings-1000",
  "meeting-no-transcript",
  "meeting-long-transcript",
  "review-desktop",
  "review-compact",
  "export-default",
  "export-failed",
  "settings-normal",
  "settings-advanced",
  "settings-local-ai-ready",
  "settings-local-ai-checking",
  "settings-local-ai-repair",
  "core-unavailable",
  "core-incompatible",
  "permission-denied",
  "model-unavailable",
  "license-expired-existing-data",
] as const;

export type VisualScenario = (typeof VISUAL_SCENARIOS)[number];

const noop = () => undefined;
const now = Date.UTC(2026, 6, 13, 15, 30);
const bundledAiReady: BundledAiStatus = {
  releaseReady: true,
  fixture: false,
  selectionStatus: "release-selected",
  state: "ready",
  ready: true,
  repairRequired: false,
  repairPolicy: "signed-installer-only",
  repairAction: "none",
  speech: { state: "ready", ready: true, available: true, requiredAssets: 1, verifiedAssets: 1, modelId: "base.en", failureCode: null },
  language: { state: "ready", ready: true, available: true, requiredAssets: 2, verifiedAssets: 2, modelId: "candor-local", failureCode: null },
};

const transcriptionQuality: TranscriptionQualityStatus = {
  state: "ready",
  tier: "balanced",
  languagePreference: "english",
  recommendedTier: "balanced",
  benchmarkState: "measured",
  benchmarkFailureTier: null,
  estimatedRealTimeFactor: null,
  estimatedMinutesPerHour: 15,
  estimatedCompletionAvailable: true,
  fallbackApplied: false,
  guardReason: null,
  tiers: [
    { id: "fast", label: "Fast", available: true, recommended: false, guardReason: null },
    { id: "balanced", label: "Balanced", available: true, recommended: true, guardReason: null },
    { id: "maximum", label: "Maximum accuracy", available: false, recommended: false, guardReason: "maximum-requires-passing-local-benchmark" },
  ],
};

const terminologyStatus: TerminologyStatus = {
  state: "ready",
  dictionaryCount: 1,
  entryCount: 1842,
  encryptedAtRest: true,
  dictionaries: [{ dictionaryId: "pharmaceutics", name: "Pharmaceutics", entryCount: 1842, enabled: true, assignedToMeeting: true }],
};

const allMeetings: RecordingSummary[] = Array.from({ length: 1_000 }, (_, index) => ({
  recordingId: `meeting-${index + 1}`,
  label: index === 0 ? "Product Strategy Sync" : `Local meeting ${String(index + 1).padStart(4, "0")}`,
  state: "finished",
  audioDurationMs: 1_500_000 + index * 1_000,
  audioChunkCount: 50 + (index % 12),
  transcriptSegmentCount: 24 + (index % 80),
  updatedAtMs: now - index * 60_000,
}));

const primaryMeeting = allMeetings[0];

const transcriptSegments: MotionTranscriptSegment[] = [
  { id: "segment-1", speaker: "Alex Morgan", startMs: 2_000, channel: "microphone", text: "We will keep the report editable and stored on this computer." },
  { id: "segment-2", speaker: "Priya Mehta", startMs: 8_000, channel: "system audio", text: "The desktop workflow should remain clear with keyboard navigation." },
  { id: "segment-3", speaker: "Daniel Moss", startMs: 15_000, channel: "microphone", text: "The transcript and notes need to remain visible together during the meeting." },
  { id: "segment-4", speaker: "Alex Morgan", startMs: 23_000, channel: "system audio", text: "Decision: use the local review step before exporting the final report." },
  { id: "segment-5", speaker: "Priya Mehta", startMs: 31_000, channel: "system audio", text: "Action: validate the recovery state before the beta candidate." },
];

const longTranscript = Array.from({ length: 80 }, (_, index): MotionTranscriptSegment => ({
  id: `long-segment-${index}`,
  speaker: ["Alex Morgan", "Priya Mehta", "Daniel Moss"][index % 3],
  startMs: index * 9_000,
  channel: index % 3 === 1 ? "system audio" : "microphone",
  text: `Transcript segment ${index + 1} preserves a readable local record with enough content to verify long scrolling behavior.`,
}));

function recapItem(category: string, text: string, segmentIndex: number): RecapItem {
  return {
    category,
    text,
    speaker: segmentIndex % 2 ? "Priya Mehta" : "Alex Morgan",
    channel: segmentIndex % 2 ? "system" : "mic",
    startMs: segmentIndex * 7_000,
    segmentIndex,
    quote: text,
  };
}

const decisions = [recapItem("Decision", "Keep the report editable and local.", 1), recapItem("Decision", "Review every summary before export.", 4)];
const actions = [recapItem("Action", "Validate keyboard access on the desktop workflow.", 2), recapItem("Action", "Run the recovery matrix before beta.", 5)];
const risks = [recapItem("Risk", "A disconnected capture service must not hide the Stop action.", 6)];
const questions = [recapItem("Question", "Which speech model should be the default for first run?", 7)];
const recap = {
  engine: "local",
  summary: "The team aligned on an editable local report, a clear review step, and recovery validation before beta.",
  markdown: "## Summary\nLocal report and recovery validation.",
  decisions,
  actions,
  risks,
  questions,
  citations: [...decisions, ...actions],
};

const network: NetworkCapabilities = {
  policy: "local-only",
  externalCallsAttempted: 0,
  capabilities: [
    { id: "recording", label: "Recording", mode: "denied", trigger: "never", owner: "core" },
    { id: "local-ai", label: "Local AI", mode: "local-only", trigger: "user", owner: "core" },
  ],
};

const receipt: MeetingPrivacyReceipt = {
  proofKind: "meeting-privacy-receipt",
  receiptVersion: 1,
  generatedAtMs: now,
  recording: { recordingId: primaryMeeting.recordingId, label: primaryMeeting.label, state: "finished", createdAtMs: now - 3_600_000, updatedAtMs: now, deletionStatus: "present" },
  capture: { channels: ["mic", "system"], audioChunkCount: 62, channelAttribution: true },
  storage: { rootKind: "local-user-data", encryptedAudioChunkCount: 62, allAudioEncrypted: true, cipher: "protected local storage" },
  content: { transcriptSegmentCount: 80, notesSavedLocally: true },
  processing: [],
  exports: [],
  retention: { policy: "manual-delete-only", automaticDeletion: false },
  network,
};

const exportSections: ExportSectionState = {
  summary: true,
  decisions: true,
  actions: true,
  risks: true,
  questions: true,
  notes: true,
  transcript: false,
  timestamps: true,
};

function scenarioFromHash(): VisualScenario {
  const requested = new URLSearchParams(window.location.hash.slice(1)).get("scenario");
  return VISUAL_SCENARIOS.includes(requested as VisualScenario) ? requested as VisualScenario : "home-empty";
}

function Transcript({ long = false, empty = false }: { long?: boolean; empty?: boolean }) {
  return <AnimatedTranscript segments={empty ? [] : long ? longTranscript : transcriptSegments} emptyMessage="No transcript yet. Start local transcription when audio is ready." />;
}

interface ShellProps {
  view: AppView;
  children: ReactNode;
  activeCapture?: boolean;
  alerts?: PersistentAlert[];
  error?: string;
  recordings?: RecordingSummary[];
}

function Shell({ view, children, activeCapture = false, alerts = [], error = "", recordings = allMeetings.slice(0, 12) }: ShellProps) {
  return (
    <DesktopShell
      view={view}
      recordings={recordings}
      openMeetingIds={recordings.length ? [recordings[0].recordingId] : []}
      selectedRecordingId={recordings[0]?.recordingId ?? ""}
      activeCapture={activeCapture}
      combinedCaptureAvailable
      busy={false}
      notice=""
      error={error}
      persistentAlerts={alerts}
      onHome={noop}
      onStartRecording={noop}
      onNavigate={noop}
      onOpenRecording={noop}
      onCloseMeeting={noop}
      onDismissNotice={noop}
      onDismissError={noop}
    >
      {children}
    </DesktopShell>
  );
}

function Home({ populated, storageLevel = "ok" }: { populated: boolean; storageLevel?: string }) {
  const recordings = populated ? allMeetings.slice(0, 4) : [];
  return (
    <HomeView
      recordings={recordings}
      activeCapture={false}
      combinedCaptureAvailable
      busy={false}
      recordingBlocked={storageLevel === "blocking"}
      storageHealth={{ level: storageLevel, availableBytes: 68 * 1024 ** 3 }}
      importAvailable
      recordingTitle="Product Strategy Sync"
      instructReady={populated}
      verifiedModelCount={populated ? 1 : 0}
      aiModeStatus={populated ? "Best local model" : "Fast local analysis"}
      onStartRecording={noop}
      onOpenLibrary={noop}
      onImport={noop}
      onRecordingTitleChange={noop}
      onOpenRecording={noop}
    />
  );
}

interface LiveOptions {
  active: boolean;
  busy?: boolean;
  consentReady?: boolean;
  label: string;
  jobLabel: string;
}

function Live({ active, busy = false, consentReady = true, label, jobLabel }: LiveOptions) {
  return (
    <LiveMeetingView
      title="Product Strategy Sync"
      selectedRecording={primaryMeeting}
      selectedRecordingId={primaryMeeting.recordingId}
      activeRecordingId={active ? primaryMeeting.recordingId : ""}
      activeCapture={active}
      consentReady={consentReady}
      durationMs={1_517_000}
      audioUrl=""
      markers={[{ id: "decision", timeMs: 23_000, label: "Decision", kind: "decision" }, { id: "action", timeMs: 31_000, label: "Action", kind: "action" }]}
      compactPane="transcript"
      notesPanelMode="notes"
      notesMarkdown={"- Keep reports editable\n- Validate recovery before beta"}
      notesDirty={false}
      notesSaved
      recapSuggestions={[...decisions, ...actions]}
      aiMode="quality"
      aiModeStatus="Best local model"
      captureStatusLabel={label}
      jobStatusLabel={jobLabel}
      busy={busy}
      transcriptContent={<Transcript />}
      onReview={noop}
      onReviewConsent={noop}
      onLoadAudio={noop}
      onMarkMoment={noop}
      onCompactPaneChange={noop}
      onNotesPanelModeChange={noop}
      onTranscribe={noop}
      onNotesChange={noop}
      onSaveNotes={noop}
      onGenerateRecap={noop}
      onAiModeChange={noop}
      onStartStop={noop}
    />
  );
}

function MeetingDetail({ long = false, empty = false }: { long?: boolean; empty?: boolean }) {
  return (
    <MeetingDetailView
      title="Product Strategy Sync"
      selectedRecording={primaryMeeting}
      selectedRecordingId={primaryMeeting.recordingId}
      detailSection={empty || long ? "transcript" : "summary"}
      transcriptContent={<Transcript long={long} empty={empty} />}
      transcriptTotalCount={empty ? 0 : long ? 80 : transcriptSegments.length}
      notesMarkdown="Keep the report editable and validate recovery."
      notesDirty={false}
      recap={empty ? null : recap}
      askQuestion=""
      askAnswer={null}
      aiModeStatus="Best local model"
      privacyReceipt={receipt}
      networkCapabilities={network}
      busy={false}
      onDetailSectionChange={noop}
      onReview={noop}
      onDelete={noop}
      onNotesChange={noop}
      onSaveNotes={noop}
      onGenerateRecap={noop}
      onAskQuestionChange={noop}
      onAsk={noop}
    />
  );
}

function Review() {
  return (
    <ReviewView
      title="Product Strategy Sync"
      reviewSection="summary"
      reviewStates={{ "decision-1": "accepted", "action-2": "accepted" }}
      summaryDraft={recap.summary}
      recap={recap}
      notesMarkdown="Keep the final report editable."
      notesDirty={false}
      transcriptContent={<Transcript />}
      exportFormat="docx"
      includeSummary
      includeNotes
      includeTranscript={false}
      previewDecisions={decisions}
      previewActions={actions}
      previewRisks={risks}
      previewQuestions={questions}
      selectedRecordingId={primaryMeeting.recordingId}
      busy={false}
      onSectionChange={noop}
      onSummaryDraftChange={noop}
      onNotesChange={noop}
      onSaveNotes={noop}
      onGenerateRecap={noop}
      onReviewItem={noop}
      onOpenExport={noop}
    />
  );
}

function Export() {
  return (
    <ExportView
      title="Product Strategy Sync"
      summary={recap.summary}
      format="docx"
      paperSize="letter"
      sections={exportSections}
      decisions={decisions}
      actions={actions}
      risks={risks}
      questions={questions}
      markdownExport=""
      canExport
      saving={false}
      onFormatChange={noop}
      onPaperSizeChange={noop}
      onToggleSection={noop}
      onBack={noop}
      onSave={noop}
    />
  );
}

function Settings({ advanced, repair = false, checking = false, localAi = false }: { advanced: boolean; repair?: boolean; checking?: boolean; localAi?: boolean }) {
  const baselineUnavailable = repair || checking;
  return (
    <SettingsView
      section={baselineUnavailable || localAi ? "models" : advanced ? "storage" : "general"}
      advancedOpen={advanced}
      busy=""
      activeCapture={false}
      combinedCaptureAvailable
      statuses={{
        core: { sidecarTransport: "local process" },
        consent: { items: [{ id: "mic", label: "Microphone", acknowledged: true }, { id: "system", label: "System audio", acknowledged: true }] },
        capture: { sources: { microphone: { implemented: true }, system: { implemented: true } } },
        vault: { encrypted: true, backend: "Protected local store" },
        updates: { backgroundChecks: false },
        retention: { policy: "manual-delete-only", automaticDeletion: false },
        transcription: { whisperFeatureEnabled: true },
      }}
      bundledAiStatus={checking ? {
        ...bundledAiReady,
        releaseReady: false,
        selectionStatus: "checking",
        state: "checking",
        ready: false,
        speech: { ...bundledAiReady.speech, state: "checking", ready: false, available: false, requiredAssets: 0, verifiedAssets: 0, modelId: null, failureCode: null },
        language: { ...bundledAiReady.language, state: "checking", ready: false, available: false, requiredAssets: 0, verifiedAssets: 0, modelId: null, failureCode: null },
      } : repair ? {
        ...bundledAiReady,
        releaseReady: false,
        state: "corrupt",
        ready: false,
        repairRequired: true,
        repairAction: "reinstall-candor",
        speech: { ...bundledAiReady.speech, state: "corrupt", ready: false, verifiedAssets: 0, failureCode: "BUNDLED_AI_ASSET_HASH_MISMATCH" },
      } : bundledAiReady}
      transcriptionQuality={transcriptionQuality}
      terminologyStatus={terminologyStatus}
      terminologyProposals={[]}
      selectedRecordingId={primaryMeeting.recordingId}
      models={baselineUnavailable ? [] : [{ modelId: "base.en", language: "English", installed: true, verified: true, bytes: 148_000_000, failureCode: "" }]}
      selectedModel="base.en"
      defaultModel="base.en"
      aiMode={baselineUnavailable ? "fast" : "quality"}
      aiModeStatus={baselineUnavailable ? "Fast local analysis" : "Best local model"}
      instructSetupOpen={false}
      instructReady={!baselineUnavailable}
      instructRunnerAsset={{ verified: !baselineUnavailable, bytes: baselineUnavailable ? 0 : 4_000_000 }}
      instructModelAsset={{ verified: !baselineUnavailable, bytes: baselineUnavailable ? 0 : 1_900_000_000 }}
      instructAssetKind="runner"
      instructExpectedSha256=""
      instructAssetError=""
      licenseStatus={{ planName: "Candor Professional", state: "active", deviceLabel: "This computer", secureStorageAvailable: true }}
      licensePortalInfo={{ available: false, actions: [] }}
      licenseActive
      privacyReceipt={receipt}
      networkCapabilities={network}
      custodyItems={[["Meeting data", "Stored on this device"], ["External calls", "0"]]}
      diagnosticPreview={null}
      onSectionChange={noop}
      onToggleAdvanced={noop}
      onVerifyModel={noop}
      onImportModel={noop}
      onSelectedModelChange={noop}
      onAiModeChange={noop}
      onTranscriptionQualityChange={noop}
      onImportDictionary={noop}
      onSetDictionaryEnabled={noop}
      onAssignDictionary={noop}
      onReviewTerminology={noop}
      onDecideTerminology={noop}
      onInstructSetupOpenChange={noop}
      onInstructAssetKindChange={noop}
      onInstructExpectedShaChange={noop}
      onImportInstructAsset={noop}
      onRefreshLicense={noop}
      onDeactivateLicense={noop}
      onAcknowledgeMic={noop}
      onAcknowledgeSystem={noop}
      onRecordSystem={noop}
      onRecordBoth={noop}
      onOpenExport={noop}
      onRefreshLocalSettings={noop}
      onPrepareDiagnostics={noop}
      onSaveDiagnostics={noop}
    />
  );
}

function Library({ total = 1_000 }: { total?: number }) {
  const page = allMeetings.slice(0, 50);
  return (
    <LibraryView
      recordings={page}
      filteredRecordings={page}
      recordingTotalCount={total}
      recordingsHaveMore={total > page.length}
      searchQuery=""
      searchMatches={[]}
      libraryFilter="all"
      busy={false}
      recordingBlocked={false}
      onSearchQueryChange={noop}
      onSearch={noop}
      onFilterChange={noop}
      onOpenRecording={noop}
      onStartRecording={noop}
      onLoadMore={noop}
    />
  );
}

function renderScenario(scenario: VisualScenario): ReactNode {
  if (scenario === "core-unavailable") return <StartupRecovery message="The local processing service did not start." retrying={false} onRetry={noop} />;
  if (scenario === "core-incompatible") return <StartupRecovery message="Protocol version mismatch. This local core is incompatible." retrying={false} onRetry={noop} />;
  if (scenario === "home-empty") return <Shell view="home" recordings={[]}><Home populated={false} /></Shell>;
  if (scenario === "home-populated") return <Shell view="home"><Home populated /></Shell>;
  if (scenario === "live-recording") return <Shell view="meeting" activeCapture><Live active label="Recording" jobLabel="Transcript ready" /></Shell>;
  if (scenario === "live-finalizing") return <Shell view="meeting" alerts={[{ id: "finalizing", severity: "info", title: "Finishing safely", message: "Candor is flushing the final local audio chunk. Keep the app open." }]}><Live active={false} busy label="Finalizing recording" jobLabel="Saving local audio" /></Shell>;
  if (scenario === "live-low-disk") return <Shell view="meeting" activeCapture alerts={[{ id: "low-disk", severity: "warning", title: "Storage is running low", message: "12 minutes of estimated recording time remain. Stop soon or free space." }]}><Live active label="Recording with low storage" jobLabel="Storage warning" /></Shell>;
  if (scenario === "live-degraded-core") return <Shell view="meeting" activeCapture alerts={[{ id: "degraded", severity: "error", title: "Recording connection interrupted", message: "Audio recovery information is preserved. Reconnect or stop the recording safely.", actions: [{ label: "Try to reconnect", primary: true, onActivate: noop }, { label: "Stop recording", onActivate: noop }] }]}><Live active label="Connection interrupted" jobLabel="Recovery available" /></Shell>;
  if (scenario === "meetings-1000") return <Shell view="library"><Library /></Shell>;
  if (scenario === "meeting-no-transcript") return <Shell view="detail"><MeetingDetail empty /></Shell>;
  if (scenario === "meeting-long-transcript") return <Shell view="detail"><MeetingDetail long /></Shell>;
  if (scenario === "review-desktop" || scenario === "review-compact") return <Shell view="review"><Review /></Shell>;
  if (scenario === "export-default") return <Shell view="export"><Export /></Shell>;
  if (scenario === "export-failed") return <Shell view="export" error="The report could not be saved. Choose another local folder and try again."><Export /></Shell>;
  if (scenario === "settings-normal") return <Shell view="settings"><Settings advanced={false} /></Shell>;
  if (scenario === "settings-advanced") return <Shell view="settings"><Settings advanced /></Shell>;
  if (scenario === "settings-local-ai-ready") return <Shell view="settings"><Settings advanced={false} localAi /></Shell>;
  if (scenario === "settings-local-ai-checking") return <Shell view="settings"><Settings advanced checking /></Shell>;
  if (scenario === "settings-local-ai-repair") return <Shell view="settings"><Settings advanced repair /></Shell>;
  if (scenario === "permission-denied") return <Shell view="meeting" alerts={[{ id: "permission", severity: "error", title: "Microphone permission denied", message: "Allow microphone access in system settings before starting a recording.", actions: [{ label: "Review recording settings", primary: true, onActivate: noop }] }]}><Live active={false} consentReady={false} label="Recording unavailable" jobLabel="Permission required" /></Shell>;
  if (scenario === "model-unavailable") return <Shell view="detail" alerts={[{ id: "model", severity: "warning", title: "Local transcription is not set up", message: "Choose a speech model in Advanced Settings. Existing audio and notes remain available." }]}><MeetingDetail /></Shell>;
  if (scenario === "license-expired-existing-data") return <Shell view="library" alerts={[{ id: "license", severity: "warning", title: "Trial ended", message: "New premium operations are paused. Existing meetings remain available to open, export, or delete." }]}><Library total={12} /></Shell>;
  return <Shell view="home"><EmptyState title="Visual state unavailable" description="The requested evidence state was not found." /></Shell>;
}

export function VisualEvidenceApp() {
  const [scenario, setScenario] = useState<VisualScenario>(scenarioFromHash);

  useEffect(() => {
    const update = () => setScenario(scenarioFromHash());
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);

  return <div className="visual-evidence-root" data-visual-scenario={scenario}>{renderScenario(scenario)}</div>;
}
