import type { JsonValue } from "./json.js";
import { CoreClientError } from "./core-errors.js";
import {
  createRuntimeSchema,
  jsonObjectResultSchema,
  jsonParamsSchema,
  type FieldRule,
  type JsonRuntimeSchema,
} from "./runtime-schema.js";
import { validatePrivateCoreParams } from "../security/validate-private-core-input.js";
import { validateRendererCoreParams } from "../security/validate-core-input.js";

export type CoreOperationMode = "request" | "job";
export type CoreOperationScope = "private" | "renderer";

export interface CoreOperationDefinition<TParams = JsonValue, TResult = JsonValue> {
  readonly method: string;
  readonly paramsSchema: JsonRuntimeSchema;
  readonly resultSchema: JsonRuntimeSchema;
  readonly timeoutMs: number;
  readonly requiresHandshake: boolean;
  readonly mode: CoreOperationMode;
  readonly scope: CoreOperationScope;
  readonly channel?: `candor-core:${string}`;
  readonly __params?: TParams;
  readonly __result?: TResult;
}

interface OperationConfig {
  readonly method: string;
  readonly channel?: `candor-core:${string}`;
  readonly timeoutMs?: number;
  readonly mode?: CoreOperationMode;
  readonly result: Readonly<Record<string, FieldRule>>;
  readonly resultSchema?: JsonRuntimeSchema;
}

function invalidResult(method: string, field: string): never {
  throw new CoreClientError(
    "CORE_RESULT_SCHEMA_INVALID",
    `candor-core returned an invalid ${field} field for ${method}`,
    false,
  );
}

function objectResult(value: JsonValue, method: string, field: string): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalidResult(method, field);
  }
  return value;
}

function transcriptionQualityResultSchema(method: string): JsonRuntimeSchema {
  const outer = jsonObjectResultSchema(method, {
    implemented: "boolean",
    state: "string",
    tier: "string",
    languagePreference: "string",
    recommendedTier: "string",
    benchmarkState: "string",
    estimatedMinutesPerHour: "integer-or-null",
    estimatedCompletionAvailable: "boolean",
    hardware: "object",
    tiers: "array",
    localOnly: "boolean",
    cloudAi: "boolean",
    rawPathExposed: "boolean",
  });
  return createRuntimeSchema(`${method}.result`, (value) => {
    const parsed = outer.parse(value);
    const result = objectResult(parsed, method, "result");
    const estimate = result.estimatedMinutesPerHour;
    if (
      result.localOnly !== true
      || result.cloudAi !== false
      || result.rawPathExposed !== false
      || result.estimatedRealTimeFactor !== null
      || (estimate !== null && (
        typeof estimate !== "number"
        || estimate < 1
        || estimate > 60
      ))
      || result.estimatedCompletionAvailable !== (estimate !== null)
    ) {
      return invalidResult(method, "local completion estimate");
    }
    return parsed;
  });
}

