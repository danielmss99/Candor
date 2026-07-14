type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface JobAccepted {
  jobId: string;
  type: string;
  state: "queued";
  createdAt: string;
  rawPathExposed: false;
}

interface CandorApiV2 {
  version: 2;
  app: {
    getStatus(): Promise<JsonValue>;
    getConnectionStatus(): Promise<JsonValue>;
    getVersion(): Promise<JsonValue>;
    getCapabilities(): Promise<JsonValue>;
    retryCore(): Promise<JsonValue>;
    listJobs(): Promise<JsonValue>;
    getJob(jobId: string): Promise<JsonValue>;
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
    start(input: { recordingId: string; channel?: string; modelId?: string; language?: string; initialPrompt?: string }): Promise<JobAccepted>;
    cancel(jobId: string): Promise<JsonValue>;
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
    generateRecap(recordingId: string, quality: "fast" | "best"): Promise<JobAccepted>;
    ask(recordingId: string, question: string, quality: "fast" | "best"): Promise<JobAccepted>;
    cancel(jobId: string): Promise<JsonValue>;
  };
  exports: {
    create(input: JsonValue): Promise<JobAccepted>;
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
    subscribe(eventName: "jobs.changed", listener: (payload: JsonValue) => void): () => void;
  };
}

interface Window {
  candor?: CandorApiV2;
}
