type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type CaptureStartCommon = {
  label?: string;
  chunkMs?: number;
  profileId?: string;
  profileVersion?: number;
};
type CaptureStartInput = CaptureStartCommon & (
  | { source: "microphone" }
  | { source: "system-audio"; deviceId?: string }
  | { source: "microphone-and-system-audio"; systemDeviceId?: string }
);

interface RendererCustody {
  rawPathExposed: false;
  keyMaterialExposedToRenderer: false;
}

interface JobAccepted {
  jobId: string;
  type: BackgroundTaskKind;
  state: "queued";
  createdAt: string;
  rawPathExposed: false;
  keyMaterialExposedToRenderer: false;
}

interface CancelAllJobsResult {
  cancelRequestedCount: number;
  requestedCount: number;
  skippedCount: number;
  rawPathExposed: false;
  keyMaterialExposedToRenderer: false;
}

type BackgroundTaskKind =
  | "transcription"
  | "transcript-cleanup"
  | "recap"
  | "ask"
  | "export"
  | "legacy-import"
  | "local-ai-benchmark"
  | "local-ai-component-import"
  | "speech-model-import"
  | "speech-model-verification"
  | "dictionary-import"
  | "dictionary-index";
type BackgroundTaskState = "queued" | "running" | "paused" | "cancelling" | "completed" | "failed" | "cancelled";
type BackgroundProgressUnit = "percent" | "seconds" | "chunks" | "bytes";
type AiExecutionMode = "local-llm" | "heuristic-fallback";
type AiFallbackPolicy = "allow-disclosed" | "require-local-llm";
type AiFallbackPreference = "ask-first" | "automatic" | "never";
type AiJobIntent = "default" | "strict-retry" | "explicit-heuristic";
type DesktopSetupStep = "license" | "microphone" | "shortcut" | "system-audio" | "storage" | "local-ai";

interface AiProvenance {
  engine: "local-llm" | "heuristic";
  modelId: string | null;
  modelSha256: string | null;
  runtimeSha256: string | null;
  fallbackUsed: boolean;
  fallbackReason?: "llm-unavailable" | "runtime-failed" | "model-corrupt" | "resource-policy" | "user-requested" | null;
  promptVersion: string;
  generatedAt: string;
}

interface ExportCreateInput {
  recordingId: string;
  format?: "markdown" | "docx" | "pdf" | "wav";
  channel?: string;
  report?: JsonValue;
  options?: JsonValue;
}

interface BackgroundTask {
  jobId: string;
  type: BackgroundTaskKind;
  state: BackgroundTaskState;
  createdAt: string;
  updatedAt: string;
  stage?: string | null;
  progress?: { completed: number; total?: number | null; unit: BackgroundProgressUnit } | null;
  estimatedRemainingMs?: number | null;
  recordingId?: string | null;
  parentJobId?: string | null;
  result?: JsonValue;
  resultAvailableAfterRestart?: boolean;
  error?: {
    code: string;
    title: string;
    message: string;
    retryable: boolean;
    severity: "error";
    correlationId: string;
    rawPathExposed: false;
  } | null;
  provenance?: AiProvenance | null;
  cancelRequested: boolean;
  retryCount: number;
  retryable: boolean;
  terminal: boolean;
  sourceDataPreserved: true;
  rawPathExposed: false;
  keyMaterialExposedToRenderer: false;
}

interface BackgroundTaskList {
  jobs: BackgroundTask[];
  activeCount: number;
  rawPathExposed: false;
  keyMaterialExposedToRenderer: false;
}

interface ShortcutTriggeredPayload {
  action: "show-and-focus-recorder";
  recordsAudio: false;
  localOnly: true;
  rawPathExposed: false;
  keyMaterialExposedToRenderer: false;
}

interface MeetingProfileInput {
  id?: string;
  expectedVersion?: number;
  name: string;
  captureSource: "microphone" | "system-audio" | "combined";
  language: string;
  localModelTier: "fast" | "balanced" | "maximum";
  speechModelId?: string;
  cleanupModelId?: string;
  summaryModelId?: string;
  dictionaryIds: string[];
  replacementRuleSetId: string | null;
  recapTemplate: string;
  liveTranscription: boolean;
}

interface ReplacementRuleInput {
  id: string;
  order: number;
  matchMode: "exact" | "whole-word";
  literal: string;
  replacement: string;
  protectedTermReview: boolean;
  enabled: boolean;
}