function strictLocalAiResultSchema(method: string, mode: "ask" | "recap"): JsonRuntimeSchema {
  const outer = jsonObjectResultSchema(method, {
    recordingId: "string",
    engine: "string",
    citations: "array",
    localOnly: "boolean",
    rawPathExposed: "boolean",
  });
  return createRuntimeSchema(`${method}.result`, (value) => {
    const parsed = outer.parse(value);
    const result = objectResult(parsed, method, "result");
    if (result.localOnly !== true || result.rawPathExposed !== false) {
      return invalidResult(method, "local custody");
    }
    if (result.engine !== "llama-cpp-local") return parsed;
    if (
      result.strictOutputValidated !== true
      || result.outputSchemaVersion !== 1
      || result.groundingMethod !== "strict-source-id-and-exact-critical-evidence-v1"
      || result.modelOutputGrounded !== true
      || result.citationsAddedByCore !== false
      || result.unsupportedClaimsRemoved !== 0
    ) {
      return invalidResult(method, "strict grounding metadata");
    }

    const citations = result.citations as JsonValue[];
    const citationIds = new Set<string>();
    for (const [index, value] of citations.entries()) {
      const citation = objectResult(value, method, `citations[${index}]`);
      if (
        typeof citation.citationId !== "string"
        || !/^s\d+$/.test(citation.citationId)
        || typeof citation.segmentIndex !== "number"
        || !Number.isSafeInteger(citation.segmentIndex)
        || typeof citation.startMs !== "number"
        || !Number.isSafeInteger(citation.startMs)
        || typeof citation.quote !== "string"
        || citation.quote.length === 0
        || citation.rawPathExposed !== false
      ) {
        return invalidResult(method, `citations[${index}]`);
      }
      if (citationIds.has(citation.citationId)) {
        return invalidResult(method, `citations[${index}].citationId`);
      }
      citationIds.add(citation.citationId);
    }

    if (!Array.isArray(result.sourceIds) || result.sourceIds.some((sourceId) => (
      typeof sourceId !== "string" || !citationIds.has(sourceId)
    ))) {
      return invalidResult(method, "sourceIds");
    }

    const sectionNames = ["decisions", "actions", "risks", "questions"] as const;
    for (const sectionName of sectionNames) {
      const section = result[sectionName];
      if (!Array.isArray(section)) return invalidResult(method, sectionName);
      for (const [index, value] of section.entries()) {
        const claim = objectResult(value, method, `${sectionName}[${index}]`);
        if (
          typeof claim.text !== "string"
          || claim.text.length === 0
          || !Array.isArray(claim.sourceIds)
          || claim.sourceIds.length === 0
          || claim.sourceIds.some((sourceId) => typeof sourceId !== "string" || !citationIds.has(sourceId))
        ) {
          return invalidResult(method, `${sectionName}[${index}]`);
        }
        if (sectionName === "actions"
            && claim.confidence !== "high"
            && claim.confidence !== "medium"
            && claim.confidence !== "low") {
          return invalidResult(method, `${sectionName}[${index}].confidence`);
        }
      }
    }

    if (mode === "ask") {
      if (typeof result.answer !== "string" || typeof result.answerFound !== "boolean") {
        return invalidResult(method, "answer");
      }
      if (result.answerFound && (result.sourceIds as JsonValue[]).length === 0) {
        return invalidResult(method, "answer sourceIds");
      }
    } else if (typeof result.summary !== "string" || typeof result.recapMarkdown !== "string") {
      return invalidResult(method, "recap content");
    }
    return parsed;
  });
}

