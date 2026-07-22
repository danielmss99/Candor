import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CandorClient } from "../../core/candor-client";
import {
  DEFAULT_MODEL,
  asBool,
  asObject,
  asString,
  parseAnswer,
  parseModels,
  parseRecap,
  parseTranscriptionQualityStatus,
  type AiMode,
  type BundledAiStatus,
  type InstructAssetKind,
  type JsonObject,
  type LocalJsonValue,
  type LocalAiAnswer,
  type LocalAiRecap,
  type RecordingSummary,
  type TranscriptionLanguagePreference,
  type TranscriptionQualityStatus,
  type TranscriptionQualityTier,
} from "../../core/contracts";
import type { useLocalJob } from "../ai/useLocalJob";
import type { RunOperation } from "../jobs/useOperationRunner";
import { BackgroundJobFailure, waitForJob } from "../../core/jobs";
import {
  EMPTY_MODEL_CATALOG,
  parseLocalModelCatalog,
  parseModelDownloadProgress,
  type LocalModelCatalogState,
  type ModelDownloadProgress,
} from "../models/model-library";

type CoreApi = NonNullable<Window["candor"]>;
type LocalJob = ReturnType<typeof useLocalJob>;
export type AiFallbackPreference = "ask-first" | "automatic" | "never";
export interface AiFallbackOffer {
  kind: "recap" | "ask";
  recordingId: string;
  question?: string;
  failureCode: string;
}

const FALLBACK_OFFERABLE_CODES = new Set([
  "LOCAL_LLM_UNAVAILABLE",
  "LOCAL_LLM_RUNTIME_FAILED",
  "LOCAL_LLM_RESOURCE_POLICY",
  "LOCAL_LLM_MODEL_CORRUPT",
  "LOCAL_LLM_BINARY_HASH_INVALID",
  "LOCAL_LLM_BINARY_HASH_MISMATCH",
  "LOCAL_LLM_BINARY_HASH_UNREADABLE",
  "LOCAL_LLM_MODEL_HASH_INVALID",
  "LOCAL_LLM_MODEL_HASH_MISMATCH",
  "LOCAL_LLM_MODEL_HASH_UNREADABLE",
  "LOCAL_LLM_BINARY_HASH_NOT_CONFIGURED",
  "LOCAL_LLM_BINARY_NOT_CONFIGURED",
  "LOCAL_LLM_BINARY_NOT_FOUND",
  "LOCAL_LLM_MODEL_HASH_NOT_CONFIGURED",
  "LOCAL_LLM_MODEL_NOT_CONFIGURED",
  "LOCAL_LLM_MODEL_NOT_FOUND",
  "LOCAL_LLM_NOT_READY",
  "LOCAL_LLM_COMMAND_FAILED",
  "LOCAL_LLM_COMMAND_SPAWN_FAILED",
  "LOCAL_LLM_COMMAND_TIMEOUT",
  "LOCAL_LLM_COMMAND_WAIT_FAILED",
  "LOCAL_LLM_OUTPUT_EMPTY",
  "LOCAL_LLM_OUTPUT_ENCODING_INVALID",
  "LOCAL_LLM_OUTPUT_READ_FAILED",
  "LOCAL_LLM_OUTPUT_READER_FAILED",
  "LOCAL_LLM_OUTPUT_TOO_LARGE",
  "LOCAL_LLM_STDERR_TOO_LARGE",
]);

export function canOfferExplicitFallback(error: unknown): error is BackgroundJobFailure {
  return error instanceof BackgroundJobFailure
    && error.state === "failed"
    && FALLBACK_OFFERABLE_CODES.has(error.code);
}

export function recordingScopedRecapRequest(
  recordingId: string,
  intent: "default" | "strict-retry" | "explicit-heuristic",
) {
  return { recordingId, intent };
}

export async function prepareTranscriptHandoff(api: CoreApi, recordingId: string): Promise<"cleaned" | "original"> {
  const accepted = await api.ai.cleanupTranscript(recordingId);
  const result = asObject(await waitForJob(api, accepted));
  return asBool(result.fallbackApplied) ? "original" : "cleaned";
}

