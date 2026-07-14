import { useCallback, useEffect, useState } from "react";
import type { CandorClient } from "../../core/candor-client";
import {
  asArray,
  asObject,
  asString,
  parseTranscriptionQualityStatus,
  type JsonObject,
  type LocalJsonValue,
  type BundledAiStatus,
  type NetworkCapabilities,
  type TranscriptionQualityStatus,
} from "../../core/contracts";

type CoreApi = NonNullable<Window["candor"]>;

const EMPTY_BUNDLED_AI_STATUS: BundledAiStatus = {
  releaseReady: false,
  fixture: false,
  selectionStatus: "checking",
  state: "checking",
  ready: false,
  repairRequired: false,
  repairPolicy: "signed-installer-only",
  repairAction: "none",
  speech: { state: "checking", ready: false, available: false, requiredAssets: 0, verifiedAssets: 0, modelId: null, failureCode: null },
  language: { state: "checking", ready: false, available: false, requiredAssets: 0, verifiedAssets: 0, modelId: null, failureCode: null },
};

const UNAVAILABLE_BUNDLED_AI_STATUS: BundledAiStatus = {
  ...EMPTY_BUNDLED_AI_STATUS,
  selectionStatus: "status-unavailable",
  state: "unavailable",
  speech: { ...EMPTY_BUNDLED_AI_STATUS.speech, state: "unavailable", failureCode: "BUNDLED_AI_STATUS_UNAVAILABLE" },
  language: { ...EMPTY_BUNDLED_AI_STATUS.language, state: "unavailable", failureCode: "BUNDLED_AI_STATUS_UNAVAILABLE" },
};

const EMPTY_TRANSCRIPTION_QUALITY_STATUS: TranscriptionQualityStatus = {
  state: "checking",
  tier: "fast",
  languagePreference: "english",
  recommendedTier: "fast",
  benchmarkState: "checking",
  benchmarkFailureTier: null,
  estimatedRealTimeFactor: null,
  estimatedMinutesPerHour: null,
  estimatedCompletionAvailable: false,
  fallbackApplied: false,
  guardReason: null,
  tiers: [
    { id: "fast", label: "Fast", available: true, recommended: false, guardReason: null },
    { id: "balanced", label: "Balanced", available: false, recommended: false, guardReason: null },
    { id: "maximum", label: "Maximum accuracy", available: false, recommended: false, guardReason: null },
  ],
};

interface DiagnosticTask {
  label: string;
  run: () => Promise<void>;
}

export interface DiagnosticRunResult {
  failed: string[];
  completed: number;
}

export async function runBackgroundDiagnostics(tasks: DiagnosticTask[]): Promise<DiagnosticRunResult> {
  const settled = await Promise.allSettled(tasks.map((task) => task.run()));
  return {
    failed: settled.flatMap((result, index) => result.status === "rejected" ? [tasks[index].label] : []),
    completed: settled.filter((result) => result.status === "fulfilled").length,
  };
}