interface LiveTranscriptPartialPayload {
  event: "transcript.partial";
  schemaVersion: 1;
  recordingId: string;
  sequence: number;
  provisional: true;
  isFinal: false;
  startMs: number;
  endMs: number;
  text: string;
  segmentCount: number;
  localOnly: true;
  networkAttempted: false;
  rawPathExposed: false;
  keyMaterialExposedToRenderer: false;
}

type LocalModelCapability = "speech" | "text-processing";
type LocalModelReleaseState = "ready" | "manual-only" | "release-gated";

interface LocalModelCatalogEntry {
  modelId: string;
  displayName: string;
  capability: LocalModelCapability;
  engine: string;
  publisher: string;
  distributionSource: string;
  revision: string;
  expectedSha256: string | null;
  bytes: number | null;
  licenseExpression: string;
  languages: string[];
  hardware: string;
  releaseState: LocalModelReleaseState;
  releaseNote: string;
  defaultEligible: boolean;
  downloadAvailable: boolean;
  installed: boolean;
  verified: boolean;
  urlExposed: false;
  rawPathExposed: false;
  keyMaterialExposedToRenderer: false;
}

interface LocalModelCatalog {
  schemaVersion: 1;
  localOnly: true;
  cloudModels: false;
  remoteCatalog: false;
  explicitDownloadsOnly: true;
  activeDownloadModelId: string | null;
  recommendedDefaultModelId: string | null;
  models: LocalModelCatalogEntry[];
  rawPathExposed: false;
  keyMaterialExposedToRenderer: false;
}

interface ModelDownloadProgressPayload {
  modelId: string;
  state: "downloading" | "verifying" | "verification-queued" | "canceled" | "failed";
  bytesReceived: number;
  totalBytes: number;
  rawPathExposed: false;
  keyMaterialExposedToRenderer: false;
}

interface CandorMediaImportStatus {
  implemented: boolean;
  supportedContainers: string[];
  nativeImportReady: string[];
  decoderUnavailable: string[];
  pickerOwnedByMainProcess: boolean;
  rendererPathAccepted: false;
  localOnly: true;
  networkAttempted: false;
  rawPathExposed: false;
  keyMaterialExposedToRenderer: false;
}

interface CandorMediaImportResult {
  canceled: boolean;
  imported: boolean;
  failureCode: string | null;
  recordingId: string | null;
  jobId: string | null;
  localOnly: true;
  networkAttempted: false;
  rawPathExposed: false;
  keyMaterialExposedToRenderer: false;
}

