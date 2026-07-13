import { contextBridge, ipcRenderer } from "electron";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

contextBridge.exposeInMainWorld("candor", {
  core: Object.freeze({
    ping: () => ipcRenderer.invoke("candor-core:core-ping") as Promise<JsonValue>,
    version: () => ipcRenderer.invoke("candor-core:core-version") as Promise<JsonValue>,
    capabilities: () => ipcRenderer.invoke("candor-core:core-capabilities") as Promise<JsonValue>,
    status: () => ipcRenderer.invoke("candor-core:core-status") as Promise<JsonValue>,
    vaultOpenLocal: () => ipcRenderer.invoke("candor-core:vault-open-local") as Promise<JsonValue>,
    vaultStatus: () => ipcRenderer.invoke("candor-core:vault-status") as Promise<JsonValue>,
    privacyAuditSnapshot: () => ipcRenderer.invoke("candor-core:privacy-audit-snapshot") as Promise<JsonValue>,
    privacyCapabilities: () => ipcRenderer.invoke("candor-core:privacy-capabilities") as Promise<JsonValue>,
    updateStatus: () => ipcRenderer.invoke("candor-core:updates-status") as Promise<JsonValue>,
    v2ImportStatus: () => ipcRenderer.invoke("candor-core:v2-import-status") as Promise<JsonValue>,
    v2ImportFromFolder: () =>
      ipcRenderer.invoke("candor-import:v2FromFolder") as Promise<JsonValue>,
    consentStatus: () => ipcRenderer.invoke("candor-core:consent-status") as Promise<JsonValue>,
    consentAcknowledge: (params: { items: string[] }) =>
      ipcRenderer.invoke("candor-core:consent-acknowledge", params) as Promise<JsonValue>,
    captureStatus: () => ipcRenderer.invoke("candor-core:capture-status") as Promise<JsonValue>,
    captureDevices: () => ipcRenderer.invoke("candor-core:capture-devices") as Promise<JsonValue>,
    captureStartMic: (params?: { label?: string; deviceId?: string; chunkMs?: number }) =>
      ipcRenderer.invoke("candor-core:capture-start-mic", params ?? {}) as Promise<JsonValue>,
    captureStartSystem: (params?: { label?: string; deviceId?: string; chunkMs?: number }) =>
      ipcRenderer.invoke("candor-core:capture-start-system", params ?? {}) as Promise<JsonValue>,
    captureStartMicAndSystem: (params?: {
      label?: string;
      micDeviceId?: string;
      systemDeviceId?: string;
      chunkMs?: number;
    }) => ipcRenderer.invoke("candor-core:capture-start-mic-and-system", params ?? {}) as Promise<JsonValue>,
    captureStop: () => ipcRenderer.invoke("candor-core:capture-stop") as Promise<JsonValue>,
    modelsStatus: () => ipcRenderer.invoke("candor-core:models-status") as Promise<JsonValue>,
    modelsListLocal: () => ipcRenderer.invoke("candor-core:models-list-local") as Promise<JsonValue>,
    modelsVerifyLocal: (params?: { modelId?: string }) =>
      ipcRenderer.invoke("candor-core:models-verify-local", params ?? {}) as Promise<JsonValue>,
    aiStatus: () => ipcRenderer.invoke("candor-core:ai-status") as Promise<JsonValue>,
    aiAskHeuristic: (recordingId: string, question: string) =>
      ipcRenderer.invoke("candor-core:ai-ask-heuristic", { recordingId, question }) as Promise<JsonValue>,
    aiRecapHeuristic: (recordingId: string) =>
      ipcRenderer.invoke("candor-core:ai-recap-heuristic", { recordingId }) as Promise<JsonValue>,
    aiInstructAssetsStatus: () => ipcRenderer.invoke("candor-core:ai-instruct-assets-status") as Promise<JsonValue>,
    aiInstructAssetImportFromFile: (params: {
      assetKind: "runner" | "model";
      expectedSha256: string;
      replace?: boolean;
    }) => ipcRenderer.invoke("candor-instruct-assets:importFromFile", params) as Promise<JsonValue>,
    aiInstructStatus: () => ipcRenderer.invoke("candor-core:ai-instruct-status") as Promise<JsonValue>,
    aiAskInstruct: (recordingId: string, question: string, maxTokens?: number) =>
      ipcRenderer.invoke(
        "candor-core:ai-ask-instruct",
        maxTokens === undefined ? { recordingId, question } : { recordingId, question, maxTokens },
      ) as Promise<JsonValue>,
    aiRecapInstruct: (recordingId: string, maxTokens?: number) =>
      ipcRenderer.invoke(
        "candor-core:ai-recap-instruct",
        maxTokens === undefined ? { recordingId } : { recordingId, maxTokens },
      ) as Promise<JsonValue>,
    aiSchedulerStatus: () => ipcRenderer.invoke("candor-core:ai-scheduler-status") as Promise<JsonValue>,
    modelsImportFromFile: (params: { modelId: string; replace?: boolean }) =>
      ipcRenderer.invoke("candor-models:importFromFile", params) as Promise<JsonValue>,
    transcriptionStatus: () => ipcRenderer.invoke("candor-core:transcription-status") as Promise<JsonValue>,
    transcriptionRunLocal: (params: {
      recordingId: string;
      channel?: string;
      modelId?: string;
      language?: string;
      initialPrompt?: string;
    }) => ipcRenderer.invoke("candor-core:transcription-run-local", params) as Promise<JsonValue>,
    recordingDurableStatus: () => ipcRenderer.invoke("candor-core:recording-durable-status") as Promise<JsonValue>,
    recordingDurableListPage: (offset = 0, limit = 50) =>
      ipcRenderer.invoke("candor-core:recording-durable-list-page", { offset, limit }) as Promise<JsonValue>,
    recordingDurableRead: (recordingId: string) =>
      ipcRenderer.invoke("candor-core:recording-durable-read", { recordingId }) as Promise<JsonValue>,
    recordingDurableReplayManifest: (recordingId: string) =>
      ipcRenderer.invoke("candor-core:recording-durable-replay-manifest", { recordingId }) as Promise<JsonValue>,
    recordingDurableTranscriptPage: (recordingId: string, offset = 0, limit = 100) =>
      ipcRenderer.invoke("candor-core:recording-durable-transcript-page", { recordingId, offset, limit }) as Promise<JsonValue>,
    recordingPrivacyReceipt: (recordingId: string) =>
      ipcRenderer.invoke("candor-core:recording-privacy-receipt", { recordingId }) as Promise<JsonValue>,
    recordingDurableReadAudioChunk: (recordingId: string, index: number) =>
      ipcRenderer.invoke("candor-core:recording-durable-read-audio-chunk", { recordingId, index }) as Promise<JsonValue>,
    recordingDurableSearch: (query: string) =>
      ipcRenderer.invoke("candor-core:recording-durable-search", { query }) as Promise<JsonValue>,
    recordingNotesRead: (recordingId: string) =>
      ipcRenderer.invoke("candor-core:recording-notes-read", { recordingId }) as Promise<JsonValue>,
    recordingNotesSave: (recordingId: string, markdown: string) =>
      ipcRenderer.invoke("candor-core:recording-notes-save", { recordingId, markdown }) as Promise<JsonValue>,
    retentionStatus: () => ipcRenderer.invoke("candor-core:retention-status") as Promise<JsonValue>,
    exportCreate: (params: {
      recordingId: string;
      format?: "markdown" | "docx" | "pdf" | "wav";
      channel?: string;
      report?: JsonValue;
      options?: JsonValue;
    }) =>
      ipcRenderer.invoke("candor-core:export-create", params) as Promise<JsonValue>,
    exportSaveLocal: (params: {
      recordingId: string;
      format: "markdown" | "docx" | "pdf";
      report: JsonValue;
      options: JsonValue;
    }) => ipcRenderer.invoke("candor-export:saveLocal", params) as Promise<JsonValue>,
  }),
  license: Object.freeze({
    status: () => ipcRenderer.invoke("candor-license:status") as Promise<JsonValue>,
    activate: (params: { licenseKey: string; purchaserEmail?: string }) =>
      ipcRenderer.invoke("candor-license:activate", params) as Promise<JsonValue>,
    startTrial: () => ipcRenderer.invoke("candor-license:startTrial") as Promise<JsonValue>,
    deactivateDevice: () => ipcRenderer.invoke("candor-license:deactivateDevice") as Promise<JsonValue>,
    portalInfo: () => ipcRenderer.invoke("candor-license:portalInfo") as Promise<JsonValue>,
  }),
  shell: Object.freeze({
    externalNavigationDisabled: true,
    networkPolicy: "disabled-by-default",
    supervisorStatus: () => ipcRenderer.invoke("candor-shell:supervisorStatus") as Promise<JsonValue>,
    diagnosticsPreview: () => ipcRenderer.invoke("candor-diagnostics:preview") as Promise<JsonValue>,
    diagnosticsSaveLocal: () => ipcRenderer.invoke("candor-diagnostics:saveLocal") as Promise<JsonValue>,
  }),
});