const rendererConfigs: readonly OperationConfig[] = [
  { method: "core.ping", channel: "candor-core:core-ping", result: { pong: "boolean" } },
  { method: "core.version", channel: "candor-core:core-version", result: { version: "string", protocolVersion: "string", schemaVersion: "integer", capabilities: "string-array", build: "object" } },
  { method: "core.capabilities", channel: "candor-core:core-capabilities", result: { transport: "string", maxRpcFrameBytes: "integer", allowedMethods: "string-array", deniedCapabilities: "string-array" } },
  { method: "core.status", channel: "candor-core:core-status", result: { version: "string", protocolVersion: "string", uptimeMs: "integer", networkPolicy: "string", updaterPolicy: "string", vaultState: "string", sidecarTransport: "string", startupRecovery: "object" } },
  { method: "vault.openLocal", channel: "candor-core:vault-open-local", result: { state: "string", backend: "string", encrypted: "boolean", schemaVersion: "integer", rawPathExposed: "boolean" } },
  { method: "vault.status", channel: "candor-core:vault-status", result: { state: "string", backend: "string", encrypted: "boolean", rawPathExposed: "boolean" } },
  { method: "privacy.auditSnapshot", channel: "candor-core:privacy-audit-snapshot", result: { networkPolicy: "string", externalCallsAttempted: "integer", recordedAt: "integer" } },
  { method: "privacy.capabilities", channel: "candor-core:privacy-capabilities", result: { policy: "string", externalCallsAttempted: "integer", capabilities: "array", rawPathExposed: "boolean" } },
  { method: "updates.status", channel: "candor-core:updates-status", result: { implemented: "boolean", policy: "string", backgroundChecks: "boolean", rawPathExposed: "boolean" } },
  { method: "import.v2.status", channel: "candor-core:v2-import-status", result: { implemented: "boolean", localOnly: "boolean", originalsUntouched: "boolean", rawPathExposed: "boolean" } },
  { method: "consent.status", channel: "candor-core:consent-status", result: { schemaVersion: "integer", items: "array", readyForMicRecording: "boolean", readyForSystemAudioRecording: "boolean", rawPathExposed: "boolean" } },
  { method: "consent.acknowledge", channel: "candor-core:consent-acknowledge", result: { schemaVersion: "integer", items: "array", readyForMicRecording: "boolean", readyForSystemAudioRecording: "boolean", rawPathExposed: "boolean" } },
  { method: "capture.status", channel: "candor-core:capture-status", result: { implemented: "boolean", active: "boolean", activeSession: "capture-session-or-null", sources: "object", rawPathExposed: "boolean" } },
  { method: "capture.devices", channel: "candor-core:capture-devices", result: { defaultInputAvailable: "boolean", defaultOutputAvailable: "boolean", inputs: "array", outputs: "array", rawPathExposed: "boolean" } },
  { method: "capture.startMic", channel: "candor-core:capture-start-mic", timeoutMs: 15_000, result: { recording: "object", capture: "object", rawPathExposed: "boolean" } },
  { method: "capture.startSystem", channel: "candor-core:capture-start-system", timeoutMs: 15_000, result: { recording: "object", capture: "object", rawPathExposed: "boolean" } },
  { method: "capture.startMicAndSystem", channel: "candor-core:capture-start-mic-and-system", timeoutMs: 20_000, result: { recording: "object", capture: "object", rawPathExposed: "boolean" } },
  { method: "capture.stop", channel: "candor-core:capture-stop", timeoutMs: 20_000, result: { recording: "object", capture: "object", rawPathExposed: "boolean" } },
  { method: "models.status", channel: "candor-core:models-status", result: { implemented: "boolean", localOnly: "boolean", models: "array", rawPathExposed: "boolean" } },
  { method: "models.listLocal", channel: "candor-core:models-list-local", result: { localOnly: "boolean", installedModelCount: "integer", models: "array", rawPathExposed: "boolean" } },
  { method: "models.verifyLocal", channel: "candor-core:models-verify-local", timeoutMs: 120_000, result: { modelId: "string", installed: "boolean", verified: "boolean", rawPathExposed: "boolean" } },
  { method: "ai.status", channel: "candor-core:ai-status", result: { implemented: "boolean", localOnly: "boolean", engine: "string", rawPathExposed: "boolean" } },
  { method: "ai.bundledAssetsStatus", channel: "candor-core:ai-bundled-assets-status", result: { implemented: "boolean", localOnly: "boolean", cloudAi: "boolean", releaseReady: "boolean", fixture: "boolean", selectionStatus: "string", state: "string", ready: "boolean", repairRequired: "boolean", repairPolicy: "string", repairAction: "string", speech: "object", language: "object", requiredDownload: "boolean", backgroundDownloads: "boolean", runtimePathAcceptedFromRenderer: "boolean", rawPathExposed: "boolean", hashExposed: "boolean", keyMaterialExposedToRenderer: "boolean" } },
  { method: "ai.instructAssetsStatus", channel: "candor-core:ai-instruct-assets-status", result: { implemented: "boolean", localOnly: "boolean", rawPathExposed: "boolean" } },
  { method: "ai.instructStatus", channel: "candor-core:ai-instruct-status", result: { implemented: "boolean", localOnly: "boolean", rawPathExposed: "boolean" } },
  { method: "ai.schedulerStatus", channel: "candor-core:ai-scheduler-status", result: { implemented: "boolean", active: "boolean", singleLocalModelJob: "boolean", rawPathExposed: "boolean" } },
  { method: "transcription.status", channel: "candor-core:transcription-status", result: { implemented: "boolean", active: "boolean", localOnly: "boolean", engine: "string", rawPathExposed: "boolean" } },
  { method: "transcription.quality.status", channel: "candor-core:transcription-quality-status", result: { implemented: "boolean", state: "string", tier: "string", languagePreference: "string", recommendedTier: "string", benchmarkState: "string", estimatedMinutesPerHour: "integer-or-null", estimatedCompletionAvailable: "boolean", hardware: "object", tiers: "array", localOnly: "boolean", cloudAi: "boolean", rawPathExposed: "boolean" }, resultSchema: transcriptionQualityResultSchema("transcription.quality.status") },
  { method: "transcription.quality.update", channel: "candor-core:transcription-quality-update", result: { implemented: "boolean", state: "string", tier: "string", languagePreference: "string", recommendedTier: "string", benchmarkState: "string", estimatedMinutesPerHour: "integer-or-null", estimatedCompletionAvailable: "boolean", hardware: "object", tiers: "array", localOnly: "boolean", cloudAi: "boolean", rawPathExposed: "boolean" }, resultSchema: transcriptionQualityResultSchema("transcription.quality.update") },
  { method: "terminology.status", channel: "candor-core:terminology-status", result: { implemented: "boolean", state: "string", dictionaryCount: "integer", entryCount: "integer", dictionaries: "array", encryptedAtRest: "boolean", promptWritingRequired: "boolean", automaticCorrection: "boolean", localOnly: "boolean", cloudAi: "boolean", rawPathExposed: "boolean" } },
  { method: "terminology.setEnabled", channel: "candor-core:terminology-set-enabled", result: { dictionaryId: "string", enabled: "boolean", savedLocally: "boolean", rawPathExposed: "boolean" } },
  { method: "terminology.assign", channel: "candor-core:terminology-assign", result: { recordingId: "string", dictionaryId: "string", assigned: "boolean", savedLocally: "boolean", rawPathExposed: "boolean" } },
  { method: "terminology.proposals", channel: "candor-core:terminology-proposals", result: { recordingId: "string", proposalCount: "integer", proposals: "array", automaticCorrection: "boolean", approvalRequired: "boolean", rawPathExposed: "boolean" } },
  { method: "terminology.decide", channel: "candor-core:terminology-decide", result: { recordingId: "string", proposalId: "string", decision: "string", savedLocally: "boolean", encryptedAtRest: "boolean", rawPathExposed: "boolean" } },
  { method: "recording.durable.status", channel: "candor-core:recording-durable-status", result: { rootKind: "string", recordingCount: "integer", storageHealth: "object", rawPathExposed: "boolean" } },
  { method: "recording.durable.listPage", channel: "candor-core:recording-durable-list-page", result: { offset: "integer", limit: "integer", totalCount: "integer", hasMore: "boolean", recordings: "array", rawPathExposed: "boolean" } },
  { method: "recording.durable.read", channel: "candor-core:recording-durable-read", result: { summary: "object", chunks: "array", chunkCount: "integer", rawPathExposed: "boolean" } },
  { method: "recording.durable.replayManifest", channel: "candor-core:recording-durable-replay-manifest", result: { recordingId: "string", state: "string", durationMs: "integer", audioChunks: "array", rawPathExposed: "boolean" } },
  { method: "recording.durable.transcriptPage", channel: "candor-core:recording-durable-transcript-page", result: { recordingId: "string", segmentCount: "integer", durationMs: "integer", segments: "array", rawPathExposed: "boolean" } },
  { method: "recording.privacyReceipt", channel: "candor-core:recording-privacy-receipt", result: { proofKind: "string", receiptVersion: "integer", recording: "object", capture: "object", storage: "object", network: "object", rawPathExposed: "boolean" } },
  { method: "recording.durable.readAudioChunk", channel: "candor-core:recording-durable-read-audio-chunk", result: { recordingId: "string", index: "integer", codec: "string", bytes: "integer", dataBase64: "string", rawPathExposed: "boolean" } },
  { method: "recording.durable.search", channel: "candor-core:recording-durable-search", result: { query: "string", matchCount: "integer", matches: "array", rawPathExposed: "boolean" } },
  { method: "recording.notes.read", channel: "candor-core:recording-notes-read", result: { recordingId: "string", markdown: "string", bytes: "integer", rawPathExposed: "boolean" } },
  { method: "recording.notes.save", channel: "candor-core:recording-notes-save", result: { recordingId: "string", markdown: "string", bytes: "integer", rawPathExposed: "boolean" } },
  { method: "retention.status", channel: "candor-core:retention-status", result: { policy: "string", automaticDeletion: "boolean", rawPathExposed: "boolean" } },
] as const;

