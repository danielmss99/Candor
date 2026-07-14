type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface JobAccepted {
  jobId: string;
  type: BackgroundTaskKind;
  state: "queued";
  createdAt: string;
  rawPathExposed: false;
}

type BackgroundTaskKind =
  | "transcription"
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

interface AiProvenance {
  engine: "local-llm" | "heuristic";
  modelId?: string | null;
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
}

interface CandorApiV3 {
  version: 3;
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
    cancelAllJobs(): Promise<JsonValue>;
    retryJob(jobId: string): Promise<JobAccepted>;
    acknowledgeJob(jobId: string): Promise<JsonValue>;
    prepareDiagnostics(): Promise<JsonValue>;
    saveDiagnostics(): Promise<JsonValue>;
  };
  capture: {
    getStatus(): Promise<JsonValue>;
    getDevices(): Promise<JsonValue>;
    getConsent(): Promise<JsonValue>;
    acknowledgeConsent(items: string[]): Promise<JsonValue>;
    start(input: {
      source: "microphone" | "system-audio" | "microphone-and-system-audio";
      label?: string;
      deviceId?: string;
      micDeviceId?: string;
      systemDeviceId?: string;
      chunkMs?: number;
    }): Promise<JsonValue>;
    stop(): Promise<JsonValue>;
    recover(): Promise<JsonValue>;
  };
  meetings: {
    getStorageStatus(): Promise<JsonValue>;
    list(offset?: number, limit?: number): Promise<JsonValue>;
    get(recordingId: string): Promise<JsonValue>;
    getReplayManifest(recordingId: string): Promise<JsonValue>;
    getTranscript(recordingId: string, offset?: number, limit?: number): Promise<JsonValue>;
    getPrivacyReceipt(recordingId: string): Promise<JsonValue>;
    readAudioChunk(recordingId: string, index: number): Promise<JsonValue>;
    search(query: string): Promise<JsonValue>;
    delete(recordingId: string): Promise<JsonValue>;
    getNotes(recordingId: string): Promise<JsonValue>;
    updateNotes(recordingId: string, markdown: string): Promise<JsonValue>;
    getImportStatus(): Promise<JsonValue>;
    importLegacy(): Promise<JsonValue>;
  };
  transcript: {
    getStatus(): Promise<JsonValue>;
    getQuality(): Promise<JsonValue>;
    setQuality(input: { tier: "fast" | "balanced" | "maximum"; languagePreference?: "english" | "multilingual" }): Promise<JsonValue>;
    startQualityBenchmark(input: { tier: "balanced" | "maximum" }): Promise<JobAccepted>;
    start(input: { recordingId: string; channel?: string; modelId?: string }): Promise<JobAccepted>;
    cancel(jobId: string): Promise<JsonValue>;
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
  ai: {
    getStatus(): Promise<JsonValue>;
    getBundledAssetsStatus(): Promise<JsonValue>;
    getEnhancedAssetsStatus(): Promise<JsonValue>;
    getEnhancedStatus(): Promise<JsonValue>;
    getWorkloadStatus(): Promise<JsonValue>;
    listSpeechModels(): Promise<JsonValue>;
    verifySpeechModel(modelId?: string): Promise<JobAccepted>;
    chooseSpeechModel(modelId: string): Promise<JobAccepted | JsonValue>;
    chooseEnhancedComponent(input: { component: "engine" | "model"; expectedSha256: string }): Promise<JobAccepted | JsonValue>;
    generateRecap(input: { recordingId: string; mode: AiExecutionMode; fallbackPolicy: AiFallbackPolicy }): Promise<JobAccepted>;
    ask(input: { recordingId: string; question: string; mode: AiExecutionMode; fallbackPolicy: AiFallbackPolicy }): Promise<JobAccepted>;
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
  events: {
    subscribe(eventName: "jobs.changed", listener: (payload: BackgroundTask) => void): () => void;
  };
}

interface Window {
  candor?: CandorApiV3;
}
