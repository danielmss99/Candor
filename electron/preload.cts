import { contextBridge, ipcRenderer } from "electron";
import { BoundedLatestEventBuffer } from "./preload-event-buffer.cjs";
import {
  parseShortcutTriggeredPayload,
  withRendererCustody,
} from "./preload-response-contract.cjs";

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
type CandorEventName = "jobs.changed" | "shortcut.triggered" | "transcript.partial" | "model.downloadProgress";
type RendererCustody = {
  rawPathExposed: false;
  keyMaterialExposedToRenderer: false;
};
type CandorResponse = { [key: string]: JsonValue } & RendererCustody;
type ShortcutTriggeredPayload = {
  action: "show-and-focus-recorder";
  recordsAudio: false;
  localOnly: true;
  rawPathExposed: false;
  keyMaterialExposedToRenderer: false;
};

const EVENT_CHANNELS: Readonly<Record<CandorEventName, string>> = Object.freeze({
  "jobs.changed": "candor-events:jobs-changed",
  "shortcut.triggered": "candor-events:shortcut-triggered",
  "transcript.partial": "candor-events:transcript-partial",
  "model.downloadProgress": "candor-events:model-download-progress",
});

const shortcutEventBuffer = new BoundedLatestEventBuffer<ShortcutTriggeredPayload>();
ipcRenderer.on(EVENT_CHANNELS["shortcut.triggered"], (_event, payload: JsonValue) => {
  const parsed = parseShortcutTriggeredPayload(payload) as ShortcutTriggeredPayload | null;
  if (parsed) shortcutEventBuffer.publish(parsed);
});

const invoke = async (channel: string, params?: unknown): Promise<CandorResponse> =>
  withRendererCustody(await ipcRenderer.invoke(channel, params)) as CandorResponse;