interface CandorApiV4Definition {
  version: 4;
  app: {
    getStatus(): Promise<JsonValue>;
    getConnectionStatus(): Promise<JsonValue>;
    getVersion(): Promise<JsonValue>;
    getCapabilities(): Promise<JsonValue>;
    retryCore(): Promise<JsonValue>;
    listJobs(): Promise<BackgroundTaskList & { jobCount: number }>;
    getActiveJobs(): Promise<BackgroundTaskList>;
    getJob(jobId: string): Promise<BackgroundTask>;
    cancelJob(jobId: string): Promise<JsonValue>;
    cancelAllJobs(): Promise<CancelAllJobsResult>;
    retryJob(jobId: string): Promise<JobAccepted>;
    acknowledgeJob(jobId: string): Promise<JsonValue>;
    prepareDiagnostics(): Promise<JsonValue>;
    saveDiagnostics(): Promise<JsonValue>;
  };
  capture: {
    getStatus(): Promise<JsonValue>;
    getDevices(): Promise<JsonValue>;
    getPreferences(): Promise<JsonValue>;
    setPreferredMicrophone(input: { deviceId: string; fingerprint?: string; ordinal?: number }): Promise<JsonValue>;
    startMicTest(): Promise<JsonValue>;
    getMicTestStatus(): Promise<JsonValue>;
    getMicTestSample(): Promise<JsonValue>;
    stopMicTest(): Promise<JsonValue>;
    openMicrophoneSettings(): Promise<JsonValue>;
    getConsent(): Promise<JsonValue>;
    acknowledgeConsent(items: string[]): Promise<JsonValue>;
    start(input: CaptureStartInput): Promise<JsonValue>;
    stop(): Promise<JsonValue>;
    recover(): Promise<JsonValue>;
  };
  meetings: {
    getStorageStatus(): Promise<JsonValue>;
    list(offset?: number, limit?: number): Promise<JsonValue>;
    get(recordingId: string): Promise<JsonValue>;
    getReplayManifest(recordingId: string): Promise<JsonValue>;
    getTranscript(recordingId: string, offset?: number, limit?: number): Promise<JsonValue>;
    getTrustHistory(recordingId: string): Promise<JsonValue>;
    getTranscriptRevision(recordingId: string, revisionId: string): Promise<JsonValue>;
    selectTranscriptRevision(recordingId: string, revisionId: string): Promise<JsonValue>;
    getProtectedTermReview(recordingId: string): Promise<JsonValue>;
    applyProtectedTermReview(
      recordingId: string,
      revisionId: string,
      previewToken: string,
    ): Promise<JsonValue>;
    getPrivacyReceipt(recordingId: string): Promise<JsonValue>;
    readAudioChunk(recordingId: string, index: number): Promise<JsonValue>;
    search(query: string): Promise<JsonValue>;
    delete(recordingId: string): Promise<JsonValue>;
    getNotes(recordingId: string): Promise<JsonValue>;
    updateNotes(recordingId: string, markdown: string): Promise<JsonValue>;
    getMediaImportStatus(): Promise<CandorMediaImportStatus>;
    importMedia(): Promise<CandorMediaImportResult>;
    getImportStatus(): Promise<JsonValue>;
    importLegacy(): Promise<JsonValue>;
  };
  transcript: {
    getStatus(): Promise<JsonValue>;
    getQuality(): Promise<JsonValue>;
    setQuality(input: { tier: "fast" | "balanced" | "maximum"; languagePreference?: "english" | "multilingual" }): Promise<JsonValue>;
    startQualityBenchmark(input: { tier: "balanced" | "maximum" }): Promise<JobAccepted>;
    start(input: { recordingId: string; channel?: string; modelId?: string }): Promise<JobAccepted>;
    reprocess(input: { recordingId: string; channel?: string; modelId?: string }): Promise<JobAccepted>;
    cancel(jobId: string): Promise<JsonValue>;
  };
  liveTranscript: {
    enable(recordingId: string): Promise<JsonValue>;
    start(recordingId: string): Promise<JsonValue>;
    snapshot(recordingId: string): Promise<JsonValue>;
    clear(recordingId: string): Promise<JsonValue>;
    stop(recordingId: string): Promise<JsonValue>;
    eventsDrain(): Promise<JsonValue>;
  };
  diarization: {
    getStatus(): Promise<JsonValue>;
    setEnabled(enabled: boolean): Promise<JsonValue>;
    getSpeakerNames(recordingId: string): Promise<JsonValue>;
    assignSpeakerName(
      recordingId: string,
      anonymousSpeakerId: string,
      displayName: string,
    ): Promise<JsonValue>;
    removeSpeakerName(recordingId: string, anonymousSpeakerId: string): Promise<JsonValue>;
  };
  terminology: {
    getStatus(recordingId?: string): Promise<JsonValue>;
    importDictionary(): Promise<JsonValue>;
    setEnabled(dictionaryId: string, enabled: boolean): Promise<JsonValue>;
    assignToMeeting(recordingId: string, dictionaryId: string, enabled: boolean): Promise<JsonValue>;
    getCorrectionProposals(recordingId: string): Promise<JsonValue>;
    decideCorrection(
      recordingId: string,
      proposalId: string,
      decision: "accepted" | "rejected",
    ): Promise<JsonValue>;
  };
  profiles: {
    list(): Promise<JsonValue>;
    get(id: string): Promise<JsonValue>;
    upsert(input: MeetingProfileInput): Promise<JsonValue>;
    delete(id: string, expectedVersion: number): Promise<JsonValue>;
    select(id: string): Promise<JsonValue>;
  };
  replacements: {
    list(): Promise<JsonValue>;
    get(id: string): Promise<JsonValue>;
    upsert(input: {
      id?: string;
      expectedVersion?: number;
      name: string;
      rules: ReplacementRuleInput[];
    }): Promise<JsonValue>;
    delete(id: string, expectedVersion: number): Promise<JsonValue>;
    preview(setId: string, input: string): Promise<JsonValue>;
    apply(input: {
      setId: string;
      input: string;
      previewToken: string;
      approveProtectedTerms?: boolean;
    }): Promise<JsonValue>;
  };
  ai: {
    getStatus(): Promise<JsonValue>;
    getBundledAssetsStatus(): Promise<JsonValue>;
    getEnhancedAssetsStatus(): Promise<JsonValue>;
    getEnhancedStatus(): Promise<JsonValue>;
    getFallbackPreference(): Promise<JsonValue>;
    setFallbackPreference(preference: AiFallbackPreference): Promise<JsonValue>;
    getWorkloadStatus(): Promise<JsonValue>;
    listSpeechModels(): Promise<JsonValue>;
    getModelCatalog(): Promise<LocalModelCatalog>;
    downloadModel(modelId: string): Promise<JobAccepted & { modelId: string; bytesReceived: number; expectedBytes: number; integrityVerifiedBeforeInstall: true }>;
    cancelModelDownload(modelId?: string): Promise<JsonValue>;
    verifySpeechModel(modelId?: string): Promise<JobAccepted>;
    chooseSpeechModel(modelId: string): Promise<JobAccepted | JsonValue>;
    chooseEnhancedComponent(input: { component: "engine" | "model"; expectedSha256: string }): Promise<JobAccepted | JsonValue>;
    cleanupTranscript(recordingId: string): Promise<JobAccepted>;
    generateRecap(input: { recordingId: string; intent?: AiJobIntent; recapTemplate?: string }): Promise<JobAccepted>;
    ask(input: { recordingId: string; question: string; intent?: AiJobIntent }): Promise<JobAccepted>;
    cancel(jobId: string): Promise<JsonValue>;
  };
  exports: {
    create(input: ExportCreateInput): Promise<JobAccepted>;
    saveCompleted(jobId: string): Promise<JsonValue>;
    cancel(jobId: string): Promise<JsonValue>;
  };
  settings: {
    openLocalStorage(): Promise<JsonValue>;
    getStorageStatus(): Promise<JsonValue>;
    getPrivacyAudit(): Promise<JsonValue>;
    getNetworkPolicy(): Promise<JsonValue>;
    getUpdateStatus(): Promise<JsonValue>;
    getRetentionStatus(): Promise<JsonValue>;
  };
  licensing: {
    getStatus(): Promise<JsonValue>;
    activate(input: { licenseKey: string; purchaserEmail?: string }): Promise<JsonValue>;
    startTrial(): Promise<JsonValue>;
    deactivate(): Promise<JsonValue>;
    getPortalInfo(): Promise<JsonValue>;
  };
  setup: {
    getStatus(): Promise<JsonValue>;
    visit(input: { step: DesktopSetupStep }): Promise<JsonValue>;
    updateStep(input: { step: DesktopSetupStep; visit?: DesktopSetupStep }): Promise<JsonValue>;
    defer(input: { step: DesktopSetupStep }): Promise<JsonValue>;
    complete(): Promise<JsonValue>;
    markExistingUserPromptShown(): Promise<JsonValue>;
  };
  shortcuts: {
    getStatus(): Promise<JsonValue>;
    update(input: { enabled: boolean; accelerator?: string }): Promise<JsonValue>;
    reset(): Promise<JsonValue>;
  };
  events: {
    subscribe(eventName: "jobs.changed", listener: (payload: BackgroundTask) => void): () => void;
    subscribe(eventName: "shortcut.triggered", listener: (payload: ShortcutTriggeredPayload) => void): () => void;
    subscribe(eventName: "transcript.partial", listener: (payload: LiveTranscriptPartialPayload) => void): () => void;
    subscribe(eventName: "model.downloadProgress", listener: (payload: ModelDownloadProgressPayload) => void): () => void;
  };
}

type WithRendererCustody<T> = T extends (...args: infer Args) => Promise<infer Result>
  ? (...args: Args) => Promise<Result & RendererCustody>
  : T;

type RendererCustodyDomain<T> = {
  [Key in keyof T]: WithRendererCustody<T[Key]>;
};

type CandorApiV4 = {
  [Domain in keyof CandorApiV4Definition]: Domain extends "version" | "events"
    ? CandorApiV4Definition[Domain]
    : RendererCustodyDomain<CandorApiV4Definition[Domain]>;
};

type AsyncMethodResult<T> = T extends (...args: infer _Arguments) => Promise<infer Result> ? Result : never;
type DomainResponseUnion<T> = AsyncMethodResult<T[keyof T]>;
type CandorApiV4ResponseUnion = {
  [Domain in Exclude<keyof CandorApiV4, "version" | "events">]: DomainResponseUnion<CandorApiV4[Domain]>;
}[Exclude<keyof CandorApiV4, "version" | "events">];
type AssertRendererCustody<T extends RendererCustody> = T;
type CandorApiV4CustodyContract = AssertRendererCustody<CandorApiV4ResponseUnion>;

interface Window {
  candor?: CandorApiV4;
}
