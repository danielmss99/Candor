import { contextBridge, ipcRenderer } from "electron";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

const allowedMethods = new Set([
  "core.ping",
  "core.version",
  "core.capabilities",
  "core.status",
  "vault.openLocal",
  "vault.status",
  "privacy.auditSnapshot",
  "privacy.capabilities",
  "updates.status",
  "import.v2.status",
  "consent.status",
  "consent.acknowledge",
  "capture.status",
  "capture.devices",
  "capture.startMic",
  "capture.startSystem",
  "capture.startMicAndSystem",
  "capture.stop",
  "models.status",
  "models.listLocal",
  "models.verifyLocal",
  "ai.status",
  "ai.askHeuristic",
  "ai.recapHeuristic",
  "ai.instructAssetsStatus",
  "ai.instructStatus",
  "ai.askInstruct",
  "ai.recapInstruct",
  "ai.schedulerStatus",
  "transcription.status",
  "transcription.runLocal",
  "recording.durable.listPage",
  "recording.durable.read",
  "recording.durable.replayManifest",
  "recording.durable.transcriptPage",
  "recording.privacyReceipt",
  "recording.durable.readAudioChunk",
  "recording.durable.search",
  "recording.notes.read",
  "recording.notes.save",
  "retention.status",
  "export.create",
]);

async function callCore(method: string, params: JsonValue = null): Promise<JsonValue> {
  if (!allowedMethods.has(method)) {
    throw new Error(`Method is not exposed to the renderer: ${method}`);
  }
  return (await ipcRenderer.invoke("candor-core:call", method, params)) as JsonValue;
}

contextBridge.exposeInMainWorld("candor", {
  core: Object.freeze({
    ping: (echo?: JsonValue) => callCore("core.ping", echo ?? null),
    version: () => callCore("core.version"),
    capabilities: () => callCore("core.capabilities"),
    status: () => callCore("core.status"),
    vaultOpenLocal: () => callCore("vault.openLocal"),
    vaultStatus: () => callCore("vault.status"),
    privacyAuditSnapshot: () => callCore("privacy.auditSnapshot"),
    privacyCapabilities: () => callCore("privacy.capabilities"),
    updateStatus: () => callCore("updates.status"),
    v2ImportStatus: () => callCore("import.v2.status"),
    v2ImportFromFolder: () =>
      ipcRenderer.invoke("candor-import:v2FromFolder") as Promise<JsonValue>,
    consentStatus: () => callCore("consent.status"),
    consentAcknowledge: (params: { items: string[] }) =>
      callCore("consent.acknowledge", params),
    captureStatus: () => callCore("capture.status"),
    captureDevices: () => callCore("capture.devices"),
    captureStartMic: (params?: { label?: string; deviceId?: string; chunkMs?: number }) =>
      callCore("capture.startMic", params ?? {}),
    captureStartSystem: (params?: { label?: string; deviceId?: string; chunkMs?: number }) =>
      callCore("capture.startSystem", params ?? {}),
    captureStartMicAndSystem: (params?: {
      label?: string;
      micDeviceId?: string;
      systemDeviceId?: string;
      chunkMs?: number;
    }) => callCore("capture.startMicAndSystem", params ?? {}),
    captureStop: () => callCore("capture.stop"),
    modelsStatus: () => callCore("models.status"),
    modelsListLocal: () => callCore("models.listLocal"),
    modelsVerifyLocal: (params?: { modelId?: string }) =>
      callCore("models.verifyLocal", params ?? {}),
    aiStatus: () => callCore("ai.status"),
    aiAskHeuristic: (recordingId: string, question: string) =>
      callCore("ai.askHeuristic", { recordingId, question }),
    aiRecapHeuristic: (recordingId: string) =>
      callCore("ai.recapHeuristic", { recordingId }),
    aiInstructAssetsStatus: () => callCore("ai.instructAssetsStatus"),
    aiInstructAssetImportFromFile: (params: {
      assetKind: "runner" | "model";
      expectedSha256: string;
      replace?: boolean;
    }) => ipcRenderer.invoke("candor-instruct-assets:importFromFile", params) as Promise<JsonValue>,
    aiInstructStatus: () => callCore("ai.instructStatus"),
    aiAskInstruct: (recordingId: string, question: string, maxTokens?: number) =>
      callCore(
        "ai.askInstruct",
        maxTokens === undefined ? { recordingId, question } : { recordingId, question, maxTokens },
      ),
    aiRecapInstruct: (recordingId: string, maxTokens?: number) =>
      callCore(
        "ai.recapInstruct",
        maxTokens === undefined ? { recordingId } : { recordingId, maxTokens },
      ),
    aiSchedulerStatus: () => callCore("ai.schedulerStatus"),
    modelsImportFromFile: (params: { modelId: string; replace?: boolean }) =>
      ipcRenderer.invoke("candor-models:importFromFile", params) as Promise<JsonValue>,
    transcriptionStatus: () => callCore("transcription.status"),
    transcriptionRunLocal: (params: {
      recordingId: string;
      channel?: string;
      modelId?: string;
      language?: string;
      initialPrompt?: string;
    }) => callCore("transcription.runLocal", params),
    recordingDurableListPage: (offset = 0, limit = 50) =>
      callCore("recording.durable.listPage", { offset, limit }),
    recordingDurableRead: (recordingId: string) =>
      callCore("recording.durable.read", { recordingId }),
    recordingDurableReplayManifest: (recordingId: string) =>
      callCore("recording.durable.replayManifest", { recordingId }),
    recordingDurableTranscriptPage: (recordingId: string, offset = 0, limit = 200) =>
      callCore("recording.durable.transcriptPage", { recordingId, offset, limit }),
    recordingPrivacyReceipt: (recordingId: string) =>
      callCore("recording.privacyReceipt", { recordingId }),
    recordingDurableReadAudioChunk: (recordingId: string, index: number) =>
      callCore("recording.durable.readAudioChunk", { recordingId, index }),
    recordingDurableSearch: (query: string) =>
      callCore("recording.durable.search", { query }),
    recordingNotesRead: (recordingId: string) =>
      callCore("recording.notes.read", { recordingId }),
    recordingNotesSave: (recordingId: string, markdown: string) =>
      callCore("recording.notes.save", { recordingId, markdown }),
    retentionStatus: () => callCore("retention.status"),
    exportCreate: (params: {
      recordingId: string;
      format?: "markdown" | "docx" | "pdf" | "wav";
      channel?: string;
      report?: JsonValue;
      options?: JsonValue;
    }) =>
      callCore("export.create", params),
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
  }),
});