interface UseLocalAiWorkspaceOptions {
  api: CoreApi | undefined;
  client: CandorClient | null;
  selectedRecordingId: string;
  selectedTrack: string;
  bundledAiStatus: BundledAiStatus;
  instructAssetsStatus: JsonObject;
  instructStatus: JsonObject;
  modelStatus: JsonObject;
  transcriptionQualityStatus: TranscriptionQualityStatus;
  jobs: BackgroundTask[];
  activeCapture: boolean;
  run: RunOperation;
  acquireOperation: (scope: string) => (() => void) | null;
  localJob: LocalJob;
  setBusy: (label: string) => void;
  setNotice: (message: string) => void;
  setError: (message: string) => void;
  refreshModelsAndAi: () => Promise<void>;
  refreshLibrary: (offset?: number) => Promise<RecordingSummary[]>;
  loadRecording: (recordingId: string, preserveAi?: boolean) => Promise<void>;
  refreshPrivacyReceipt: (recordingId?: string) => Promise<void>;
}

export function speechModelForBundledDefault(
  currentModel: string,
  bundledAiStatus: BundledAiStatus,
  explicitSelection = false,
): string {
  if (explicitSelection) {
    return currentModel;
  }
  return bundledAiStatus.speech.ready
    ? bundledAiStatus.speech.modelId ?? DEFAULT_MODEL
    : currentModel;
}

interface AutomaticBenchmarkState {
  bundledReady: boolean;
  benchmarkState: TranscriptionQualityStatus["benchmarkState"];
  activeCapture: boolean;
  benchmarkJobActive: boolean;
  benchmarkNeedsRetry: boolean;
  completedJobAwaitingRefresh: boolean;
  balancedNeedsFreshBenchmark: boolean;
}

export function shouldStartAutomaticBenchmark(state: AutomaticBenchmarkState): boolean {
  const benchmarkNeeded = state.benchmarkState === "not-run"
    || state.balancedNeedsFreshBenchmark;
  return state.bundledReady
    && benchmarkNeeded
    && !state.activeCapture
    && !state.benchmarkJobActive
    && !state.benchmarkNeedsRetry
    && !state.completedJobAwaitingRefresh;
}

export function benchmarkRetryRequired(
  status: TranscriptionQualityStatus,
  benchmarkJob: BackgroundTask | undefined,
): boolean {
  return status.benchmarkFailureTier !== null
    || status.benchmarkState === "failed"
    || (status.benchmarkState === "not-run"
      && Boolean(benchmarkJob)
      && Boolean(benchmarkJob?.terminal)
      && benchmarkJob?.state !== "completed");
}