const api = Object.freeze({
  version: 4 as const,
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
    getPreferences: () => invoke("candor-core:capture-preferences"),
    setPreferredMicrophone: (input: { deviceId: string; fingerprint?: string; ordinal?: number }) =>
      invoke("candor-core:capture-set-preferred-microphone", input),
    startMicTest: () => invoke("candor-core:capture-mic-test-start", {}),
    getMicTestStatus: () => invoke("candor-core:capture-mic-test-status"),
    getMicTestSample: () => invoke("candor-core:capture-mic-test-sample"),
    stopMicTest: () => invoke("candor-core:capture-mic-test-stop"),
    openMicrophoneSettings: () => invoke("candor-capture:openMicrophoneSettings"),
    getConsent: () => invoke("candor-core:consent-status"),
    acknowledgeConsent: (items: string[]) => invoke("candor-core:consent-acknowledge", { items }),
    start: (input: CaptureStartInput) => {
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
    getTrustHistory: (recordingId: string) =>
      invoke("candor-core:recording-trust-history", { recordingId }),
    getTranscriptRevision: (recordingId: string, revisionId: string) =>
      invoke("candor-core:recording-transcript-revision", { recordingId, revisionId }),
    selectTranscriptRevision: (recordingId: string, revisionId: string) =>
      invoke("candor-core:recording-select-transcript-revision", { recordingId, revisionId }),
    getProtectedTermReview: (recordingId: string) =>
      invoke("candor-core:transcription-protected-term-review", { recordingId }),
    applyProtectedTermReview: (recordingId: string, revisionId: string, previewToken: string) =>
      invoke("candor-core:transcription-apply-protected-term-review", {
        recordingId,
        revisionId,
        previewToken,
      }),
    getPrivacyReceipt: (recordingId: string) => invoke("candor-core:recording-privacy-receipt", { recordingId }),
    readAudioChunk: (recordingId: string, index: number) =>
      invoke("candor-core:recording-durable-read-audio-chunk", { recordingId, index }),
    search: (query: string) => invoke("candor-core:recording-durable-search", { query }),
    delete: (recordingId: string) => invoke("candor-recording:delete", { recordingId }),
    getNotes: (recordingId: string) => invoke("candor-core:recording-notes-read", { recordingId }),
    updateNotes: (recordingId: string, markdown: string) =>
      invoke("candor-core:recording-notes-save", { recordingId, markdown }),
    getMediaImportStatus: () => invoke("candor-core:media-import-status"),
    importMedia: () => invoke("candor-meetings:importMedia"),
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
    reprocess: async (input: { recordingId: string; channel?: string; modelId?: string }) => {
      const prepared = await invoke("candor-core:transcription-prepare-reprocess", {
        recordingId: input.recordingId,
        ...(input.channel ? { channel: input.channel } : {}),
      });
      if (!prepared || typeof prepared !== "object" || Array.isArray(prepared)) {
        throw new Error("Candor returned an invalid reprocessing plan");
      }
      const dispatchInput = prepared.dispatchInput;
      if (
        !dispatchInput
        || typeof dispatchInput !== "object"
        || Array.isArray(dispatchInput)
        || dispatchInput.recordingId !== input.recordingId
        || typeof dispatchInput.channel !== "string"
      ) {
        throw new Error("Candor returned an invalid reprocessing input");
      }
      return invoke("candor-transcript:start", {
        recordingId: input.recordingId,
        channel: dispatchInput.channel,
        ...(input.modelId ? { modelId: input.modelId } : {}),
      });
    },
    cancel: (jobId: string) => invoke("candor-jobs:cancel", { jobId }),
  }),
  liveTranscript: Object.freeze({
    enable: (recordingId: string) =>
      invoke("candor-core:live-transcript-enable", { recordingId }),
    start: (recordingId: string) =>
      invoke("candor-core:live-transcript-start", { recordingId }),
    snapshot: (recordingId: string) =>
      invoke("candor-core:live-transcript-snapshot", { recordingId }),
    clear: (recordingId: string) =>
      invoke("candor-core:live-transcript-clear", { recordingId }),
    stop: (recordingId: string) =>
      invoke("candor-core:live-transcript-stop", { recordingId }),
    eventsDrain: () => invoke("candor-core:live-transcript-events-drain"),
  }),
  diarization: Object.freeze({
    getStatus: () => invoke("candor-core:diarization-status"),
    setEnabled: (enabled: boolean) =>
      invoke("candor-core:diarization-update-preference", { enabled }),
    getSpeakerNames: (recordingId: string) =>
      invoke("candor-core:diarization-speaker-names", { recordingId }),
    assignSpeakerName: (recordingId: string, anonymousSpeakerId: string, displayName: string) =>
      invoke("candor-core:diarization-assign-speaker-name", {
        recordingId,
        anonymousSpeakerId,
        displayName,
      }),
    removeSpeakerName: (recordingId: string, anonymousSpeakerId: string) =>
      invoke("candor-core:diarization-remove-speaker-name", { recordingId, anonymousSpeakerId }),
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
  profiles: Object.freeze({
    list: () => invoke("candor-core:profiles-list"),
    get: (id: string) => invoke("candor-core:profiles-get", { id }),
    upsert: (input: {
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
    }) => invoke("candor-core:profiles-upsert", input),
    delete: (id: string, expectedVersion: number) =>
      invoke("candor-core:profiles-delete", { id, expectedVersion }),
    select: (id: string) => invoke("candor-core:profiles-select", { id }),
  }),
  replacements: Object.freeze({
    list: () => invoke("candor-core:replacements-list"),
    get: (id: string) => invoke("candor-core:replacements-get", { id }),
    upsert: (input: {
      id?: string;
      expectedVersion?: number;
      name: string;
      rules: Array<{
        id: string;
        order: number;
        matchMode: "exact" | "whole-word";
        literal: string;
        replacement: string;
        protectedTermReview: boolean;
        enabled: boolean;
      }>;
    }) => invoke("candor-core:replacements-upsert", input),
    delete: (id: string, expectedVersion: number) =>
      invoke("candor-core:replacements-delete", { id, expectedVersion }),
    preview: (setId: string, input: string) =>
      invoke("candor-core:replacements-preview", { setId, input }),
    apply: (input: {
      setId: string;
      input: string;
      previewToken: string;
      approveProtectedTerms?: boolean;
    }) => invoke("candor-core:replacements-apply", input),
  }),
  ai: Object.freeze({
    getStatus: () => invoke("candor-core:ai-status"),
    getBundledAssetsStatus: () => invoke("candor-core:ai-bundled-assets-status"),
    getEnhancedAssetsStatus: () => invoke("candor-core:ai-instruct-assets-status"),
    getEnhancedStatus: () => invoke("candor-core:ai-instruct-status"),
    getFallbackPreference: () => invoke("candor-core:ai-fallback-preference-status"),
    setFallbackPreference: (preference: "ask-first" | "automatic" | "never") =>
      invoke("candor-core:ai-fallback-preference-update", { preference }),
    getWorkloadStatus: () => invoke("candor-core:ai-scheduler-status"),
    listSpeechModels: () => invoke("candor-core:models-list-local"),
    getModelCatalog: () => invoke("candor-models:getCatalog"),
    downloadModel: (modelId: string) => invoke("candor-models:download", { modelId }),
    cancelModelDownload: (modelId?: string) => invoke("candor-models:cancelDownload", modelId ? { modelId } : {}),
    verifySpeechModel: (modelId?: string) => invoke("candor-models:verify", modelId ? { modelId } : {}),
    chooseSpeechModel: (modelId: string) => invoke("candor-models:importFromFile", { modelId, replace: true }),
    chooseEnhancedComponent: (input: { component: "engine" | "model"; expectedSha256: string }) =>
      invoke("candor-instruct-assets:importFromFile", {
        assetKind: input.component === "engine" ? "runner" : "model",
        expectedSha256: input.expectedSha256,
        replace: true,
      }),
    cleanupTranscript: (recordingId: string) => invoke("candor-ai:cleanup", { recordingId }),
    generateRecap: (input: {
      recordingId: string;
      intent?: "default" | "strict-retry" | "explicit-heuristic";
      recapTemplate?: string;
    }) => invoke("candor-ai:recap", input),
    ask: (input: {
      recordingId: string;
      question: string;
      intent?: "default" | "strict-retry" | "explicit-heuristic";
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
  setup: Object.freeze({
    getStatus: () => invoke("candor-setup:getStatus"),
    visit: (input: {
      step: "license" | "microphone" | "shortcut" | "system-audio" | "storage" | "local-ai";
    }) => invoke("candor-setup:visit", input),
    updateStep: (input: {
      step: "license" | "microphone" | "shortcut" | "system-audio" | "storage" | "local-ai";
      visit?: "license" | "microphone" | "shortcut" | "system-audio" | "storage" | "local-ai";
    }) => invoke("candor-setup:updateStep", input),
    defer: (input: {
      step: "license" | "microphone" | "shortcut" | "system-audio" | "storage" | "local-ai";
    }) => invoke("candor-setup:defer", input),
    complete: () => invoke("candor-setup:complete"),
    markExistingUserPromptShown: () => invoke("candor-setup:markExistingUserPromptShown"),
  }),
  shortcuts: Object.freeze({
    getStatus: () => invoke("candor-shortcuts:getStatus"),
    update: (input: { enabled: boolean; accelerator?: string }) => invoke("candor-shortcuts:update", input),
    reset: () => invoke("candor-shortcuts:reset"),
  }),
  events: Object.freeze({
    subscribe: (eventName: CandorEventName, listener: (payload: JsonValue) => void) => {
      const channel = EVENT_CHANNELS[eventName];
      if (!channel) throw new Error("Unsupported Candor event");
      if (eventName === "shortcut.triggered") return shortcutEventBuffer.subscribe(listener);
      const handler = (_event: Electron.IpcRendererEvent, payload: JsonValue) => listener(payload);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
  }),
});

contextBridge.exposeInMainWorld("candor", api);