export function useRuntimeStatus(api: CoreApi | undefined, client: CandorClient | null) {
  const [coreStatus, setCoreStatus] = useState<JsonObject>({});
  const [connectionStatus, setConnectionStatus] = useState<JsonObject>({});
  const [capabilities, setCapabilities] = useState<JsonObject>({});
  const [privacyAudit, setPrivacyAudit] = useState<JsonObject>({});
  const [networkCapabilities, setNetworkCapabilities] = useState<NetworkCapabilities>({
    policy: "loading",
    externalCallsAttempted: 0,
    capabilities: [],
  });
  const [updateStatus, setUpdateStatus] = useState<JsonObject>({});
  const [v2ImportStatus, setV2ImportStatus] = useState<JsonObject>({});
  const [consentStatus, setConsentStatus] = useState<JsonObject>({});
  const [vaultStatus, setVaultStatus] = useState<JsonObject>({});
  const [captureStatus, setCaptureStatus] = useState<JsonObject>({});
  const [aiStatus, setAiStatus] = useState<JsonObject>({});
  const [bundledAiStatus, setBundledAiStatus] = useState<BundledAiStatus>(EMPTY_BUNDLED_AI_STATUS);
  const [instructAssetsStatus, setInstructAssetsStatus] = useState<JsonObject>({});
  const [instructStatus, setInstructStatus] = useState<JsonObject>({});
  const [schedulerStatus, setSchedulerStatus] = useState<JsonObject>({});
  const [modelStatus, setModelStatus] = useState<JsonObject>({ models: [] });
  const [transcriptionStatus, setTranscriptionStatus] = useState<JsonObject>({});
  const [transcriptionQualityStatus, setTranscriptionQualityStatus] = useState<TranscriptionQualityStatus>(EMPTY_TRANSCRIPTION_QUALITY_STATUS);
  const [retentionStatus, setRetentionStatus] = useState<JsonObject>({});
  const [recordingStatus, setRecordingStatus] = useState<JsonObject>({});
  const [diagnosticFailures, setDiagnosticFailures] = useState<string[]>([]);
  const [jobs, setJobs] = useState<JsonObject[]>([]);
  const [recoveryBusy, setRecoveryBusy] = useState(false);

  const loadCritical = useCallback(async () => {
    if (!api || !client) throw new Error("Candor preload API is unavailable");
    const [nextCore, nextConsent, nextVault, nextCapture, nextRecording, nextJobs] = await Promise.all([
      client.object("core.status", () => api.app.getStatus()),
      client.object("consent.status", () => api.capture.getConsent()),
      client.object("vault.status", () => api.settings.getStorageStatus()),
      client.object("capture.status", () => api.capture.getStatus()),
      client.object("recording.durable.status", () => api.meetings.getStorageStatus()),
      client.object("jobs.list", () => api.app.listJobs()),
    ]);
    setCoreStatus(nextCore);
    setConnectionStatus(asObject(nextCore.connection));
    setConsentStatus(nextConsent);
    setVaultStatus(nextVault);
    setCaptureStatus(nextCapture);
    setRecordingStatus(nextRecording);
    setJobs(asArray(nextJobs.jobs).map(asObject));
  }, [api, client]);

  useEffect(() => {
    if (!api) return;
    return api.events.subscribe("jobs.changed", (payload) => {
      const next = asObject(payload as LocalJsonValue);
      const jobId = asString(next.jobId);
      if (!jobId) return;
      setJobs((current) => [next, ...current.filter((job) => asString(job.jobId) !== jobId)]);
    });
  }, [api]);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    let timer = 0;
    const poll = async () => {
      try {
        const next = asObject(await api.app.getConnectionStatus());
        if (!cancelled) setConnectionStatus(next);
      } finally {
        if (!cancelled) timer = window.setTimeout(() => void poll(), 1_000);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [api]);

  const recoverCapture = useCallback(async () => {
    if (!api) return;
    setRecoveryBusy(true);
    try {
      await api.capture.recover();
      await loadCritical();
    } finally {
      setRecoveryBusy(false);
    }
  }, [api, loadCritical]);

  const loadDiagnostics = useCallback(async () => {
    if (!api || !client) return { failed: ["preload"], completed: 0 };
    const tasks: DiagnosticTask[] = [
      { label: "capabilities", run: async () => setCapabilities(await client.object("core.capabilities", () => api.app.getCapabilities())) },
      { label: "privacy audit", run: async () => setPrivacyAudit(await client.object("privacy.auditSnapshot", () => api.settings.getPrivacyAudit())) },
      { label: "network policy", run: async () => setNetworkCapabilities(await client.networkCapabilities()) },
      { label: "updates", run: async () => setUpdateStatus(await client.object("updates.status", () => api.settings.getUpdateStatus())) },
      { label: "legacy import", run: async () => setV2ImportStatus(await client.object("import.v2.status", () => api.meetings.getImportStatus())) },
      { label: "local AI", run: async () => setAiStatus(await client.object("ai.status", () => api.ai.getStatus())) },
      { label: "bundled local AI", run: async () => {
        try {
          setBundledAiStatus(await client.bundledAiStatus());
        } catch (error) {
          setBundledAiStatus(UNAVAILABLE_BUNDLED_AI_STATUS);
          throw error;
        }
      } },
      { label: "local AI assets", run: async () => setInstructAssetsStatus(await client.object("ai.instructAssetsStatus", () => api.ai.getEnhancedAssetsStatus())) },
      { label: "local AI readiness", run: async () => setInstructStatus(await client.object("ai.instructStatus", () => api.ai.getEnhancedStatus())) },
      { label: "model scheduler", run: async () => setSchedulerStatus(await client.object("ai.schedulerStatus", () => api.ai.getWorkloadStatus())) },
      { label: "speech models", run: async () => setModelStatus({ models: await client.models() as unknown as LocalJsonValue }) },
      { label: "transcription", run: async () => setTranscriptionStatus(await client.object("transcription.status", () => api.transcript.getStatus())) },
      { label: "transcription quality", run: async () => setTranscriptionQualityStatus(parseTranscriptionQualityStatus(await api.transcript.getQuality())) },
      { label: "retention", run: async () => setRetentionStatus(await client.object("retention.status", () => api.settings.getRetentionStatus())) },
    ];
    const result = await runBackgroundDiagnostics(tasks);
    setDiagnosticFailures(result.failed);
    return result;
  }, [api, client]);

  const refreshCapture = useCallback(async () => {
    if (!api || !client) return;
    const [nextCapture, nextConsent, nextRecording] = await Promise.all([
      client.object("capture.status", () => api.capture.getStatus()),
      client.object("consent.status", () => api.capture.getConsent()),
      client.object("recording.durable.status", () => api.meetings.getStorageStatus()),
    ]);
    setCaptureStatus(nextCapture);
    setConsentStatus(nextConsent);
    setRecordingStatus(nextRecording);
  }, [api, client]);

  const retryConnection = useCallback(async () => {
    if (!api) return;
    setRecoveryBusy(true);
    try {
      setConnectionStatus(asObject(await api.app.retryCore()));
      await refreshCapture();
    } finally {
      setRecoveryBusy(false);
    }
  }, [api, refreshCapture]);

  const refreshRecordingStatus = useCallback(async () => {
    if (!api || !client) return;
    setRecordingStatus(await client.object(
      "recording.durable.status",
      () => api.meetings.getStorageStatus(),
    ));
  }, [api, client]);

  const refreshJobs = useCallback(async () => {
    if (!api) return;
    const next = asObject(await api.app.listJobs());
    setJobs(asArray(next.jobs).map(asObject));
  }, [api]);

  const cancelJob = useCallback(async (jobId: string) => {
    if (!api) return;
    await api.app.cancelJob(jobId);
    await refreshJobs();
  }, [api, refreshJobs]);

  const retryJob = useCallback(async (jobId: string) => {
    if (!api) return;
    await api.app.retryJob(jobId);
    await refreshJobs();
  }, [api, refreshJobs]);

  const cancelAllJobs = useCallback(async () => {
    if (!api) return;
    await api.app.cancelAllJobs();
    await refreshJobs();
  }, [api, refreshJobs]);

  const acknowledgeJob = useCallback(async (jobId: string) => {
    if (!api) return;
    await api.app.acknowledgeJob(jobId);
    setJobs((current) => current.filter((job) => asString(job.jobId) !== jobId));
  }, [api]);

  useEffect(() => {
    if (!api || !client) return;
    const captureActive = captureStatus.active === true;
    const refreshDelayMs = captureActive ? 1_000 : 30_000;
    let cancelled = false;
    let timeout = 0;

    const poll = async () => {
      try {
        if (captureActive) await refreshCapture();
        else await refreshRecordingStatus();
      } catch {
        // The last measured state remains visible. Startup recovery owns disconnect handling.
      } finally {
        if (!cancelled) timeout = window.setTimeout(poll, refreshDelayMs);
      }
    };

    timeout = window.setTimeout(poll, refreshDelayMs);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [api, captureStatus.active, client, refreshCapture, refreshRecordingStatus]);

  const refreshModelsAndAi = useCallback(async () => {
    if (!api || !client) return;
    const [nextModels, nextAi, nextBundledAi, nextInstructAssets, nextInstruct, nextScheduler, nextTranscription, nextQuality] = await Promise.all([
      client.models(),
      client.object("ai.status", () => api.ai.getStatus()),
      client.bundledAiStatus().catch(() => UNAVAILABLE_BUNDLED_AI_STATUS),
      client.object("ai.instructAssetsStatus", () => api.ai.getEnhancedAssetsStatus()),
      client.object("ai.instructStatus", () => api.ai.getEnhancedStatus()),
      client.object("ai.schedulerStatus", () => api.ai.getWorkloadStatus()),
      client.object("transcription.status", () => api.transcript.getStatus()),
      api.transcript.getQuality().then(parseTranscriptionQualityStatus),
    ]);
    setModelStatus({ models: nextModels as unknown as LocalJsonValue });
    setAiStatus(nextAi);
    setBundledAiStatus(nextBundledAi);
    setInstructAssetsStatus(nextInstructAssets);
    setInstructStatus(nextInstruct);
    setSchedulerStatus(nextScheduler);
    setTranscriptionStatus(nextTranscription);
    setTranscriptionQualityStatus(nextQuality);
  }, [api, client]);

  const refreshPrivacyFacts = useCallback(async () => {
    if (!api || !client) return;
    const [nextPrivacy, nextCapabilities] = await Promise.all([
      client.object("privacy.auditSnapshot", () => api.settings.getPrivacyAudit()),
      client.networkCapabilities(),
    ]);
    setPrivacyAudit(nextPrivacy);
    setNetworkCapabilities(nextCapabilities);
  }, [api, client]);

  const refreshVaultAndRetention = useCallback(async () => {
    if (!api || !client) return;
    const [nextVault, nextRetention, nextRecording] = await Promise.all([
      client.object("vault.status", () => api.settings.getStorageStatus()),
      client.object("retention.status", () => api.settings.getRetentionStatus()),
      client.object("recording.durable.status", () => api.meetings.getStorageStatus()),
    ]);
    setVaultStatus(nextVault);
    setRetentionStatus(nextRetention);
    setRecordingStatus(nextRecording);
  }, [api, client]);

  return {
    coreStatus,
    connectionStatus,
    capabilities,
    privacyAudit,
    networkCapabilities,
    updateStatus,
    v2ImportStatus,
    consentStatus,
    vaultStatus,
    captureStatus,
    aiStatus,
    bundledAiStatus,
    instructAssetsStatus,
    instructStatus,
    schedulerStatus,
    modelStatus,
    transcriptionStatus,
    transcriptionQualityStatus,
    retentionStatus,
    recordingStatus,
    diagnosticFailures,
    jobs,
    recoveryBusy,
    setConsentStatus,
    loadCritical,
    loadDiagnostics,
    refreshCapture,
    refreshRecordingStatus,
    refreshModelsAndAi,
    refreshPrivacyFacts,
    refreshVaultAndRetention,
    recoverCapture,
    retryConnection,
    refreshJobs,
    cancelJob,
    retryJob,
    cancelAllJobs,
    acknowledgeJob,
  };
}
