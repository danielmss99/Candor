import { contextBridge, ipcRenderer } from "electron";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type CaptureSource = "microphone" | "system-audio" | "microphone-and-system-audio";
type JobEventName = "jobs.changed";

const invoke = (channel: string, params?: unknown) => ipcRenderer.invoke(channel, params) as Promise<JsonValue>;

const api = Object.freeze({
  version: 3 as const,
  app: Object.freeze({
    getStatus: () => invoke("candor-app:getStatus"),
    getConnectionStatus: () => invoke("candor-shell:supervisorStatus"),
    getVersion: () => invoke("candor-core:core-version"),
    getCapabilities: () => invoke("candor-core:core-capabilities"),
    retryCore: () => invoke("candor-app:retryCore"),
    listJobs: () => invoke("candor-jobs:list"),
    getActiveJobs: () => invoke("candor-jobs:activeSummary"),
    getJob: (jobId: string) => invoke("candor-jobs:get", { jobId }),
    cancelJob: (jobId: string) => invoke("candor-jobs:cancel", { jobId }),
    cancelAllJobs: () => invoke("candor-jobs:cancelAll"),
    retryJob: (jobId: string) => invoke("candor-jobs:retry", { jobId }),
    acknowledgeJob: (jobId: string) => invoke("candor-jobs:acknowledge", { jobId }),
    prepareDiagnostics: () => invoke("candor-diagnostics:preview"),
    saveDiagnostics: () => invoke("candor-diagnostics:saveLocal"),
  }),
  capture: Object.freeze({
    getStatus: () => invoke("candor-core:capture-status"),
    getDevices: () => invoke("candor-core:capture-devices"),
    getConsent: () => invoke("candor-core:consent-status"),
    acknowledgeConsent: (items: string[]) => invoke("candor-core:consent-acknowledge", { items }),
    start: (input: {
      source: CaptureSource;
      label?: string;
      deviceId?: string;
      micDeviceId?: string;
      systemDeviceId?: string;
      chunkMs?: number;
    }) => {
      const { source, ...params } = input;
      const channel = source === "system-audio"
        ? "candor-core:capture-start-system"
        : source === "microphone-and-system-audio"
          ? "candor-core:capture-start-mic-and-system"
          : "candor-core:capture-start-mic";
      return invoke(channel, params);
    },
    stop: () => invoke("candor-core:capture-stop"),
    recover: () => invoke("candor-capture:recover"),
  }),
  meetings: Object.freeze({
    getStorageStatus: () => invoke("candor-core:recording-durable-status"),
    list: (offset = 0, limit = 50) => invoke("candor-core:recording-durable-list-page", { offset, limit }),
    get: (recordingId: string) => invoke("candor-core:recording-durable-read", { recordingId }),
    getReplayManifest: (recordingId: string) => invoke("candor-core:recording-durable-replay-manifest", { recordingId }),
    getTranscript: (recordingId: string, offset = 0, limit = 100) =>
      invoke("candor-core:recording-durable-transcript-page", { recordingId, offset, limit }),
    getPrivacyReceipt: (recordingId: string) => invoke("candor-core:recording-privacy-receipt", { recordingId }),
    readAudioChunk: (recordingId: string, index: number) =>
      invoke("candor-core:recording-durable-read-audio-chunk", { recordingId, index }),
    search: (query: string) => invoke("candor-core:recording-durable-search", { query }),
    delete: (recordingId: string) => invoke("candor-recording:delete", { recordingId }),
    getNotes: (recordingId: string) => invoke("candor-core:recording-notes-read", { recordingId }),
    updateNotes: (recordingId: string, markdown: string) =>
      invoke("candor-core:recording-notes-save", { recordingId, markdown }),
    getImportStatus: () => invoke("candor-core:v2-import-status"),
    importLegacy: () => invoke("candor-import:v2FromFolder"),
  }),
  transcript: Object.freeze({
    getStatus: () => invoke("candor-core:transcription-status"),
    getQuality: () => invoke("candor-core:transcription-quality-status"),
    setQuality: (input: { tier: "fast" | "balanced" | "maximum"; languagePreference?: "english" | "multilingual" }) =>
      invoke("candor-core:transcription-quality-update", input),
    startQualityBenchmark: (input: { tier: "balanced" | "maximum" }) =>
      invoke("candor-transcript:startQualityBenchmark", input),
    start: (input: { recordingId: string; channel?: string; modelId?: string }) =>
      invoke("candor-transcript:start", input),
    cancel: (jobId: string) => invoke("candor-jobs:cancel", { jobId }),
  }),
  terminology: Object.freeze({
    getStatus: (recordingId?: string) =>
      invoke("candor-core:terminology-status", recordingId ? { recordingId } : {}),
    importDictionary: () => invoke("candor-terminology:importFromFile"),
    setEnabled: (dictionaryId: string, enabled: boolean) =>
      invoke("candor-core:terminology-set-enabled", { dictionaryId, enabled }),
    assignToMeeting: (recordingId: string, dictionaryId: string, enabled: boolean) =>
      invoke("candor-core:terminology-assign", { recordingId, dictionaryId, enabled }),
    getCorrectionProposals: (recordingId: string) =>
      invoke("candor-core:terminology-proposals", { recordingId }),
    decideCorrection: (
      recordingId: string,
      proposalId: string,
      decision: "accepted" | "rejected",
    ) => invoke("candor-core:terminology-decide", { recordingId, proposalId, decision }),
  }),
  ai: Object.freeze({
    getStatus: () => invoke("candor-core:ai-status"),
    getBundledAssetsStatus: () => invoke("candor-core:ai-bundled-assets-status"),
    getEnhancedAssetsStatus: () => invoke("candor-core:ai-instruct-assets-status"),
    getEnhancedStatus: () => invoke("candor-core:ai-instruct-status"),
    getWorkloadStatus: () => invoke("candor-core:ai-scheduler-status"),
    listSpeechModels: () => invoke("candor-core:models-list-local"),
    verifySpeechModel: (modelId?: string) => invoke("candor-models:verify", modelId ? { modelId } : {}),
    chooseSpeechModel: (modelId: string) => invoke("candor-models:importFromFile", { modelId, replace: true }),
    chooseEnhancedComponent: (input: { component: "engine" | "model"; expectedSha256: string }) =>
      invoke("candor-instruct-assets:importFromFile", {
        assetKind: input.component === "engine" ? "runner" : "model",
        expectedSha256: input.expectedSha256,
        replace: true,
      }),
    generateRecap: (input: {
      recordingId: string;
      mode: "local-llm" | "heuristic-fallback";
      fallbackPolicy: "allow-disclosed" | "require-local-llm";
    }) => invoke("candor-ai:recap", input),
    ask: (input: {
      recordingId: string;
      question: string;
      mode: "local-llm" | "heuristic-fallback";
      fallbackPolicy: "allow-disclosed" | "require-local-llm";
    }) => invoke("candor-ai:ask", input),
    cancel: (jobId: string) => invoke("candor-jobs:cancel", { jobId }),
  }),
  exports: Object.freeze({
    create: (input: JsonValue) => invoke("candor-export:start", input),
    saveCompleted: (jobId: string) => invoke("candor-export:saveCompleted", { jobId }),
    cancel: (jobId: string) => invoke("candor-jobs:cancel", { jobId }),
  }),
  settings: Object.freeze({
    openLocalStorage: () => invoke("candor-core:vault-open-local"),
    getStorageStatus: () => invoke("candor-core:vault-status"),
    getPrivacyAudit: () => invoke("candor-core:privacy-audit-snapshot"),
    getNetworkPolicy: () => invoke("candor-core:privacy-capabilities"),
    getUpdateStatus: () => invoke("candor-core:updates-status"),
    getRetentionStatus: () => invoke("candor-core:retention-status"),
  }),
  licensing: Object.freeze({
    getStatus: () => invoke("candor-license:status"),
    activate: (input: { licenseKey: string; purchaserEmail?: string }) => invoke("candor-license:activate", input),
    startTrial: () => invoke("candor-license:startTrial"),
    deactivate: () => invoke("candor-license:deactivateDevice"),
    getPortalInfo: () => invoke("candor-license:portalInfo"),
  }),
  events: Object.freeze({
    subscribe: (eventName: JobEventName, listener: (payload: JsonValue) => void) => {
      if (eventName !== "jobs.changed") throw new Error("Unsupported Candor event");
      const handler = (_event: Electron.IpcRendererEvent, payload: JsonValue) => listener(payload);
      ipcRenderer.on("candor-events:jobs-changed", handler);
      return () => ipcRenderer.removeListener("candor-events:jobs-changed", handler);
    },
  }),
});

contextBridge.exposeInMainWorld("candor", api);