const privateConfigs: readonly OperationConfig[] = [
  { method: "core.shutdown", timeoutMs: 2_000, result: { shutdown: "boolean" } },
  { method: "ai.askHeuristic", mode: "job", result: { recordingId: "string", question: "string", answer: "string", citations: "array", localOnly: "boolean", rawPathExposed: "boolean" } },
  { method: "ai.recapHeuristic", mode: "job", result: { recordingId: "string", summary: "string", decisions: "array", actions: "array", recapMarkdown: "string", localOnly: "boolean", rawPathExposed: "boolean" } },
  { method: "ai.askInstruct", timeoutMs: 10_000, mode: "job", result: { recordingId: "string", mode: "string", output: "string", citations: "array", localOnly: "boolean", rawPathExposed: "boolean" }, resultSchema: strictLocalAiResultSchema("ai.askInstruct", "ask") },
  { method: "ai.recapInstruct", timeoutMs: 10_000, mode: "job", result: { recordingId: "string", mode: "string", output: "string", citations: "array", localOnly: "boolean", rawPathExposed: "boolean" }, resultSchema: strictLocalAiResultSchema("ai.recapInstruct", "recap") },
  { method: "transcription.runLocal", timeoutMs: 10_000, mode: "job", result: { recordingId: "string", engine: "string", segmentCount: "integer", rawPathExposed: "boolean" } },
  { method: "export.create", timeoutMs: 10_000, mode: "job", result: { format: "string", fileName: "string", bytes: "integer", rawPathExposed: "boolean" } },
  { method: "terminology.import", timeoutMs: 15_000, result: { imported: "boolean", dictionaryId: "string", name: "string", entryCount: "integer", enabled: "boolean", encryptedAtRest: "boolean", rawPathExposed: "boolean" } },
  { method: "terminology.package.start", timeoutMs: 10_000, mode: "job", result: { jobId: "string", type: "string", state: "string", createdAt: "string", rawPathExposed: "boolean" } },
  { method: "recording.durable.recover", timeoutMs: 30_000, result: { rootKind: "string", recoveredRecordings: "array", recoveredCount: "integer", quarantinedRecordings: "array", quarantinedCount: "integer", completedDeletionCount: "integer", pendingDeletionCount: "integer", vaultIndex: "object", rawPathExposed: "boolean" } },
  { method: "jobs.list", result: { jobs: "array", jobCount: "integer", activeCount: "integer", persistenceState: "string", encryptedAtRest: "boolean", recordingPriorityActive: "boolean", rawPathExposed: "boolean" } },
  { method: "jobs.activeSummary", result: { activeCount: "integer", jobs: "array", rawPathExposed: "boolean" } },
  { method: "jobs.get", result: { jobId: "string", type: "string", state: "string", createdAt: "string", updatedAt: "string", terminal: "boolean", rawPathExposed: "boolean" } },
  { method: "jobs.cancel", result: { jobId: "string", state: "string", cancelRequested: "boolean", terminal: "boolean", rawPathExposed: "boolean" } },
  { method: "jobs.cancelAll", result: { cancelRequestedCount: "integer", rawPathExposed: "boolean" } },
  { method: "jobs.pauseAll", result: { pausedCount: "integer", restartOnNextLaunch: "boolean", rawPathExposed: "boolean" } },
  { method: "jobs.retry", result: { jobId: "string", type: "string", state: "string", createdAt: "string", rawPathExposed: "boolean" } },
  { method: "jobs.acknowledge", result: { jobId: "string", acknowledged: "boolean", rawPathExposed: "boolean" } },
  { method: "transcription.quality.benchmark.start", timeoutMs: 10_000, mode: "job", result: { jobId: "string", type: "string", state: "string", createdAt: "string", rawPathExposed: "boolean" } },
  { method: "transcription.start", timeoutMs: 10_000, mode: "job", result: { jobId: "string", type: "string", state: "string", createdAt: "string", rawPathExposed: "boolean" } },
  { method: "ai.ask.start", timeoutMs: 10_000, mode: "job", result: { jobId: "string", type: "string", state: "string", createdAt: "string", rawPathExposed: "boolean" } },
  { method: "ai.recap.start", timeoutMs: 10_000, mode: "job", result: { jobId: "string", type: "string", state: "string", createdAt: "string", rawPathExposed: "boolean" } },
  { method: "export.start", timeoutMs: 10_000, mode: "job", result: { jobId: "string", type: "string", state: "string", createdAt: "string", rawPathExposed: "boolean" } },
  { method: "import.v2.startFromFolder", timeoutMs: 10_000, mode: "job", result: { jobId: "string", type: "string", state: "string", createdAt: "string", rawPathExposed: "boolean" } },
  { method: "models.verify.start", timeoutMs: 10_000, mode: "job", result: { jobId: "string", type: "string", state: "string", createdAt: "string", rawPathExposed: "boolean" } },
  { method: "models.importFinish.start", timeoutMs: 10_000, mode: "job", result: { jobId: "string", type: "string", state: "string", createdAt: "string", rawPathExposed: "boolean" } },
  { method: "ai.instructAssetsImport.start", timeoutMs: 10_000, mode: "job", result: { jobId: "string", type: "string", state: "string", createdAt: "string", rawPathExposed: "boolean" } },
  { method: "models.importStart", timeoutMs: 15_000, mode: "job", result: { importId: "string", modelId: "string", chunkBytesMax: "integer", rawPathExposed: "boolean" } },
  { method: "models.importChunk", timeoutMs: 30_000, mode: "job", result: { importId: "string", modelId: "string", bytesWritten: "integer", complete: "boolean", rawPathExposed: "boolean" } },
  { method: "models.importFinish", timeoutMs: 120_000, mode: "job", result: { importId: "string", modelId: "string", imported: "boolean", rejected: "boolean", rawPathExposed: "boolean" } },
  { method: "models.importAbort", timeoutMs: 15_000, mode: "job", result: { importId: "string", aborted: "boolean", rawPathExposed: "boolean" } },
  { method: "ai.instructAssetsImportFromPath", timeoutMs: 600_000, mode: "job", result: { assetKind: "string", imported: "boolean", rawPathExposed: "boolean" } },
  { method: "recording.durable.start", result: { recordingId: "string", state: "string", rawPathExposed: "boolean" } },
  { method: "recording.durable.writeTranscriptSegment", result: { recordingId: "string", state: "string", rawPathExposed: "boolean" } },
  { method: "recording.durable.finish", timeoutMs: 20_000, result: { recordingId: "string", state: "string", rawPathExposed: "boolean" } },
  { method: "recording.durable.delete", timeoutMs: 30_000, result: { recordingId: "string", state: "string", deleted: "boolean", rawPathExposed: "boolean" } },
  { method: "import.v2.fromFolder", timeoutMs: 10_000, mode: "job", result: { importedCount: "integer", skippedCount: "integer", originalsUntouched: "boolean", rawPathExposed: "boolean" } },
  { method: "import.v2.proofSynthetic", timeoutMs: 120_000, mode: "job", result: { importedCount: "integer", skippedCount: "integer", originalsUntouched: "boolean", rawPathExposed: "boolean" } },
] as const;

