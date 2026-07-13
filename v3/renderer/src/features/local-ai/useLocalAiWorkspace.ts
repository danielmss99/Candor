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
  type AiMode,
  type InstructAssetKind,
  type JsonObject,
  type LocalAiAnswer,
  type LocalAiRecap,
  type RecordingSummary,
} from "../../core/contracts";
import type { useLocalJob } from "../ai/useLocalJob";
import type { RunOperation } from "../jobs/useOperationRunner";
import { waitForJob } from "../../core/jobs";

type CoreApi = NonNullable<Window["candor"]>;
type LocalJob = ReturnType<typeof useLocalJob>;

interface UseLocalAiWorkspaceOptions {
  api: CoreApi | undefined;
  client: CandorClient | null;
  selectedRecordingId: string;
  selectedTrack: string;
  instructAssetsStatus: JsonObject;
  instructStatus: JsonObject;
  modelStatus: JsonObject;
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

export function useLocalAiWorkspace(options: UseLocalAiWorkspaceOptions) {
  const {
    api,
    client,
    selectedRecordingId,
    selectedTrack,
    instructAssetsStatus,
    instructStatus,
    modelStatus,
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
  const [selectedModel, setSelectedModel] = useState(DEFAULT_MODEL);
  const [askQuestion, setAskQuestion] = useState("What are the action items?");
  const [askAnswer, setAskAnswer] = useState<LocalAiAnswer | null>(null);
  const [recap, setRecap] = useState<LocalAiRecap | null>(null);
  const [aiMode, setAiMode] = useState<AiMode>("quality");
  const [instructAssetKind, setInstructAssetKind] = useState<InstructAssetKind>("runner");
  const [instructExpectedSha256, setInstructExpectedSha256] = useState("");
  const [instructAssetError, setInstructAssetError] = useState("");
  const [instructSetupOpen, setInstructSetupOpen] = useState(false);

  const instructReady = asBool(instructStatus.ready);
  const instructAssetsReady = asBool(instructAssetsStatus.ready);
  const instructRunnerAsset = asObject(instructAssetsStatus.runner);
  const instructModelAsset = asObject(instructAssetsStatus.model);
  const useInstructModel = aiMode === "quality" && instructReady;
  const models = useMemo(() => parseModels(modelStatus), [modelStatus]);
  const aiModeStatus = aiMode === "fast"
    ? "Fast local analysis"
    : instructReady
      ? "Best local model"
      : "Fast local fallback";

  const resetMeetingAi = useCallback(() => {
    setRecap(null);
    setAskAnswer(null);
  }, []);

  useEffect(() => {
    if (priorRecordingId.current === selectedRecordingId) return;
    priorRecordingId.current = selectedRecordingId;
    resetMeetingAi();
  }, [resetMeetingAi, selectedRecordingId]);

  const importModel = useCallback(async () => {
    if (!api) return;
    await run("import", async () => {
      const accepted = asObject(await api.ai.chooseSpeechModel(selectedModel));
      if (asBool(accepted.canceled)) {
        setNotice("Import canceled");
        return;
      }
      const result = asObject(await waitForJob(api, accepted));
      setNotice(asBool(result.imported) ? `${selectedModel} verified and installed` : "Model import finished");
      await refreshModelsAndAi();
    }, "local-model", "model-import");
  }, [api, refreshModelsAndAi, run, selectedModel, setNotice]);

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
      const accepted = await api.transcript.start({ recordingId: selectedRecordingId, channel: selectedTrack || undefined, modelId: selectedModel, language: "en" });
      await waitForJob(api, accepted);
      setNotice("Transcription updated");
      await Promise.all([
        loadRecording(selectedRecordingId, true),
        refreshLibrary(0),
        refreshModelsAndAi(),
      ]);
    }, "local-model", "transcription");
  }, [api, loadRecording, refreshLibrary, refreshModelsAndAi, run, selectedModel, selectedRecordingId, selectedTrack, setNotice]);

  const generateRecap = useCallback(async () => {
    if (!api || !selectedRecordingId) return;
    await run("recap", async () => {
      const accepted = await api.ai.generateRecap(selectedRecordingId, useInstructModel ? "best" : "fast");
      const result = await waitForJob(api, accepted);
      const nextRecap = client ? await client.recap(async () => result) : parseRecap(result);
      setRecap(nextRecap);
      setNotice(useInstructModel ? "Local model recap generated" : aiMode === "quality" ? "Fast local recap generated because the model is unavailable" : "Fast local recap generated");
      await refreshPrivacyReceipt();
    }, "local-model", "recap");
  }, [aiMode, api, client, refreshPrivacyReceipt, run, selectedRecordingId, setNotice, useInstructModel]);

  const ask = useCallback(async () => {
    if (!api || !selectedRecordingId) return;
    const question = askQuestion.trim();
    if (!question) {
      setError("Ask needs a question.");
      return;
    }
    await run("ask", async () => {
      const accepted = await api.ai.ask(selectedRecordingId, question, useInstructModel ? "best" : "fast");
      const result = await waitForJob(api, accepted);
      const answer = client ? await client.answer(async () => result) : parseAnswer(result);
      setAskAnswer(answer);
      setNotice(useInstructModel ? "Local model answer generated" : "Fast local answer generated");
      await refreshPrivacyReceipt();
    }, "local-model", "ask");
  }, [api, askQuestion, client, refreshPrivacyReceipt, run, selectedRecordingId, setError, setNotice, useInstructModel]);

  return {
    selectedModel,
    askQuestion,
    askAnswer,
    recap,
    aiMode,
    instructAssetKind,
    instructExpectedSha256,
    instructAssetError,
    instructSetupOpen,
    instructReady,
    instructAssetsReady,
    instructRunnerAsset,
    instructModelAsset,
    models,
    aiModeStatus,
    setSelectedModel,
    setAskQuestion,
    setAiMode,
    setInstructAssetKind,
    setInstructExpectedSha256,
    setInstructAssetError,
    setInstructSetupOpen,
    resetMeetingAi,
    importModel,
    importInstructAsset,
    verifyModel,
    transcribe,
    generateRecap,
    ask,
  };
}
