import { useCallback, useState } from "react";
import type { CandorClient } from "../../core/candor-client";
import {
  type JsonObject,
  type LocalJsonValue,
  type NetworkCapabilities,
} from "../../core/contracts";

type CoreApi = NonNullable<Window["candor"]>["core"];

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
  const [instructAssetsStatus, setInstructAssetsStatus] = useState<JsonObject>({});
  const [instructStatus, setInstructStatus] = useState<JsonObject>({});
  const [schedulerStatus, setSchedulerStatus] = useState<JsonObject>({});
  const [modelStatus, setModelStatus] = useState<JsonObject>({ models: [] });
  const [transcriptionStatus, setTranscriptionStatus] = useState<JsonObject>({});
  const [retentionStatus, setRetentionStatus] = useState<JsonObject>({});
  const [diagnosticFailures, setDiagnosticFailures] = useState<string[]>([]);

  const loadCritical = useCallback(async () => {
    if (!api || !client) throw new Error("Candor preload API is unavailable");
    const [nextCore, nextConsent, nextVault, nextCapture] = await Promise.all([
      client.object("core.status", () => api.status()),
      client.object("consent.status", () => api.consentStatus()),
      client.object("vault.status", () => api.vaultStatus()),
      client.object("capture.status", () => api.captureStatus()),
    ]);
    setCoreStatus(nextCore);
    setConsentStatus(nextConsent);
    setVaultStatus(nextVault);
    setCaptureStatus(nextCapture);
  }, [api, client]);

  const loadDiagnostics = useCallback(async () => {
    if (!api || !client) return { failed: ["preload"], completed: 0 };
    const tasks: DiagnosticTask[] = [
      { label: "capabilities", run: async () => setCapabilities(await client.object("core.capabilities", () => api.capabilities())) },
      { label: "privacy audit", run: async () => setPrivacyAudit(await client.object("privacy.auditSnapshot", () => api.privacyAuditSnapshot())) },
      { label: "network policy", run: async () => setNetworkCapabilities(await client.networkCapabilities()) },
      { label: "updates", run: async () => setUpdateStatus(await client.object("updates.status", () => api.updateStatus())) },
      { label: "v2 import", run: async () => setV2ImportStatus(await client.object("import.v2.status", () => api.v2ImportStatus())) },
      { label: "local AI", run: async () => setAiStatus(await client.object("ai.status", () => api.aiStatus())) },
      { label: "local AI assets", run: async () => setInstructAssetsStatus(await client.object("ai.instructAssetsStatus", () => api.aiInstructAssetsStatus())) },
      { label: "local AI readiness", run: async () => setInstructStatus(await client.object("ai.instructStatus", () => api.aiInstructStatus())) },
      { label: "model scheduler", run: async () => setSchedulerStatus(await client.object("ai.schedulerStatus", () => api.aiSchedulerStatus())) },
      { label: "speech models", run: async () => setModelStatus({ models: await client.models() as unknown as LocalJsonValue }) },
      { label: "transcription", run: async () => setTranscriptionStatus(await client.object("transcription.status", () => api.transcriptionStatus())) },
      { label: "retention", run: async () => setRetentionStatus(await client.object("retention.status", () => api.retentionStatus())) },
    ];
    const result = await runBackgroundDiagnostics(tasks);
    setDiagnosticFailures(result.failed);
    return result;
  }, [api, client]);

  const refreshCapture = useCallback(async () => {
    if (!api || !client) return;
    const [nextCapture, nextConsent] = await Promise.all([
      client.object("capture.status", () => api.captureStatus()),
      client.object("consent.status", () => api.consentStatus()),
    ]);
    setCaptureStatus(nextCapture);
    setConsentStatus(nextConsent);
  }, [api, client]);

  const refreshModelsAndAi = useCallback(async () => {
    if (!api || !client) return;
    const [nextModels, nextAi, nextInstructAssets, nextInstruct, nextScheduler, nextTranscription] = await Promise.all([
      client.models(),
      client.object("ai.status", () => api.aiStatus()),
      client.object("ai.instructAssetsStatus", () => api.aiInstructAssetsStatus()),
      client.object("ai.instructStatus", () => api.aiInstructStatus()),
      client.object("ai.schedulerStatus", () => api.aiSchedulerStatus()),
      client.object("transcription.status", () => api.transcriptionStatus()),
    ]);
    setModelStatus({ models: nextModels as unknown as LocalJsonValue });
    setAiStatus(nextAi);
    setInstructAssetsStatus(nextInstructAssets);
    setInstructStatus(nextInstruct);
    setSchedulerStatus(nextScheduler);
    setTranscriptionStatus(nextTranscription);
  }, [api, client]);

  const refreshPrivacyFacts = useCallback(async () => {
    if (!api || !client) return;
    const [nextPrivacy, nextCapabilities] = await Promise.all([
      client.object("privacy.auditSnapshot", () => api.privacyAuditSnapshot()),
      client.networkCapabilities(),
    ]);
    setPrivacyAudit(nextPrivacy);
    setNetworkCapabilities(nextCapabilities);
  }, [api, client]);

  const refreshVaultAndRetention = useCallback(async () => {
    if (!api || !client) return;
    const [nextVault, nextRetention] = await Promise.all([
      client.object("vault.status", () => api.vaultStatus()),
      client.object("retention.status", () => api.retentionStatus()),
    ]);
    setVaultStatus(nextVault);
    setRetentionStatus(nextRetention);
  }, [api, client]);

  return {
    coreStatus,
    capabilities,
    privacyAudit,
    networkCapabilities,
    updateStatus,
    v2ImportStatus,
    consentStatus,
    vaultStatus,
    captureStatus,
    aiStatus,
    instructAssetsStatus,
    instructStatus,
    schedulerStatus,
    modelStatus,
    transcriptionStatus,
    retentionStatus,
    diagnosticFailures,
    setConsentStatus,
    loadCritical,
    loadDiagnostics,
    refreshCapture,
    refreshModelsAndAi,
    refreshPrivacyFacts,
    refreshVaultAndRetention,
  };
}