function defineOperation(config: OperationConfig, scope: CoreOperationScope): CoreOperationDefinition {
  const paramsParser = scope === "renderer" ? validateRendererCoreParams : validatePrivateCoreParams;
  return Object.freeze({
    method: config.method,
    paramsSchema: jsonParamsSchema(config.method, (value) => paramsParser(config.method, value)),
    resultSchema: config.resultSchema ?? jsonObjectResultSchema(config.method, config.result),
    timeoutMs: config.timeoutMs ?? 5_000,
    requiresHandshake: config.method !== "core.version",
    mode: config.mode ?? "request",
    scope,
    ...(config.channel ? { channel: config.channel } : {}),
  });
}

const definitions = [
  ...rendererConfigs.map((config) => defineOperation(config, "renderer")),
  ...privateConfigs.map((config) => defineOperation(config, "private")),
];

export const CORE_OPERATIONS: ReadonlyMap<string, CoreOperationDefinition> = new Map(
  definitions.map((definition) => [definition.method, definition]),
);

if (CORE_OPERATIONS.size !== definitions.length) throw new Error("Duplicate core operation definition");

export interface RendererCoreOperation extends CoreOperationDefinition {
  readonly scope: "renderer";
  readonly channel: `candor-core:${string}`;
}

export const rendererCoreOperations = Object.freeze(
  definitions.filter((definition): definition is RendererCoreOperation =>
    definition.scope === "renderer" && typeof definition.channel === "string"),
);