export function useLocalAiWorkspace(options: UseLocalAiWorkspaceOptions) {
  const {
    api,
    client,
    selectedRecordingId,
    selectedTrack,
    bundledAiStatus,
    instructAssetsStatus,
    instructStatus,
    modelStatus,
    transcriptionQualityStatus,
    jobs,
    activeCapture,
    run,
    acquireOperation,
    localJob,
    setBusy,
    setNotice,
    setError,
    refreshModelsAndAi,
    refreshLibrary,
    loadRecording,
    refreshPrivacyReceipt,
  } = options;
  const priorRecordingId = useRef(selectedRecordingId);
  const explicitModelSelection = useRef(false);
  const automaticBenchmarkAttempt = useRef("");
  const [selectedModel, setSelectedModel] = useState(DEFAULT_MODEL);
  const [askQuestion, setAskQuestion] = useState("What are the action items?");
  const [askAnswer, setAskAnswer] = useState<LocalAiAnswer | null>(null);
  const [recap, setRecap] = useState<LocalAiRecap | null>(null);
  const [aiMode, setAiMode] = useState<AiMode>("local-llm");
  const [aiFallbackPreference, setAiFallbackPreference] = useState<AiFallbackPreference>("ask-first");
  const [fallbackOffer, setFallbackOffer] = useState<AiFallbackOffer | null>(null);
  const [instructAssetKind, setInstructAssetKind] = useState<InstructAssetKind>("runner");
  const [instructExpectedSha256, setInstructExpectedSha256] = useState("");
  const [instructAssetError, setInstructAssetError] = useState("");
  const [instructSetupOpen, setInstructSetupOpen] = useState(false);
  const [modelCatalog, setModelCatalog] = useState<LocalModelCatalogState>(EMPTY_MODEL_CATALOG);
  const [modelDownloadProgress, setModelDownloadProgress] = useState<ModelDownloadProgress | null>(null);

  const refreshModelCatalog = useCallback(async () => {
    if (!api) return;
    setModelCatalog(parseLocalModelCatalog(await api.ai.getModelCatalog() as unknown as LocalJsonValue));
  }, [api]);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    void api.ai.getModelCatalog().then((value) => {
      if (!cancelled) setModelCatalog(parseLocalModelCatalog(value as unknown as LocalJsonValue));
    }).catch(() => {
      if (!cancelled) setModelCatalog({ ...EMPTY_MODEL_CATALOG, loaded: true });
    });
    const unsubscribe = api.events.subscribe("model.downloadProgress", (payload) => {
      if (cancelled) return;
      const progress = parseModelDownloadProgress(payload as unknown as LocalJsonValue);
      if (progress) setModelDownloadProgress(progress);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [api]);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    void api.ai.getFallbackPreference().then((value) => {
      if (cancelled) return;
      const preference = asString(asObject(value).preference, "ask-first");
      setAiFallbackPreference(
        preference === "automatic" || preference === "never" ? preference : "ask-first",
      );
    }).catch(() => {
      if (!cancelled) setAiFallbackPreference("ask-first");
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const instructReady = asBool(instructStatus.ready);
  const instructRunnerAsset = asObject(instructAssetsStatus.runner);
  const instructModelAsset = asObject(instructAssetsStatus.model);
  const models = useMemo(() => parseModels(modelStatus), [modelStatus]);
  const aiModeStatus = aiMode === "heuristic-fallback"
    ? "Quick local fallback"
    : instructReady
      ? "Local AI ready"
      : aiFallbackPreference === "automatic"
        ? "Local AI with automatic fallback"
        : aiFallbackPreference === "never"
          ? "Local AI only"
          : "Local AI, asks before fallback";
  const benchmarkJob = useMemo(
    () => jobs.find((job) => job.type === "local-ai-benchmark"),
    [jobs],
  );
  const benchmarkActive = Boolean(benchmarkJob) && !benchmarkJob?.terminal;
  const benchmarkNeedsRetry = benchmarkRetryRequired(transcriptionQualityStatus, benchmarkJob);
  const balancedNeedsFreshBenchmark = transcriptionQualityStatus.tiers.some(
    (tier) => tier.id === "balanced"
      && tier.guardReason === "balanced-requires-fresh-local-benchmark-for-current-model",
  );
  const completedBenchmarkAwaitingRefresh = Boolean(benchmarkJob)
    && asBool(benchmarkJob?.terminal)
    && asString(benchmarkJob?.state) === "completed"
    && transcriptionQualityStatus.benchmarkState === "not-run";

  const resetMeetingAi = useCallback(() => {
    setRecap(null);
    setAskAnswer(null);
    setFallbackOffer(null);
  }, []);

  useEffect(() => {
    if (priorRecordingId.current === selectedRecordingId) return;
    priorRecordingId.current = selectedRecordingId;
    resetMeetingAi();
  }, [resetMeetingAi, selectedRecordingId]);

  useEffect(() => {
    setSelectedModel((currentModel) => speechModelForBundledDefault(
      currentModel,
      bundledAiStatus,
      explicitModelSelection.current,
    ));
  }, [bundledAiStatus]);

  useEffect(() => {
    if (explicitModelSelection.current || !modelCatalog.recommendedDefaultModelId) return;
    setSelectedModel(modelCatalog.recommendedDefaultModelId);
  }, [modelCatalog.recommendedDefaultModelId]);

  const startBenchmarkJob = useCallback(async (tier: "balanced" | "maximum") => {
    if (!api) return;
    const accepted = await api.transcript.startQualityBenchmark({ tier });
    try {
      await waitForJob(api, accepted);
    } catch (error) {
      const terminalJob: JsonObject = await api.app.getJob(accepted.jobId)
        .then(asObject)
        .catch((): JsonObject => ({}));
      if (asBool(terminalJob.terminal)) {
        await api.app.acknowledgeJob(accepted.jobId).catch(() => undefined);
      }
      throw error;
    } finally {
      await refreshModelsAndAi();
    }
  }, [api, refreshModelsAndAi]);

  useEffect(() => {
    if (!benchmarkJob || !benchmarkJob.terminal) return;
    if (transcriptionQualityStatus.benchmarkState !== "not-run") return;
    void refreshModelsAndAi();
  }, [benchmarkJob, refreshModelsAndAi, transcriptionQualityStatus.benchmarkState]);

  useEffect(() => {
    if (!api || !shouldStartAutomaticBenchmark({
      bundledReady: bundledAiStatus.ready,
      benchmarkState: transcriptionQualityStatus.benchmarkState,
      activeCapture,
      benchmarkJobActive: benchmarkActive,
      benchmarkNeedsRetry,
      completedJobAwaitingRefresh: completedBenchmarkAwaitingRefresh,
      balancedNeedsFreshBenchmark,
    })) return;
    const attemptKey = `${bundledAiStatus.selectionStatus}:balanced`;
    if (automaticBenchmarkAttempt.current === attemptKey) return;
    automaticBenchmarkAttempt.current = attemptKey;
    void startBenchmarkJob("balanced").catch(() => {
      void refreshModelsAndAi();
    });
  }, [
    activeCapture,
    api,
    balancedNeedsFreshBenchmark,
    benchmarkActive,
    benchmarkJob,
    benchmarkNeedsRetry,
    bundledAiStatus.ready,
    bundledAiStatus.selectionStatus,
    completedBenchmarkAwaitingRefresh,
    refreshModelsAndAi,
    startBenchmarkJob,
    transcriptionQualityStatus.benchmarkState,
  ]);

  const selectModel = useCallback((modelId: string) => {
    explicitModelSelection.current = true;
    setSelectedModel(modelId);
  }, []);

  const importModel = useCallback(async (requestedModelId?: string) => {
    if (!api) return;
    const modelId = requestedModelId ?? selectedModel;
    if (requestedModelId) selectModel(requestedModelId);
    await run("import", async () => {
      const accepted = asObject(await api.ai.chooseSpeechModel(modelId));
      if (asBool(accepted.canceled)) {
        setNotice("Import canceled");
        return;
      }
      const result = asObject(await waitForJob(api, accepted));
      setNotice(asBool(result.imported) ? `${modelId} verified and installed` : "Model import finished");
      await Promise.all([refreshModelsAndAi(), refreshModelCatalog()]);
    }, "local-model", "model-import");
  }, [api, refreshModelCatalog, refreshModelsAndAi, run, selectModel, selectedModel, setNotice]);

  const downloadModel = useCallback(async (modelId: string) => {
    if (!api || activeCapture) return;
    await run("model download", async () => {
      setModelDownloadProgress({ modelId, state: "downloading", bytesReceived: 0, totalBytes: 0 });
      const accepted = await api.ai.downloadModel(modelId);
      const result = asObject(await waitForJob(api, accepted));
      if (!asBool(result.verified) && !asBool(result.imported)) {
        throw new Error("The downloaded model did not finish its local integrity check.");
      }
      setModelDownloadProgress(null);
      setNotice(`${modelId} downloaded, verified, and stored locally`);
      await Promise.all([refreshModelsAndAi(), refreshModelCatalog()]);
    }, "local-model", "model-download");
  }, [activeCapture, api, refreshModelCatalog, refreshModelsAndAi, run, setNotice]);

  const cancelModelDownload = useCallback(async (modelId: string) => {
    if (!api) return;
    const result = asObject(await api.ai.cancelModelDownload(modelId));
    if (asBool(result.canceled)) setNotice("Model download canceled");
  }, [api, setNotice]);

  const importInstructAsset = useCallback(async () => {
    if (!api) return;
    const expectedSha256 = instructExpectedSha256.trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
      setInstructAssetError("Enter exactly 64 hexadecimal characters.");
      return;
    }
    const release = acquireOperation("local-model");
    if (!release) {
      setNotice("A local model import is already in progress");
      return;
    }
    const requestId = localJob.begin("model-import");
    setBusy("instruct-asset");
    setError("");
    setNotice("");
    setInstructAssetError("");
    try {
      const accepted = asObject(await api.ai.chooseEnhancedComponent({
        component: instructAssetKind === "runner" ? "engine" : "model",
        expectedSha256,
      }));
      if (asBool(accepted.canceled)) {
        localJob.cancel(requestId);
        localJob.reset();
        setNotice("Local AI import canceled");
        return;
      }
      const result = asObject(await waitForJob(api, accepted));
      if (!asBool(result.imported) || !asBool(result.integrityVerified)) {
        throw new Error("Local AI asset was not verified.");
      }
      setInstructExpectedSha256("");
      setNotice(`${instructAssetKind === "runner" ? "Processing engine" : "Language model"} verified and stored locally`);
      await refreshModelsAndAi();
      localJob.complete(requestId);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setInstructAssetError(message);
      setError(message);
      localJob.fail(requestId, message);
    } finally {
      setBusy("");
      release();
    }
  }, [acquireOperation, api, instructAssetKind, instructExpectedSha256, localJob, refreshModelsAndAi, setBusy, setError, setNotice]);

  const verifyModel = useCallback(async () => {
    if (!api) return;
    await run("verify", async () => {
      const accepted = await api.ai.verifySpeechModel(selectedModel);
      const result = asObject(await waitForJob(api, accepted));
      setNotice(asBool(result.verified) ? `${selectedModel} verified` : `${selectedModel}: ${asString(result.failureCode, "not ready")}`);
      await refreshModelsAndAi();
    }, "local-model");
  }, [api, refreshModelsAndAi, run, selectedModel, setNotice]);

  const transcribe = useCallback(async () => {
    if (!api || !selectedRecordingId) return;
    await run("transcribe", async () => {
      const accepted = await api.transcript.start({
        recordingId: selectedRecordingId,
        channel: selectedTrack || undefined,
        modelId: explicitModelSelection.current ? selectedModel : undefined,
      });
      await waitForJob(api, accepted);
      setNotice("Transcription updated");
      await Promise.all([
        loadRecording(selectedRecordingId, true),
        refreshLibrary(0),
      ]);
      await refreshModelsAndAi();
    }, "local-model", "transcription");
  }, [api, loadRecording, refreshLibrary, refreshModelsAndAi, run, selectedModel, selectedRecordingId, selectedTrack, setNotice]);

  const updateTranscriptionQuality = useCallback(async (
    tier: TranscriptionQualityTier,
    languagePreference?: TranscriptionLanguagePreference,
  ) => {
    if (!api) return;
    await run("transcription quality", async () => {
      const result = parseTranscriptionQualityStatus(await api.transcript.setQuality({
        tier,
        ...(languagePreference ? { languagePreference } : {}),
      }));
      if (result.fallbackApplied && result.guardReason) {
        setNotice(`${result.tiers.find((item) => item.id === tier)?.label ?? "That quality"} is unavailable. ${result.tiers.find((item) => item.id === result.tier)?.label ?? "A safer quality"} was selected.`);
      } else {
        setNotice(`${result.tiers.find((item) => item.id === result.tier)?.label ?? "Transcription quality"} saved`);
      }
      await refreshModelsAndAi();
    }, "local-model");
  }, [api, refreshModelsAndAi, run, setNotice]);

  const runTranscriptionBenchmark = useCallback(async (tier: "balanced" | "maximum" = "balanced") => {
    if (!api || benchmarkActive || activeCapture) return;
    await run("performance check", async () => {
      await startBenchmarkJob(tier);
      setNotice("Local performance check completed");
    }, "local-model", "local-ai-benchmark");
  }, [activeCapture, api, benchmarkActive, run, setNotice, startBenchmarkJob]);

  const updateAiFallbackPreference = useCallback(async (preference: AiFallbackPreference) => {
    if (!api) return;
    await run("fallback preference", async () => {
      const result = asObject(await api.ai.setFallbackPreference(preference));
      const saved = asString(result.preference, "ask-first");
      const nextPreference = saved === "automatic" || saved === "never" ? saved : "ask-first";
      setAiFallbackPreference(nextPreference);
      if (nextPreference === "never") setAiMode("local-llm");
      setFallbackOffer(null);
      setNotice("Local AI fallback preference saved");
    }, "local-ai-settings");
  }, [api, run, setNotice]);

  const generateRecap = useCallback(async () => {
    if (!api || !selectedRecordingId) return;
    await run("recap", async () => {
      const recapInput = aiMode === "local-llm"
        ? await prepareTranscriptHandoff(api, selectedRecordingId)
        : "original";
      const accepted = await api.ai.generateRecap(recordingScopedRecapRequest(
        selectedRecordingId,
        aiMode === "heuristic-fallback" ? "explicit-heuristic" : "default",
      ));
      let result: LocalJsonValue;
      try {
        result = await waitForJob(api, accepted);
      } catch (error) {
        if (aiMode === "local-llm" && aiFallbackPreference === "ask-first" && canOfferExplicitFallback(error)) {
          setFallbackOffer({
            kind: "recap",
            recordingId: selectedRecordingId,
            failureCode: error.code,
          });
        }
        throw error;
      }
      const nextRecap = client ? await client.recap(async () => result) : parseRecap(result);
      setRecap(nextRecap);
      setFallbackOffer(null);
      setNotice(nextRecap.provenance.fallbackUsed
        ? "Recap created with the disclosed local fallback"
        : recapInput === "cleaned"
          ? "Local AI recap generated from the cleaned transcript"
          : "Local AI recap generated from the original transcript");
      await refreshPrivacyReceipt();
    }, "local-model", "recap");
  }, [aiFallbackPreference, aiMode, api, client, refreshPrivacyReceipt, run, selectedRecordingId, setNotice]);

  const retryRecapWithLocalAi = useCallback(async () => {
    if (!api || !selectedRecordingId) return;
    await run("recap", async () => {
      const recapInput = await prepareTranscriptHandoff(api, selectedRecordingId);
      const accepted = await api.ai.generateRecap(recordingScopedRecapRequest(
        selectedRecordingId,
        "strict-retry",
      ));
      const result = await waitForJob(api, accepted);
      const nextRecap = client ? await client.recap(async () => result) : parseRecap(result);
      setRecap(nextRecap);
      setFallbackOffer(null);
      setNotice(recapInput === "cleaned"
        ? "Local AI recap generated from the cleaned transcript"
        : "Local AI recap generated from the original transcript");
      await refreshPrivacyReceipt();
    }, "local-model", "recap");
  }, [api, client, refreshPrivacyReceipt, run, selectedRecordingId, setNotice]);

  const ask = useCallback(async () => {
    if (!api || !selectedRecordingId) return;
    const question = askQuestion.trim();
    if (!question) {
      setError("Ask needs a question.");
      return;
    }
    await run("ask", async () => {
      const accepted = await api.ai.ask({
        recordingId: selectedRecordingId,
        question,
        intent: aiMode === "heuristic-fallback" ? "explicit-heuristic" : "default",
      });
      let result: LocalJsonValue;
      try {
        result = await waitForJob(api, accepted);
      } catch (error) {
        if (aiMode === "local-llm" && aiFallbackPreference === "ask-first" && canOfferExplicitFallback(error)) {
          setFallbackOffer({
            kind: "ask",
            recordingId: selectedRecordingId,
            question,
            failureCode: error.code,
          });
        }
        throw error;
      }
      const answer = client ? await client.answer(async () => result) : parseAnswer(result);
      setAskAnswer(answer);
      setFallbackOffer(null);
      setNotice(answer.provenance.fallbackUsed ? "Answer created with the disclosed local fallback" : "Local AI answer generated");
      await refreshPrivacyReceipt();
    }, "local-model", "ask");
  }, [aiFallbackPreference, aiMode, api, askQuestion, client, refreshPrivacyReceipt, run, selectedRecordingId, setError, setNotice]);

  const retryAskWithLocalAi = useCallback(async () => {
    if (!api || !selectedRecordingId) return;
    const question = askAnswer?.question || fallbackOffer?.question || askQuestion.trim();
    if (!question) return;
    await run("ask", async () => {
      const accepted = await api.ai.ask({
        recordingId: selectedRecordingId,
        question,
        intent: "strict-retry",
      });
      const result = await waitForJob(api, accepted);
      const answer = client ? await client.answer(async () => result) : parseAnswer(result);
      setAskAnswer(answer);
      setFallbackOffer(null);
      setNotice("Local AI answer generated");
      await refreshPrivacyReceipt();
    }, "local-model", "ask");
  }, [api, askAnswer, askQuestion, client, fallbackOffer, refreshPrivacyReceipt, run, selectedRecordingId, setNotice]);

  const createQuickFallback = useCallback(async () => {
    if (!api || !fallbackOffer) return;
    const offer = fallbackOffer;
    await run("quick fallback", async () => {
      if (offer.kind === "recap") {
        const accepted = await api.ai.generateRecap(recordingScopedRecapRequest(
          offer.recordingId,
          "explicit-heuristic",
        ));
        const result = await waitForJob(api, accepted);
        const nextRecap = client ? await client.recap(async () => result) : parseRecap(result);
        setRecap(nextRecap);
      } else {
        const accepted = await api.ai.ask({
          recordingId: offer.recordingId,
          question: offer.question ?? askQuestion.trim(),
          intent: "explicit-heuristic",
        });
        const result = await waitForJob(api, accepted);
        const answer = client ? await client.answer(async () => result) : parseAnswer(result);
        setAskAnswer(answer);
      }
      setFallbackOffer(null);
      setNotice("Quick local fallback created");
      await refreshPrivacyReceipt(offer.recordingId);
    }, "local-model", offer.kind);
  }, [api, askQuestion, client, fallbackOffer, refreshPrivacyReceipt, run, setNotice]);

  return {
    selectedModel,
    askQuestion,
    askAnswer,
    recap,
    aiMode,
    aiFallbackPreference,
    fallbackOffer,
    instructAssetKind,
    instructExpectedSha256,
    instructAssetError,
    instructSetupOpen,
    instructReady,
    instructRunnerAsset,
    instructModelAsset,
    models,
    modelCatalog,
    modelDownloadProgress,
    transcriptionQualityStatus,
    benchmarkActive,
    benchmarkNeedsRetry,
    aiModeStatus,
    setSelectedModel: selectModel,
    setAskQuestion,
    setAiMode,
    updateAiFallbackPreference,
    dismissFallbackOffer: () => setFallbackOffer(null),
    setInstructAssetKind,
    setInstructExpectedSha256,
    setInstructAssetError,
    setInstructSetupOpen,
    resetMeetingAi,
    importModel,
    downloadModel,
    cancelModelDownload,
    importInstructAsset,
    verifyModel,
    updateTranscriptionQuality,
    runTranscriptionBenchmark,
    transcribe,
    generateRecap,
    retryRecapWithLocalAi,
    ask,
    retryAskWithLocalAi,
    createQuickFallback,
  };
}
