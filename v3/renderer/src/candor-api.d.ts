type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

interface CandorApi {
  core: {
    ping(echo?: JsonValue): Promise<JsonValue>;
    version(): Promise<JsonValue>;
    capabilities(): Promise<JsonValue>;
    status(): Promise<JsonValue>;
    vaultOpenLocal(): Promise<JsonValue>;
    vaultStatus(): Promise<JsonValue>;
    privacyAuditSnapshot(): Promise<JsonValue>;
    privacyCapabilities(): Promise<JsonValue>;
    updateStatus(): Promise<JsonValue>;
    v2ImportStatus(): Promise<JsonValue>;
    v2ImportFromFolder(): Promise<JsonValue>;
    consentStatus(): Promise<JsonValue>;
    consentAcknowledge(params: { items: string[] }): Promise<JsonValue>;
    captureStatus(): Promise<JsonValue>;
    captureDevices(): Promise<JsonValue>;
    captureStartMic(params?: { label?: string; deviceId?: string; chunkMs?: number }): Promise<JsonValue>;
    captureStartSystem(params?: { label?: string; deviceId?: string; chunkMs?: number }): Promise<JsonValue>;
    captureStartMicAndSystem(params?: {
      label?: string;
      micDeviceId?: string;
      systemDeviceId?: string;
      chunkMs?: number;
    }): Promise<JsonValue>;
    captureStop(): Promise<JsonValue>;
    modelsStatus(): Promise<JsonValue>;
    modelsListLocal(): Promise<JsonValue>;
    modelsVerifyLocal(params?: { modelId?: string }): Promise<JsonValue>;
    aiStatus(): Promise<JsonValue>;
    aiAskHeuristic(recordingId: string, question: string): Promise<JsonValue>;
    aiRecapHeuristic(recordingId: string): Promise<JsonValue>;
    aiInstructAssetsStatus(): Promise<JsonValue>;
    aiInstructAssetImportFromFile(params: {
      assetKind: "runner" | "model";
      expectedSha256: string;
      replace?: boolean;
    }): Promise<JsonValue>;
    aiInstructStatus(): Promise<JsonValue>;
    aiAskInstruct(recordingId: string, question: string, maxTokens?: number): Promise<JsonValue>;
    aiRecapInstruct(recordingId: string, maxTokens?: number): Promise<JsonValue>;
    aiSchedulerStatus(): Promise<JsonValue>;
    modelsImportFromFile(params: { modelId: string; replace?: boolean }): Promise<JsonValue>;
    transcriptionStatus(): Promise<JsonValue>;
    transcriptionRunLocal(params: {
      recordingId: string;
      channel?: string;
      modelId?: string;
      language?: string;
      initialPrompt?: string;
    }): Promise<JsonValue>;
    recordingDurableListPage(offset?: number, limit?: number): Promise<JsonValue>;
    recordingDurableRead(recordingId: string): Promise<JsonValue>;
    recordingDurableReplayManifest(recordingId: string): Promise<JsonValue>;
    recordingDurableTranscriptPage(recordingId: string, offset?: number, limit?: number): Promise<JsonValue>;
    recordingPrivacyReceipt(recordingId: string): Promise<JsonValue>;
    recordingDurableReadAudioChunk(recordingId: string, index: number): Promise<JsonValue>;
    recordingDurableSearch(query: string): Promise<JsonValue>;
    recordingNotesRead(recordingId: string): Promise<JsonValue>;
    recordingNotesSave(recordingId: string, markdown: string): Promise<JsonValue>;
    retentionStatus(): Promise<JsonValue>;
    exportCreate(params: {
      recordingId: string;
      format?: "markdown" | "docx" | "pdf" | "wav";
      channel?: string;
      report?: JsonValue;
      options?: JsonValue;
    }): Promise<JsonValue>;
    exportSaveLocal(params: {
      recordingId: string;
      format: "markdown" | "docx" | "pdf";
      report: JsonValue;
      options: JsonValue;
    }): Promise<JsonValue>;
  };
  license: {
    status(): Promise<JsonValue>;
    activate(params: { licenseKey: string; purchaserEmail?: string }): Promise<JsonValue>;
    startTrial(): Promise<JsonValue>;
    deactivateDevice(): Promise<JsonValue>;
    portalInfo(): Promise<JsonValue>;
  };
  shell: {
    externalNavigationDisabled: boolean;
    networkPolicy: string;
    supervisorStatus(): Promise<JsonValue>;
  };
}

interface Window {
  candor?: CandorApi;
}