export const rendererCoreMethods: ReadonlySet<string> = new Set(
  rendererCoreOperations.map(({ method }) => method),
);

export const privateCoreMethods: ReadonlySet<string> = new Set(CORE_OPERATIONS.keys());

export function getCoreOperation(method: string): CoreOperationDefinition {
  const operation = CORE_OPERATIONS.get(method);
  if (!operation) throw new Error(`Core operation is not registered: ${method}`);
  return operation;
}

const completedJobResultSchemas: ReadonlyMap<string, JsonRuntimeSchema> = new Map([
  ["transcription", jsonObjectResultSchema("transcription job", { recordingId: "string", engine: "string", segmentCount: "integer", rawPathExposed: "boolean" })],
  ["recap", strictLocalAiResultSchema("recap job", "recap")],
  ["ask", strictLocalAiResultSchema("ask job", "ask")],
  ["export", jsonObjectResultSchema("export job", { format: "string", fileName: "string", bytes: "integer", rawPathExposed: "boolean" })],
  ["legacy-import", jsonObjectResultSchema("legacy import job", { importedCount: "integer", skippedCount: "integer", originalsUntouched: "boolean", rawPathExposed: "boolean" })],
  ["speech-model-verification", jsonObjectResultSchema("speech model verification job", { modelId: "string", installed: "boolean", verified: "boolean", rawPathExposed: "boolean" })],
  ["speech-model-import", jsonObjectResultSchema("speech model import job", { importId: "string", modelId: "string", imported: "boolean", rejected: "boolean", rawPathExposed: "boolean" })],
  ["local-ai-component-import", jsonObjectResultSchema("local AI component import job", { assetKind: "string", imported: "boolean", integrityVerified: "boolean", rawPathExposed: "boolean" })],
  ["local-ai-benchmark", jsonObjectResultSchema("local AI benchmark job", { benchmarkState: "string", tier: "string", passed: "boolean", whisperMeasured: "boolean", localLlmMeasured: "boolean", localOnly: "boolean", cloudAi: "boolean", rawModelNamesExposed: "boolean", rawHashExposed: "boolean", rawMetricExposed: "boolean", rawPathExposed: "boolean" })],
]);

export function validateCompletedJobResult(value: JsonValue): JsonValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const job = value as Record<string, JsonValue>;
  if (job.state !== "completed") return value;
  if (typeof job.type !== "string") throw new Error("Completed job omitted its type");
  const schema = completedJobResultSchemas.get(job.type);
  if (!schema) throw new Error(`Completed job type is not registered: ${job.type}`);
  return { ...job, result: schema.parse(job.result) };
}
