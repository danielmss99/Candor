import { Buffer } from "node:buffer";
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
  readonly rendererResultFields?: readonly string[];
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

const EXACT_RENDERER_RESULT_METHODS = new Set([
  "capture.status",
  "core.status",
  "recording.durable.status",
]);

const GIB_BYTES = 1_073_741_824;
const speechModelTransparencyPolicy = new Map<string, {
  language: "english" | "multilingual";
  role: "fast-captions" | "default-transcription" | "higher-quality-transcription" | "deferred-diarization" | "large-local-transcription";
  minimumMemoryBytes: number | null;
  benchmarkRequired: boolean;
}>([
  ["tiny.en", { language: "english", role: "fast-captions", minimumMemoryBytes: null, benchmarkRequired: false }],
  ["tiny", { language: "multilingual", role: "fast-captions", minimumMemoryBytes: null, benchmarkRequired: false }],
  ["base.en", { language: "english", role: "default-transcription", minimumMemoryBytes: null, benchmarkRequired: false }],
  ["base", { language: "multilingual", role: "default-transcription", minimumMemoryBytes: null, benchmarkRequired: false }],
  ["small.en", { language: "english", role: "higher-quality-transcription", minimumMemoryBytes: null, benchmarkRequired: false }],
  ["small.en-tdrz", { language: "english", role: "deferred-diarization", minimumMemoryBytes: null, benchmarkRequired: false }],
  ["small", { language: "multilingual", role: "higher-quality-transcription", minimumMemoryBytes: null, benchmarkRequired: false }],
  ["medium.en", { language: "english", role: "higher-quality-transcription", minimumMemoryBytes: null, benchmarkRequired: false }],
  ["medium", { language: "multilingual", role: "higher-quality-transcription", minimumMemoryBytes: null, benchmarkRequired: false }],
  ["large-v3-turbo", { language: "multilingual", role: "large-local-transcription", minimumMemoryBytes: 8 * GIB_BYTES, benchmarkRequired: true }],
  ["large-v3", { language: "multilingual", role: "large-local-transcription", minimumMemoryBytes: 16 * GIB_BYTES, benchmarkRequired: true }],
]);

function modelsListLocalResultSchema(method: string): JsonRuntimeSchema {
  const outer = jsonObjectResultSchema(method, {
    localOnly: "boolean",
    cloudAi: "boolean",
    modelRootKind: "string",
    modelPathAcceptedFromRenderer: "boolean",
    installedModelCount: "integer",
    models: "array",
    rawPathExposed: "boolean",
    keyMaterialExposedToRenderer: "boolean",
  });
  return createRuntimeSchema(`${method}.result`, (value) => {
    const result = objectResult(outer.parse(value), method, "result");
    const modelValues = result.models as JsonValue[];
    if (
      result.localOnly !== true
      || result.cloudAi !== false
      || result.modelPathAcceptedFromRenderer !== false
      || result.rawPathExposed !== false
      || result.keyMaterialExposedToRenderer !== false
      || modelValues.length > speechModelTransparencyPolicy.size
      || result.installedModelCount !== modelValues.length
      || typeof result.modelRootKind !== "string"
      || result.modelRootKind.length < 1
      || result.modelRootKind.length > 80
    ) return invalidResult(method, "model list");

    const seen = new Set<string>();
    const models = modelValues.map((candidate, index) => {
      const model = objectResult(candidate, method, `models[${index}]`);
      const modelId = model.modelId;
      const policy = typeof modelId === "string"
        ? speechModelTransparencyPolicy.get(modelId)
        : undefined;
      const requirements = objectResult(
        model.hardwareRequirements,
        method,
        `models[${index}].hardwareRequirements`,
      );
      const expectedHardwareLabel = policy?.minimumMemoryBytes === null
        ? "Local CPU; Candor does not enforce a minimum memory threshold"
        : policy
          ? `At least ${policy.minimumMemoryBytes / GIB_BYTES} GB system memory and a passing local performance check`
          : "";
      const warm = model.warm;
      const warmState = model.warmState;
      const measuredLatencyMs = model.measuredLatencyMs;
      const latencyState = model.latencyMeasurementState;
      const latencyBasis = model.latencyMeasurementBasis;
      const failureCode = model.failureCode;
      if (
        !policy
        || seen.has(modelId as string)
        || model.language !== policy.language
        || model.role !== policy.role
        || model.installed !== true
        || typeof model.verified !== "boolean"
        || typeof model.bytes !== "number"
        || !Number.isSafeInteger(model.bytes)
        || model.bytes < 1
        || typeof model.verificationRequired !== "boolean"
        || (failureCode !== null
          && (typeof failureCode !== "string" || !/^[A-Z0-9_]{1,100}$/.test(failureCode)))
        || model.hardwareRequirement !== expectedHardwareLabel
        || requirements.policy !== "candor-local-whisper-v1"
        || requirements.minimumMemoryBytes !== policy.minimumMemoryBytes
        || requirements.minimumLogicalCpuCount !== 1
        || requirements.localCpuRequired !== true
        || requirements.acceleratorRequired !== false
        || requirements.passingLocalBenchmarkRequired !== policy.benchmarkRequired
        || model.warmStateBasis !== "in-process-whisper-context"
        || !(
          (warm === true && warmState === "loaded")
          || (warm === false && warmState === "cold")
          || (warm === null && warmState === "unavailable")
        )
        || !(
          (latencyState === "unmeasured" && measuredLatencyMs === null && latencyBasis === null)
          || (
            latencyState === "measured"
            && typeof measuredLatencyMs === "number"
            && Number.isSafeInteger(measuredLatencyMs)
            && measuredLatencyMs > 0
            && latencyBasis === "30-second-local-inference-benchmark"
          )
        )
      ) return invalidResult(method, `models[${index}]`);
      seen.add(modelId as string);
      return {
        modelId,
        language: policy.language,
        role: policy.role,
        installed: true,
        verified: model.verified,
        bytes: model.bytes,
        verificationRequired: model.verificationRequired,
        failureCode,
        hardwareRequirement: expectedHardwareLabel,
        hardwareRequirements: {
          policy: "candor-local-whisper-v1",
          minimumMemoryBytes: policy.minimumMemoryBytes,
          minimumLogicalCpuCount: 1,
          localCpuRequired: true,
          acceleratorRequired: false,
          passingLocalBenchmarkRequired: policy.benchmarkRequired,
        },
        warm,
        warmState,
        warmStateBasis: "in-process-whisper-context",
        measuredLatencyMs,
        latencyMeasurementState: latencyState,
        latencyMeasurementBasis: latencyBasis,
      };
    });

    return {
      localOnly: true,
      cloudAi: false,
      modelRootKind: result.modelRootKind,
      modelPathAcceptedFromRenderer: false,
      installedModelCount: models.length,
      models,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
  });
}

const MAX_HISTORY_COMPARISON_TEXT_BYTES = 64 * 1024;
const MAX_HISTORY_REVISION_SEGMENTS = 500;
const MAX_HISTORY_REVISION_SEGMENT_BYTES = 4 * 1024 * 1024;
const MAX_HISTORY_REVISIONS = 512;
const MAX_HISTORY_PROCESSING_RECEIPTS = 2_048;
const historyId = /^[A-Za-z0-9_-]{1,96}$/;
const processingIdentity = /^[A-Za-z0-9_.-]+$/;
const stableProcessingCode = /^[A-Z0-9_]{1,100}$/;

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function canonicalHistoryComparison(value: JsonValue, method: string): JsonValue {
  const comparison = objectResult(value, method, "revision.comparison");
  const hash = (candidate: JsonValue | undefined) => typeof candidate === "string" && /^[a-f0-9]{64}$/i.test(candidate);
  const count = (candidate: JsonValue | undefined) => typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0;
  if (
    !hash(comparison.rawTextSha256)
    || !hash(comparison.normalizedTextSha256)
    || !count(comparison.rawTextBytes)
    || !count(comparison.normalizedTextBytes)
    || !count(comparison.rawSegmentCount)
    || !count(comparison.normalizedSegmentCount)
    || typeof comparison.changed !== "boolean"
  ) return invalidResult(method, "revision.comparison");
  return canonicalResult(comparison, [
    "rawTextSha256", "normalizedTextSha256", "rawTextBytes", "normalizedTextBytes",
    "rawSegmentCount", "normalizedSegmentCount", "changed",
  ]);
}

function canonicalHistoryRevision(value: JsonValue, method: string): JsonValue {
  const revision = objectResult(value, method, "revision");
  const optionalModel = (candidate: JsonValue | undefined, max: number) => candidate === null
    || (typeof candidate === "string" && candidate.length > 0 && candidate.length <= max);
  const kind = revision.kind ?? (revision.source === "review" ? "normalized" : "raw-asr");
  const parentRevisionId = revision.parentRevisionId ?? null;
  if (
    typeof revision.revisionId !== "string"
    || !/^[A-Za-z0-9_-]{1,96}$/.test(revision.revisionId)
    || typeof revision.version !== "number"
    || !Number.isSafeInteger(revision.version)
    || revision.version < 1
    || !new Set(["initial", "reprocess", "import", "review", "ai-cleanup"]).has(revision.source as string)
    || !new Set(["raw-asr", "normalized", "ai-cleaned", "legacy"]).has(kind as string)
    || ((kind === "ai-cleaned") !== (revision.source === "ai-cleanup"))
    || (parentRevisionId !== null
      && (typeof parentRevisionId !== "string" || !historyId.test(parentRevisionId)))
    || (kind === "ai-cleaned" && parentRevisionId === null)
    || typeof revision.engine !== "string"
    || revision.engine.length === 0
    || revision.engine.length > 80
    || !optionalModel(revision.modelId, 200)
    || !optionalModel(revision.modelSha256, 64)
    || (revision.modelSha256 !== null && !/^[a-f0-9]{64}$/i.test(revision.modelSha256 as string))
    || typeof revision.rawComparisonAvailable !== "boolean"
    || typeof revision.createdAtMs !== "number"
    || !Number.isSafeInteger(revision.createdAtMs)
    || revision.createdAtMs < 0
  ) return invalidResult(method, "revision");
  return {
    revisionId: revision.revisionId,
    version: revision.version,
    source: revision.source,
    kind,
    parentRevisionId,
    engine: revision.engine,
    modelId: revision.modelId,
    modelSha256: revision.modelSha256,
    comparison: canonicalHistoryComparison(revision.comparison, method),
    rawComparisonAvailable: revision.rawComparisonAvailable,
    createdAtMs: revision.createdAtMs,
  };
}

function canonicalHistoryReceipt(
  value: JsonValue,
  method: string,
  revisionIds: ReadonlySet<string>,
): JsonValue {
  const receipt = objectResult(value, method, "processingReceipt");
  const modelId = receipt.modelId ?? null;
  const modelSha256 = receipt.modelSha256 ?? null;
  const revisionId = receipt.revisionId ?? null;
  const stage = receipt.stage ?? (receipt.operation === "protected-term-review" ? "normalization" : "transcription");
  const inputRevisionId = receipt.inputRevisionId ?? null;
  const inputRevisionKind = receipt.inputRevisionKind ?? null;
  const promptTemplateSha256 = receipt.promptTemplateSha256 ?? null;
  const validationResult = receipt.validationResult ?? "not-applicable";
  const fallbackApplied = receipt.fallbackApplied ?? false;
  const errorCode = receipt.errorCode ?? null;
  const errorSummary = receipt.errorSummary ?? null;
  const receiptComparison = receipt.comparison ?? null;
  const validOptionalIdentity = (candidate: JsonValue, max: number) => candidate === null
    || (typeof candidate === "string"
      && candidate.length > 0
      && candidate.length <= max
      && processingIdentity.test(candidate));
  const validTimestamp = (candidate: JsonValue | undefined) => typeof candidate === "number"
    && Number.isSafeInteger(candidate)
    && candidate >= 0;
  if (
    typeof receipt.receiptId !== "string"
    || !historyId.test(receipt.receiptId)
    || typeof receipt.attempt !== "number"
    || !Number.isSafeInteger(receipt.attempt)
    || receipt.attempt < 1
    || !new Set(["transcription", "protected-term-review", "transcript-cleanup", "local-ai-recap"]).has(receipt.operation as string)
    || !new Set(["transcription", "normalization", "cleanup", "recap"]).has(stage as string)
    || !new Set(["succeeded", "failed", "cancelled"]).has(receipt.outcome as string)
    || typeof receipt.engine !== "string"
    || receipt.engine.length > 80
    || !processingIdentity.test(receipt.engine)
    || !validOptionalIdentity(modelId, 200)
    || (modelSha256 !== null
      && (typeof modelSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(modelSha256)))
    || (revisionId !== null && (typeof revisionId !== "string" || !historyId.test(revisionId)))
    || (inputRevisionId !== null && (typeof inputRevisionId !== "string" || !historyId.test(inputRevisionId)))
    || (typeof inputRevisionId === "string" && !revisionIds.has(inputRevisionId))
    || (inputRevisionKind !== null
      && !new Set(["raw-asr", "normalized", "ai-cleaned", "legacy"]).has(inputRevisionKind as string))
    || ((inputRevisionId === null) !== (inputRevisionKind === null))
    || (promptTemplateSha256 !== null
      && (typeof promptTemplateSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(promptTemplateSha256)))
    || !new Set(["passed", "failed", "not-applicable"]).has(validationResult as string)
    || typeof fallbackApplied !== "boolean"
    || (errorCode !== null && (typeof errorCode !== "string" || !stableProcessingCode.test(errorCode)))
    || (errorSummary !== null
      && (typeof errorSummary !== "string"
        || utf8Bytes(errorSummary) < 1
        || utf8Bytes(errorSummary) > 500))
    || !validTimestamp(receipt.startedAtMs)
    || !validTimestamp(receipt.finishedAtMs)
    || (receipt.finishedAtMs as number) < (receipt.startedAtMs as number)
    || !validTimestamp(receipt.elapsedMs)
  ) return invalidResult(method, "processingReceipt");

  const succeeded = receipt.outcome === "succeeded";
  const recapReceipt = receipt.operation === "local-ai-recap";
  if (
    (succeeded && (
      (recapReceipt
        ? (revisionId !== null
          || receiptComparison !== null
          || typeof inputRevisionId !== "string"
          || typeof promptTemplateSha256 !== "string")
        : (typeof revisionId !== "string"
          || !revisionIds.has(revisionId)
          || receiptComparison === null))
      || errorCode !== null
      || errorSummary !== null
    ))
    || (!succeeded && (
      revisionId !== null
      || typeof errorCode !== "string"
      || receiptComparison !== null
    ))
  ) return invalidResult(method, "processingReceipt outcome");

  return {
    receiptId: receipt.receiptId,
    attempt: receipt.attempt,
    operation: receipt.operation,
    stage,
    outcome: receipt.outcome,
    engine: receipt.engine,
    modelId,
    modelSha256,
    revisionId,
    inputRevisionId,
    inputRevisionKind,
    promptTemplateSha256,
    validationResult,
    fallbackApplied,
    errorCode,
    errorSummary,
    startedAtMs: receipt.startedAtMs,
    finishedAtMs: receipt.finishedAtMs,
    elapsedMs: receipt.elapsedMs,
    comparison: receiptComparison === null
      ? null
      : canonicalHistoryComparison(receiptComparison, method),
  };
}

function trustHistoryResultSchema(method: string): JsonRuntimeSchema {
  const outer = jsonObjectResultSchema(method, {
    recordingId: "string",
    currentRevisionId: "string-or-null",
    currentCleanedRevisionId: "string-or-null",
    revisionCount: "integer",
    revisions: "array",
    receiptCount: "integer",
    processingReceipts: "array",
    immutableRevisions: "boolean",
    originalAudioRetained: "boolean",
    rawPathExposed: "boolean",
    keyMaterialExposedToRenderer: "boolean",
  });
  return createRuntimeSchema(`${method}.result`, (value) => {
    const result = objectResult(outer.parse(value), method, "result");
    const revisionValues = result.revisions as JsonValue[];
    const receiptValues = result.processingReceipts as JsonValue[];
    if (
      !historyId.test(result.recordingId as string)
      || revisionValues.length > MAX_HISTORY_REVISIONS
      || receiptValues.length > MAX_HISTORY_PROCESSING_RECEIPTS
      || result.revisionCount !== revisionValues.length
      || result.receiptCount !== receiptValues.length
      || result.immutableRevisions !== true
      || result.rawPathExposed !== false
      || result.keyMaterialExposedToRenderer !== false
    ) return invalidResult(method, "trust history bounds");

    const revisionIds = new Set<string>();
    const revisionKinds = new Map<string, string>();
    const revisions = revisionValues.map((candidate, index) => {
      const revision = objectResult(canonicalHistoryRevision(candidate, method), method, `revisions[${index}]`);
      const parentRevisionId = revision.parentRevisionId;
      if (
        revision.version !== index + 1
        || revisionIds.has(revision.revisionId as string)
        || (parentRevisionId !== null
          && (parentRevisionId === revision.revisionId || !revisionIds.has(parentRevisionId as string)))
      ) return invalidResult(method, `revisions[${index}]`);
      revisionIds.add(revision.revisionId as string);
      revisionKinds.set(revision.revisionId as string, revision.kind as string);
      return revision;
    });
    const currentRevisionId = result.currentRevisionId;
    const currentCleanedRevisionId = result.currentCleanedRevisionId;
    if (
      (revisionIds.size === 0 && currentRevisionId !== null)
      || (revisionIds.size > 0
        && (typeof currentRevisionId !== "string" || !revisionIds.has(currentRevisionId)))
      || (typeof currentRevisionId === "string" && revisionKinds.get(currentRevisionId) === "ai-cleaned")
      || (currentCleanedRevisionId !== null
        && (typeof currentCleanedRevisionId !== "string"
          || revisionKinds.get(currentCleanedRevisionId) !== "ai-cleaned"))
    ) return invalidResult(method, "currentRevisionId");

    const receiptIds = new Set<string>();
    const processingReceipts = receiptValues.map((candidate, index) => {
      const receipt = objectResult(
        canonicalHistoryReceipt(candidate, method, revisionIds),
        method,
        `processingReceipts[${index}]`,
      );
      if (
        receipt.attempt !== index + 1
        || receiptIds.has(receipt.receiptId as string)
        || (typeof receipt.inputRevisionId === "string"
          && revisionKinds.get(receipt.inputRevisionId) !== receipt.inputRevisionKind)
      ) return invalidResult(method, `processingReceipts[${index}]`);
      receiptIds.add(receipt.receiptId as string);
      return receipt;
    });

    return {
      recordingId: result.recordingId,
      currentRevisionId,
      currentCleanedRevisionId,
      revisionCount: revisions.length,
      revisions,
      receiptCount: processingReceipts.length,
      processingReceipts,
      immutableRevisions: true,
      originalAudioRetained: result.originalAudioRetained,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
  });
}

function canonicalHistoryComparisonView(value: JsonValue, method: string): JsonValue {
  const view = objectResult(value, method, "comparisonView");
  if (
    typeof view.available !== "boolean"
    || view.maxTextBytesPerSide !== MAX_HISTORY_COMPARISON_TEXT_BYTES
    || view.rawPathExposed !== false
    || view.keyMaterialExposedToRenderer !== false
  ) return invalidResult(method, "comparisonView");
  if (!view.available) {
    if (view.reason !== "legacy-revision" || view.encryptedAtRest !== false) {
      return invalidResult(method, "comparisonView");
    }
    return canonicalResult(view, [
      "available", "reason", "maxTextBytesPerSide", "encryptedAtRest",
      "rawPathExposed", "keyMaterialExposedToRenderer",
    ]);
  }
  if (
    typeof view.rawText !== "string"
    || typeof view.normalizedText !== "string"
    || utf8Bytes(view.rawText) > MAX_HISTORY_COMPARISON_TEXT_BYTES
    || utf8Bytes(view.normalizedText) > MAX_HISTORY_COMPARISON_TEXT_BYTES
    || typeof view.rawTextTruncated !== "boolean"
    || typeof view.normalizedTextTruncated !== "boolean"
    || view.encryptedAtRest !== true
  ) return invalidResult(method, "comparisonView");
  return canonicalResult(view, [
    "available", "rawText", "normalizedText", "rawTextTruncated", "normalizedTextTruncated",
    "maxTextBytesPerSide", "encryptedAtRest", "rawPathExposed", "keyMaterialExposedToRenderer",
  ]);
}

function canonicalHistorySegments(value: JsonValue, method: string): JsonValue[] {
  if (!Array.isArray(value) || value.length > MAX_HISTORY_REVISION_SEGMENTS) {
    return invalidResult(method, "segments");
  }
  let serializedBytes = 2;
  return value.map((candidate, index) => {
    const segment = objectResult(candidate, method, `segments[${index}]`);
    const confidence = segment.confidence;
    if (
      typeof segment.index !== "number"
      || !Number.isSafeInteger(segment.index)
      || segment.index < 0
      || segment.index > 0xffff_ffff
      || segment.kind !== "transcriptSegment"
      || typeof segment.channel !== "string"
      || !/^[A-Za-z0-9_-]{1,32}$/.test(segment.channel)
      || (segment.speaker !== null
        && (typeof segment.speaker !== "string"
          || segment.speaker.trim() !== segment.speaker
          || utf8Bytes(segment.speaker) < 1
          || utf8Bytes(segment.speaker) > 80))
      || typeof segment.text !== "string"
      || typeof segment.startMs !== "number"
      || !Number.isSafeInteger(segment.startMs)
      || segment.startMs < 0
      || typeof segment.durationMs !== "number"
      || !Number.isSafeInteger(segment.durationMs)
      || segment.durationMs < 0
      || typeof segment.endMs !== "number"
      || !Number.isSafeInteger(segment.endMs)
      || segment.endMs < segment.startMs
      || segment.endMs !== segment.startMs + segment.durationMs
      || (confidence !== null
        && (typeof confidence !== "number"
          || !Number.isFinite(confidence)
          || confidence < 0
          || confidence > 1))
      || segment.rawPathExposed !== false
    ) return invalidResult(method, `segments[${index}]`);
    const safe = {
      index: segment.index,
      kind: "transcriptSegment",
      channel: segment.channel,
      speaker: segment.speaker,
      text: segment.text,
      startMs: segment.startMs,
      durationMs: segment.durationMs,
      endMs: segment.endMs,
      confidence,
      rawPathExposed: false,
    };
    serializedBytes += utf8Bytes(JSON.stringify(safe)) + 1;
    if (serializedBytes > MAX_HISTORY_REVISION_SEGMENT_BYTES) {
      return invalidResult(method, "segments serialized size");
    }
    return safe;
  });
}

function transcriptRevisionResultSchema(method: string): JsonRuntimeSchema {
  const outer = jsonObjectResultSchema(method, {
    recordingId: "string", revision: "object", current: "boolean", currentCleaned: "boolean", segmentCount: "integer",
    returnedSegmentCount: "integer", hasMore: "boolean", segments: "array", comparisonView: "object",
    rawPathExposed: "boolean", keyMaterialExposedToRenderer: "boolean",
  });
  return createRuntimeSchema(`${method}.result`, (value) => {
    const result = objectResult(outer.parse(value), method, "result");
    const segments = canonicalHistorySegments(result.segments, method);
    if (
      result.rawPathExposed !== false
      || result.keyMaterialExposedToRenderer !== false
      || (result.current === true && result.currentCleaned === true)
      || (result.segmentCount as number) < 0
      || result.returnedSegmentCount !== segments.length
      || (result.returnedSegmentCount as number) > (result.segmentCount as number)
      || result.hasMore !== ((result.returnedSegmentCount as number) < (result.segmentCount as number))
    ) return invalidResult(method, "revision segment bounds");
    return {
      recordingId: result.recordingId,
      revision: canonicalHistoryRevision(result.revision, method),
      current: result.current,
      currentCleaned: result.currentCleaned,
      segmentCount: result.segmentCount,
      returnedSegmentCount: result.returnedSegmentCount,
      hasMore: result.hasMore,
      segments,
      comparisonView: canonicalHistoryComparisonView(result.comparisonView, method),
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
  });
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

const liveTranscriptRecordingId = /^[A-Za-z0-9_-]{1,96}$/;
const liveTranscriptRevisionId = /^[A-Za-z0-9_-]{1,128}$/;

function requireLiveTranscriptCustody(
  method: string,
  value: Record<string, JsonValue>,
): void {
  if (
    value.localOnly !== true
    || value.networkAttempted !== false
    || value.rawPathExposed !== false
    || value.keyMaterialExposedToRenderer !== false
  ) {
    invalidResult(method, "local custody");
  }
}

function canonicalLiveTranscriptSegment(
  method: string,
  value: JsonValue,
  field: string,
): JsonValue {
  const segment = objectResult(value, method, field);
  if (
    typeof segment.sequence !== "number"
    || !Number.isSafeInteger(segment.sequence)
    || segment.sequence < 1
    || typeof segment.startMs !== "number"
    || !Number.isSafeInteger(segment.startMs)
    || segment.startMs < 0
    || typeof segment.endMs !== "number"
    || !Number.isSafeInteger(segment.endMs)
    || segment.endMs < segment.startMs
    || typeof segment.text !== "string"
    || segment.text.length < 1
    || Buffer.byteLength(segment.text, "utf8") > 4 * 1024
  ) {
    return invalidResult(method, field);
  }
  return {
    sequence: segment.sequence,
    startMs: segment.startMs,
    endMs: segment.endMs,
    text: segment.text,
  };
}

function canonicalPartialTranscriptPayload(
  method: string,
  value: JsonValue,
  field: string,
): JsonValue {
  const payload = objectResult(value, method, field);
  requireLiveTranscriptCustody(method, payload);
  const segment = canonicalLiveTranscriptSegment(method, payload, field) as Record<string, JsonValue>;
  if (
    payload.event !== "transcript.partial"
    || payload.schemaVersion !== 1
    || typeof payload.recordingId !== "string"
    || !liveTranscriptRecordingId.test(payload.recordingId)
    || payload.sequence !== segment.sequence
    || payload.provisional !== true
    || payload.isFinal !== false
    || typeof payload.segmentCount !== "number"
    || !Number.isSafeInteger(payload.segmentCount)
    || payload.segmentCount < 1
    || payload.segmentCount > 256
  ) {
    return invalidResult(method, field);
  }
  return {
    event: "transcript.partial",
    schemaVersion: 1,
    recordingId: payload.recordingId,
    sequence: segment.sequence,
    provisional: true,
    isFinal: false,
    startMs: segment.startMs,
    endMs: segment.endMs,
    text: segment.text,
    segmentCount: payload.segmentCount,
    localOnly: true,
    networkAttempted: false,
    rawPathExposed: false,
    keyMaterialExposedToRenderer: false,
  };
}

function liveTranscriptSessionResultSchema(method: string): JsonRuntimeSchema {
  const outer = jsonObjectResultSchema(method, {
    schemaVersion: "integer",
    recordingId: "string",
    enabled: "boolean",
    active: "boolean",
    provisionalSegmentCount: "integer",
    pendingEventCount: "integer",
    localOnly: "boolean",
    networkAttempted: "boolean",
    rawPathExposed: "boolean",
    keyMaterialExposedToRenderer: "boolean",
  });
  return createRuntimeSchema(`${method}.result`, (value) => {
    const result = objectResult(outer.parse(value), method, "result");
    requireLiveTranscriptCustody(method, result);
    if (
      result.schemaVersion !== 1
      || typeof result.recordingId !== "string"
      || !liveTranscriptRecordingId.test(result.recordingId)
      || typeof result.provisionalSegmentCount !== "number"
      || result.provisionalSegmentCount < 0
      || result.provisionalSegmentCount > 256
      || typeof result.pendingEventCount !== "number"
      || result.pendingEventCount < 0
      || result.pendingEventCount > 512
      || result.enabled !== true
    ) {
      return invalidResult(method, "session status");
    }
    return {
      schemaVersion: 1,
      recordingId: result.recordingId,
      enabled: true,
      active: result.active,
      provisionalSegmentCount: result.provisionalSegmentCount,
      pendingEventCount: result.pendingEventCount,
      localOnly: true,
      networkAttempted: false,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
  });
}

function liveTranscriptSnapshotResultSchema(method: string): JsonRuntimeSchema {
  const outer = jsonObjectResultSchema(method, {
    schemaVersion: "integer",
    recordingId: "string",
    provisional: "boolean",
    finalized: "boolean",
    finalRevisionId: "string-or-null",
    segments: "array",
    segmentCount: "integer",
    textBytes: "integer",
    localOnly: "boolean",
    networkAttempted: "boolean",
    rawPathExposed: "boolean",
    keyMaterialExposedToRenderer: "boolean",
  });
  return createRuntimeSchema(`${method}.result`, (value) => {
    const result = objectResult(outer.parse(value), method, "result");
    requireLiveTranscriptCustody(method, result);
    const segments = (result.segments as JsonValue[]).map((segment, index) =>
      canonicalLiveTranscriptSegment(method, segment, `segments[${index}]`));
    if (
      result.schemaVersion !== 1
      || typeof result.recordingId !== "string"
      || !liveTranscriptRecordingId.test(result.recordingId)
      || result.segmentCount !== segments.length
      || segments.length > 256
      || typeof result.textBytes !== "number"
      || result.textBytes < 0
      || result.textBytes > 64 * 1024
      || result.provisional === result.finalized
      || (result.finalRevisionId !== null && (
        typeof result.finalRevisionId !== "string"
        || !liveTranscriptRevisionId.test(result.finalRevisionId)
      ))
      || (result.finalized && result.finalRevisionId === null)
      || (!result.finalized && result.finalRevisionId !== null)
    ) {
      return invalidResult(method, "snapshot");
    }
    return {
      schemaVersion: 1,
      recordingId: result.recordingId,
      provisional: result.provisional,
      finalized: result.finalized,
      finalRevisionId: result.finalRevisionId,
      segments,
      segmentCount: segments.length,
      textBytes: result.textBytes,
      localOnly: true,
      networkAttempted: false,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
  });
}

function liveTranscriptClearResultSchema(method: string): JsonRuntimeSchema {
  const outer = jsonObjectResultSchema(method, {
    schemaVersion: "integer",
    recordingId: "string",
    discardedSegmentCount: "integer",
    discardedTextBytes: "integer",
    discardedPendingEventCount: "integer",
    sessionRemoved: "boolean",
    memoryCleared: "boolean",
    zeroizationGuaranteed: "boolean",
    finalRevisionUnchanged: "boolean",
    localOnly: "boolean",
    networkAttempted: "boolean",
    rawPathExposed: "boolean",
    keyMaterialExposedToRenderer: "boolean",
  });
  return createRuntimeSchema(`${method}.result`, (value) => {
    const result = objectResult(outer.parse(value), method, "result");
    requireLiveTranscriptCustody(method, result);
    if (
      result.schemaVersion !== 1
      || typeof result.recordingId !== "string"
      || !liveTranscriptRecordingId.test(result.recordingId)
      || result.discardedSegmentCount as number < 0
      || result.discardedSegmentCount as number > 256
      || result.discardedTextBytes as number < 0
      || result.discardedTextBytes as number > 64 * 1024
      || result.discardedPendingEventCount as number < 0
      || result.discardedPendingEventCount as number > 512
      || result.memoryCleared !== true
      || result.zeroizationGuaranteed !== false
      || result.finalRevisionUnchanged !== true
    ) {
      return invalidResult(method, "clear status");
    }
    return {
      schemaVersion: 1,
      recordingId: result.recordingId,
      discardedSegmentCount: result.discardedSegmentCount,
      discardedTextBytes: result.discardedTextBytes,
      discardedPendingEventCount: result.discardedPendingEventCount,
      sessionRemoved: result.sessionRemoved,
      memoryCleared: true,
      zeroizationGuaranteed: false,
      finalRevisionUnchanged: true,
      localOnly: true,
      networkAttempted: false,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
  });
}

function liveTranscriptDrainResultSchema(method: string): JsonRuntimeSchema {
  const outer = jsonObjectResultSchema(method, {
    schemaVersion: "integer",
    events: "array",
    drainedEventCount: "integer",
    remainingEventCount: "integer",
    localOnly: "boolean",
    networkAttempted: "boolean",
    rawPathExposed: "boolean",
    keyMaterialExposedToRenderer: "boolean",
  });
  return createRuntimeSchema(`${method}.result`, (value) => {
    const result = objectResult(outer.parse(value), method, "result");
    requireLiveTranscriptCustody(method, result);
    const events = (result.events as JsonValue[]).map((candidate, index) => {
      const envelope = objectResult(candidate, method, `events[${index}]`);
      requireLiveTranscriptCustody(method, envelope);
      if (
        envelope.schemaVersion !== 1
        || typeof envelope.deliverySequence !== "number"
        || !Number.isSafeInteger(envelope.deliverySequence)
        || envelope.deliverySequence < 1
        || envelope.channel !== "transcript.partial"
      ) {
        return invalidResult(method, `events[${index}]`);
      }
      return {
        schemaVersion: 1,
        deliverySequence: envelope.deliverySequence,
        channel: "transcript.partial",
        payload: canonicalPartialTranscriptPayload(method, envelope.payload, `events[${index}].payload`),
        localOnly: true,
        networkAttempted: false,
        rawPathExposed: false,
        keyMaterialExposedToRenderer: false,
      };
    });
    if (
      result.schemaVersion !== 1
      || events.length > 128
      || result.drainedEventCount !== events.length
      || typeof result.remainingEventCount !== "number"
      || result.remainingEventCount < 0
      || result.remainingEventCount > 512
    ) {
      return invalidResult(method, "event drain");
    }
    return {
      schemaVersion: 1,
      events,
      drainedEventCount: events.length,
      remainingEventCount: result.remainingEventCount,
      localOnly: true,
      networkAttempted: false,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
  });
}

function diarizationStatusResultSchema(method: string): JsonRuntimeSchema {
  const outer = jsonObjectResultSchema(method, {
    implemented: "boolean",
    schemaVersion: "integer",
    state: "string",
    reasonCode: "string",
    enabledByUser: "boolean",
    savedLocally: "boolean",
    engineAvailable: "boolean",
    diarizationAvailable: "boolean",
    diarizationRunning: "boolean",
    modelVerified: "boolean",
    licenseEvidenceVerified: "boolean",
    redistributionAllowed: "boolean",
    benchmarkPassed: "boolean",
    benchmarkRequired: "boolean",
    gate: "object",
    speakerNamingAvailable: "boolean",
    anonymousSpeakerLabelsOnly: "boolean",
    identityInferred: "boolean",
    biometricIdentityClaimed: "boolean",
    encryptedAtRest: "boolean",
    localOnly: "boolean",
    networkAttempted: "boolean",
    rawPathExposed: "boolean",
    keyMaterialExposedToRenderer: "boolean",
  });
  return createRuntimeSchema(`${method}.result`, (value) => {
    const result = objectResult(outer.parse(value), method, "result");
    const gate = objectResult(result.gate, method, "gate");
    const states = new Set(["disabled", "engine-unavailable", "gated", "ready"]);
    const gateStates = new Set([
      "disabled",
      "model-not-verified",
      "license-evidence-required",
      "license-evidence-stale",
      "license-rejected",
      "benchmark-required",
      "benchmark-stale",
      "benchmark-failed",
      "ready",
    ]);
    if (
      result.implemented !== true
      || result.schemaVersion !== 1
      || typeof result.state !== "string"
      || !states.has(result.state)
      || typeof result.reasonCode !== "string"
      || !/^DIARIZATION_[A-Z0-9_]+$/.test(result.reasonCode)
      || result.diarizationRunning !== false
      || (result.engineAvailable === false && result.diarizationAvailable !== false)
      || (result.enabledByUser === false && result.state !== "disabled")
      || (result.enabledByUser === true && result.engineAvailable === false && result.state !== "engine-unavailable")
      || result.speakerNamingAvailable !== true
      || result.anonymousSpeakerLabelsOnly !== true
      || result.identityInferred !== false
      || result.biometricIdentityClaimed !== false
      || result.encryptedAtRest !== true
      || result.localOnly !== true
      || result.networkAttempted !== false
      || result.rawPathExposed !== false
      || result.keyMaterialExposedToRenderer !== false
      || gate.schemaVersion !== 1
      || typeof gate.status !== "string"
      || !gateStates.has(gate.status)
      || typeof gate.reasonCode !== "string"
      || !/^DIARIZATION_[A-Z0-9_]+$/.test(gate.reasonCode)
      || typeof gate.diarizationAllowed !== "boolean"
      || (gate.modelId !== null && (
        typeof gate.modelId !== "string"
        || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(gate.modelId)
      ))
      || typeof gate.benchmarkRequired !== "boolean"
      || typeof gate.licenseEvidenceVerified !== "boolean"
      || typeof gate.redistributionAllowed !== "boolean"
      || gate.benchmarkRequired !== (gate.status !== "disabled" && gate.status !== "ready")
      || gate.diarizationAllowed !== (gate.status === "ready")
      || result.benchmarkRequired !== gate.benchmarkRequired
      || result.benchmarkPassed !== (gate.status === "ready")
      || result.modelVerified !== (gate.modelId !== null)
      || result.licenseEvidenceVerified !== gate.licenseEvidenceVerified
      || result.redistributionAllowed !== gate.redistributionAllowed
      || (gate.status === "ready" && (
        gate.licenseEvidenceVerified !== true
        || gate.redistributionAllowed !== true
      ))
      || result.diarizationAvailable !== (result.engineAvailable === true && gate.diarizationAllowed === true)
      || (result.diarizationAvailable === true && result.state !== "ready")
      || gate.anonymousSpeakerLabelsOnly !== true
      || gate.biometricIdentityClaimed !== false
      || gate.localOnly !== true
      || gate.networkAttempted !== false
      || gate.rawPathExposed !== false
      || gate.keyMaterialExposedToRenderer !== false
    ) {
      return invalidResult(method, "local diarization gate");
    }
    return {
      implemented: true,
      schemaVersion: 1,
      state: result.state,
      reasonCode: result.reasonCode,
      enabledByUser: result.enabledByUser,
      savedLocally: result.savedLocally,
      engineAvailable: result.engineAvailable,
      diarizationAvailable: result.diarizationAvailable,
      diarizationRunning: false,
      modelVerified: result.modelVerified,
      licenseEvidenceVerified: result.licenseEvidenceVerified,
      redistributionAllowed: result.redistributionAllowed,
      benchmarkPassed: result.benchmarkPassed,
      benchmarkRequired: result.benchmarkRequired,
      gate: {
        schemaVersion: 1,
        status: gate.status,
        reasonCode: gate.reasonCode,
        diarizationAllowed: gate.diarizationAllowed,
        modelId: gate.modelId,
        licenseEvidenceVerified: gate.licenseEvidenceVerified,
        redistributionAllowed: gate.redistributionAllowed,
        benchmarkRequired: gate.benchmarkRequired,
        anonymousSpeakerLabelsOnly: true,
        biometricIdentityClaimed: false,
        localOnly: true,
        networkAttempted: false,
        rawPathExposed: false,
        keyMaterialExposedToRenderer: false,
      },
      speakerNamingAvailable: true,
      anonymousSpeakerLabelsOnly: true,
      identityInferred: false,
      biometricIdentityClaimed: false,
      encryptedAtRest: true,
      localOnly: true,
      networkAttempted: false,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
  });
}

function speakerNamesResultSchema(method: string, requireRemoved = false): JsonRuntimeSchema {
  const outer = jsonObjectResultSchema(method, {
    implemented: "boolean",
    recordingId: "string",
    assignmentCount: "integer",
    assignments: "array",
    userControlled: "boolean",
    identityInferred: "boolean",
    biometricIdentityClaimed: "boolean",
    anonymousSpeakerLabelsOnly: "boolean",
    encryptedAtRest: "boolean",
    localOnly: "boolean",
    networkAttempted: "boolean",
    rawPathExposed: "boolean",
    keyMaterialExposedToRenderer: "boolean",
    ...(requireRemoved ? { removed: "boolean" as const } : {}),
  });
  return createRuntimeSchema(`${method}.result`, (value) => {
    const result = objectResult(outer.parse(value), method, "result");
    const assignments = (result.assignments as JsonValue[]).map((candidate, index) => {
      const assignment = objectResult(candidate, method, `assignments[${index}]`);
      if (
        assignment.schemaVersion !== 1
        || typeof assignment.anonymousSpeakerId !== "string"
        || !/^speaker-[1-9][0-9]{0,3}$/.test(assignment.anonymousSpeakerId)
        || typeof assignment.displayName !== "string"
        || assignment.displayName.trim() !== assignment.displayName
        || Buffer.byteLength(assignment.displayName, "utf8") < 1
        || Buffer.byteLength(assignment.displayName, "utf8") > 80
        || /[\u0000-\u001f\u007f]/.test(assignment.displayName)
        || assignment.source !== "user"
        || assignment.userControlled !== true
        || assignment.identityInferred !== false
        || assignment.biometricIdentityClaimed !== false
        || assignment.localOnly !== true
        || assignment.networkAttempted !== false
        || assignment.rawPathExposed !== false
        || assignment.keyMaterialExposedToRenderer !== false
      ) {
        return invalidResult(method, `assignments[${index}]`);
      }
      return {
        schemaVersion: 1,
        anonymousSpeakerId: assignment.anonymousSpeakerId,
        displayName: assignment.displayName,
        source: "user",
        userControlled: true,
        identityInferred: false,
        biometricIdentityClaimed: false,
        localOnly: true,
        networkAttempted: false,
        rawPathExposed: false,
        keyMaterialExposedToRenderer: false,
      };
    });
    if (
      result.implemented !== true
      || typeof result.recordingId !== "string"
      || !liveTranscriptRecordingId.test(result.recordingId)
      || assignments.length > 64
      || result.assignmentCount !== assignments.length
      || result.userControlled !== true
      || result.identityInferred !== false
      || result.biometricIdentityClaimed !== false
      || result.anonymousSpeakerLabelsOnly !== true
      || result.encryptedAtRest !== true
      || result.localOnly !== true
      || result.networkAttempted !== false
      || result.rawPathExposed !== false
      || result.keyMaterialExposedToRenderer !== false
      || (requireRemoved && typeof result.removed !== "boolean")
    ) {
      return invalidResult(method, "user-controlled speaker names");
    }
    return {
      implemented: true,
      recordingId: result.recordingId,
      assignmentCount: assignments.length,
      assignments,
      ...(requireRemoved ? { removed: result.removed } : {}),
      userControlled: true,
      identityInferred: false,
      biometricIdentityClaimed: false,
      anonymousSpeakerLabelsOnly: true,
      encryptedAtRest: true,
      localOnly: true,
      networkAttempted: false,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
  });
}

const aiFallbackReasons = new Set([
  "llm-unavailable",
  "runtime-failed",
  "model-corrupt",
  "resource-policy",
  "user-requested",
]);

function canonicalAiProvenance(value: JsonValue, method: string): JsonValue {
  const provenance = objectResult(value, method, "provenance");
  const engine = provenance.engine;
  const modelId = provenance.modelId;
  const modelSha256 = provenance.modelSha256;
  const runtimeSha256 = provenance.runtimeSha256;
  const fallbackUsed = provenance.fallbackUsed;
  const fallbackReason = provenance.fallbackReason;
  const promptVersion = provenance.promptVersion;
  const generatedAt = provenance.generatedAt;
  if (
    (engine !== "local-llm" && engine !== "heuristic")
    || (modelId !== null && (typeof modelId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(modelId)))
    || (modelSha256 !== null && (typeof modelSha256 !== "string" || !/^[a-f0-9]{64}$/.test(modelSha256)))
    || (runtimeSha256 !== null && (typeof runtimeSha256 !== "string" || !/^[a-f0-9]{64}$/.test(runtimeSha256)))
    || typeof fallbackUsed !== "boolean"
    || (fallbackReason !== null && (typeof fallbackReason !== "string" || !aiFallbackReasons.has(fallbackReason)))
    || typeof promptVersion !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(promptVersion)
    || typeof generatedAt !== "string"
    || generatedAt.length > 64
    || Number.isNaN(Date.parse(generatedAt))
    || (engine === "local-llm" && (
      typeof modelId !== "string"
      || typeof modelSha256 !== "string"
      || typeof runtimeSha256 !== "string"
      || fallbackUsed
      || fallbackReason !== null
    ))
    || (engine === "heuristic" && (
      modelId !== null
      || modelSha256 !== null
      || runtimeSha256 !== null
      || !fallbackUsed
      || typeof fallbackReason !== "string"
    ))
  ) {
    return invalidResult(method, "provenance");
  }
  return {
    engine,
    modelId,
    modelSha256,
    runtimeSha256,
    fallbackUsed,
    fallbackReason,
    promptVersion,
    generatedAt,
  };
}

function strictLocalAiResultSchema(
  method: string,
  mode: "ask" | "recap",
  requireProvenance = false,
): JsonRuntimeSchema {
  const outer = jsonObjectResultSchema(method, {
    recordingId: "string",
    engine: "string",
    citations: "array",
    localOnly: "boolean",
    cloudAi: "boolean",
    rawPathExposed: "boolean",
    keyMaterialExposedToRenderer: "boolean",
  });
  return createRuntimeSchema(`${method}.result`, (value) => {
    const parsed = outer.parse(value);
    const result = objectResult(parsed, method, "result");
    if (
      result.localOnly !== true
      || result.cloudAi !== false
      || result.rawPathExposed !== false
      || result.keyMaterialExposedToRenderer !== false
      || (mode === "recap" && (
        typeof result.summary !== "string"
        || typeof result.recapMarkdown !== "string"
        || !Array.isArray(result.decisions)
        || !Array.isArray(result.actions)
        || !Array.isArray(result.risks)
        || !Array.isArray(result.questions)
      ))
      || (mode === "ask" && (
        typeof result.question !== "string"
        || typeof result.answer !== "string"
        || typeof result.answerFound !== "boolean"
      ))
      || (result.engine !== "llama-cpp-local" && result.engine !== "heuristic-local")
      || (result.inputRevisionId !== undefined
        && (typeof result.inputRevisionId !== "string" || !historyId.test(result.inputRevisionId)))
      || (result.inputRevisionKind !== undefined
        && !new Set(["raw-asr", "normalized", "ai-cleaned", "legacy"]).has(result.inputRevisionKind as string))
      || ((result.inputRevisionId === undefined) !== (result.inputRevisionKind === undefined))
      || (result.cleanupFallbackApplied !== undefined && typeof result.cleanupFallbackApplied !== "boolean")
    ) {
      return invalidResult(method, "local custody");
    }
    let provenance: JsonValue | undefined;
    if (requireProvenance || result.provenance !== undefined) {
      provenance = canonicalAiProvenance(result.provenance, method);
      const provenanceObject = provenance as Record<string, JsonValue>;
      if (
        (result.engine === "llama-cpp-local" && provenanceObject.engine !== "local-llm")
        || (result.engine === "heuristic-local" && provenanceObject.engine !== "heuristic")
      ) {
        return invalidResult(method, "provenance engine");
      }
    }
    if (result.engine !== "llama-cpp-local") {
      return provenance === undefined ? parsed : { ...result, provenance };
    }
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
    return provenance === undefined ? parsed : { ...result, provenance };
  });
}

const MAX_CAPTURE_DEVICES_PER_KIND = 128;
const MAX_CAPTURE_DEVICE_LABEL_CHARS = 512;
const MAX_CAPTURE_DEVICE_ORDINAL = 4_095;
const MIC_TEST_SAMPLE_RATE_HZ = 16_000;
const MIC_TEST_CHANNEL_COUNT = 1;
const MIC_TEST_MAX_DURATION_MS = 5_000;
const MIC_TEST_MAX_SAMPLE_COUNT = 80_000;
const MIC_TEST_WAV_HEADER_BYTES = 44;
const MIC_TEST_MAX_WAV_BYTES = MIC_TEST_WAV_HEADER_BYTES + (MIC_TEST_MAX_SAMPLE_COUNT * 2);
const MIC_TEST_MAX_BASE64_CHARS = 213_392;

function exactResultKeys(
  value: JsonValue,
  method: string,
  field: string,
  keys: readonly string[],
): Record<string, JsonValue> {
  const result = objectResult(value, method, field);
  const actual = Object.keys(result);
  if (
    actual.length !== keys.length
    || actual.some((key) => !keys.includes(key))
    || keys.some((key) => !Object.prototype.hasOwnProperty.call(result, key))
  ) {
    return invalidResult(method, `${field} shape`);
  }
  return result;
}

function isBoundedString(value: JsonValue, minimum: number, maximum: number): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum;
}

function isBoundedInteger(value: JsonValue, minimum: number, maximum: number): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= minimum
    && value <= maximum;
}

function canonicalInputDevices(value: JsonValue, method: string, field: string): JsonValue[] {
  if (!Array.isArray(value) || value.length > MAX_CAPTURE_DEVICES_PER_KIND) {
    return invalidResult(method, field);
  }
  const seenIds = new Set<string>();
  return value.map((candidate, index) => {
    const deviceField = `${field}[${index}]`;
    const device = exactResultKeys(candidate, method, deviceField, [
      "id",
      "label",
      "fingerprint",
      "ordinal",
      "isDefault",
      "systemMonitorEligible",
      "rawPathExposed",
      "keyMaterialExposedToRenderer",
    ]);
    const idMatch = typeof device.id === "string"
      ? /^input-(0|[1-9]\d{0,3})$/.exec(device.id)
      : null;
    const ordinal = idMatch ? Number(idMatch[1]) : -1;
    if (
      !idMatch
      || seenIds.has(device.id as string)
      || !isBoundedString(device.label, 1, MAX_CAPTURE_DEVICE_LABEL_CHARS)
      || typeof device.fingerprint !== "string"
      || !/^[a-f0-9]{64}$/.test(device.fingerprint)
      || !isBoundedInteger(device.ordinal, 0, MAX_CAPTURE_DEVICE_ORDINAL)
      || device.ordinal !== ordinal
      || typeof device.isDefault !== "boolean"
      || typeof device.systemMonitorEligible !== "boolean"
      || device.rawPathExposed !== false
      || device.keyMaterialExposedToRenderer !== false
    ) {
      return invalidResult(method, deviceField);
    }
    seenIds.add(device.id as string);
    return {
      id: device.id,
      label: device.label,
      fingerprint: device.fingerprint,
      ordinal: device.ordinal,
      isDefault: device.isDefault,
      systemMonitorEligible: device.systemMonitorEligible,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
  });
}

function canonicalOutputDevices(value: JsonValue, method: string, field: string): JsonValue[] {
  if (!Array.isArray(value) || value.length > MAX_CAPTURE_DEVICES_PER_KIND) {
    return invalidResult(method, field);
  }
  const seenIds = new Set<string>();
  return value.map((candidate, index) => {
    const deviceField = `${field}[${index}]`;
    const device = exactResultKeys(candidate, method, deviceField, [
      "id",
      "label",
      "isDefault",
      "loopbackEligible",
      "rawPathExposed",
      "keyMaterialExposedToRenderer",
    ]);
    const idMatch = typeof device.id === "string"
      ? /^output-(0|[1-9]\d{0,3})$/.exec(device.id)
      : null;
    if (
      !idMatch
      || Number(idMatch[1]) > MAX_CAPTURE_DEVICE_ORDINAL
      || seenIds.has(device.id as string)
      || !isBoundedString(device.label, 1, MAX_CAPTURE_DEVICE_LABEL_CHARS)
      || typeof device.isDefault !== "boolean"
      || typeof device.loopbackEligible !== "boolean"
      || device.rawPathExposed !== false
      || device.keyMaterialExposedToRenderer !== false
    ) {
      return invalidResult(method, deviceField);
    }
    seenIds.add(device.id as string);
    return {
      id: device.id,
      label: device.label,
      isDefault: device.isDefault,
      loopbackEligible: device.loopbackEligible,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
  });
}

function captureDevicesResultSchema(method: string): JsonRuntimeSchema {
  const outer = jsonObjectResultSchema(method, {});
  return createRuntimeSchema(`${method}.result`, (value) => {
    const result = exactResultKeys(outer.parse(value), method, "result", [
      "defaultInputAvailable",
      "defaultOutputAvailable",
      "inputs",
      "outputs",
      "devices",
      "rawPathExposed",
      "keyMaterialExposedToRenderer",
    ]);
    if (
      typeof result.defaultInputAvailable !== "boolean"
      || typeof result.defaultOutputAvailable !== "boolean"
      || result.rawPathExposed !== false
      || result.keyMaterialExposedToRenderer !== false
    ) {
      return invalidResult(method, "device list custody");
    }
    return {
      defaultInputAvailable: result.defaultInputAvailable,
      defaultOutputAvailable: result.defaultOutputAvailable,
      inputs: canonicalInputDevices(result.inputs, method, "inputs"),
      outputs: canonicalOutputDevices(result.outputs, method, "outputs"),
      devices: canonicalInputDevices(result.devices, method, "devices"),
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
  });
}

const microphonePreferenceResolutions = new Set([
  "default",
  "unavailable",
  "fingerprint",
  "ambiguous-fingerprint",
  "default-fallback",
]);

function capturePreferencesResultSchema(method: string): JsonRuntimeSchema {
  const outer = jsonObjectResultSchema(method, {});
  return createRuntimeSchema(`${method}.result`, (value) => {
    const result = exactResultKeys(outer.parse(value), method, "result", [
      "implemented",
      "state",
      "configured",
      "preferredMicrophoneId",
      "preferredMicrophone",
      "failureCode",
      "localOnly",
      "rawPathExposed",
      "keyMaterialExposedToRenderer",
    ]);
    const preferred = exactResultKeys(result.preferredMicrophone, method, "preferredMicrophone", [
      "deviceId",
      "deviceLabel",
      "fingerprint",
      "ordinal",
      "resolution",
      "reselectionRequired",
    ]);
    const deviceIdMatch = typeof preferred.deviceId === "string"
      ? /^input-(0|[1-9]\d{0,3})$/.exec(preferred.deviceId)
      : null;
    const failureCodeValid = result.failureCode === null
      || (typeof result.failureCode === "string" && /^[A-Z0-9_]{1,100}$/.test(result.failureCode));
    const labelValid = preferred.deviceLabel === null
      || isBoundedString(preferred.deviceLabel, 1, MAX_CAPTURE_DEVICE_LABEL_CHARS);
    const fingerprintValid = preferred.fingerprint === null
      || (typeof preferred.fingerprint === "string" && /^[a-fA-F0-9]{64}$/.test(preferred.fingerprint));
    const ordinalValid = preferred.ordinal === null
      || isBoundedInteger(preferred.ordinal, 0, MAX_CAPTURE_DEVICE_ORDINAL);
    if (
      result.implemented !== true
      || (result.state !== "ready" && result.state !== "corrupt")
      || typeof result.configured !== "boolean"
      || result.preferredMicrophoneId !== preferred.deviceId
      || (!deviceIdMatch && preferred.deviceId !== "default")
      || (deviceIdMatch !== null && Number(deviceIdMatch[1]) > MAX_CAPTURE_DEVICE_ORDINAL)
      || !labelValid
      || !fingerprintValid
      || !ordinalValid
      || typeof preferred.resolution !== "string"
      || !microphonePreferenceResolutions.has(preferred.resolution)
      || typeof preferred.reselectionRequired !== "boolean"
      || !failureCodeValid
      || result.localOnly !== true
      || result.rawPathExposed !== false
      || result.keyMaterialExposedToRenderer !== false
      || (result.state === "ready" && result.failureCode !== null)
      || (result.state === "corrupt" && result.failureCode === null)
    ) {
      return invalidResult(method, "microphone preference");
    }

    if (result.configured) {
      if (
        preferred.fingerprint === null
        || preferred.ordinal === null
        || (preferred.resolution === "fingerprint" && (
          !deviceIdMatch
          || preferred.reselectionRequired
          || preferred.deviceLabel === null
        ))
        || (preferred.resolution !== "fingerprint" && (
          preferred.deviceId !== "default"
          || !preferred.reselectionRequired
        ))
      ) {
        return invalidResult(method, "preferredMicrophone identity");
      }
    } else if (
      preferred.deviceId !== "default"
      || preferred.fingerprint !== null
      || preferred.ordinal !== null
      || preferred.reselectionRequired
      || (preferred.resolution !== "default" && preferred.resolution !== "unavailable")
    ) {
      return invalidResult(method, "default microphone preference");
    }

    return {
      implemented: true,
      state: result.state,
      configured: result.configured,
      preferredMicrophoneId: preferred.deviceId,
      preferredMicrophone: {
        deviceId: preferred.deviceId,
        deviceLabel: preferred.deviceLabel,
        fingerprint: typeof preferred.fingerprint === "string"
          ? preferred.fingerprint.toLowerCase()
          : null,
        ordinal: preferred.ordinal,
        resolution: preferred.resolution,
        reselectionRequired: preferred.reselectionRequired,
      },
      failureCode: result.failureCode,
      localOnly: true,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
  });
}

const microphoneTestStatusStates = new Set([
  "idle",
  "listening",
  "signal-detected",
  "clipping",
  "playback-ready",
  "no-signal",
  "permission-denied",
  "device-disconnected",
]);

function canonicalMicrophoneAccessError(
  value: JsonValue,
  method: string,
): { code: string; message: string } | null {
  if (value === null) return null;
  const accessError = exactResultKeys(value, method, "accessError", ["code", "message"]);
  if (
    accessError.code === "MICROPHONE_PERMISSION_DENIED"
    && accessError.message === "Microphone access is blocked by operating-system privacy settings"
  ) {
    return { code: accessError.code, message: accessError.message };
  }
  if (
    accessError.code === "MICROPHONE_DEVICE_DISCONNECTED"
    && accessError.message === "Microphone access ended because the device became unavailable"
  ) {
    return { code: accessError.code, message: accessError.message };
  }
  return invalidResult(method, "accessError");
}

function microphoneTestStatusResultSchema(method: string): JsonRuntimeSchema {
  const outer = jsonObjectResultSchema(method, {});
  const baseKeys = [
    "implemented",
    "active",
    "state",
    "deviceLabel",
    "sourceSampleRateHz",
    "sourceChannelCount",
    "sampleRateHz",
    "channelCount",
    "rms",
    "peak",
    "clipping",
    "signalDetected",
    "signalState",
    "captureComplete",
    "sampleCount",
    "bufferedDurationMs",
    "durationMs",
    "maxDurationMs",
    "accessError",
    "lastError",
    "ephemeral",
    "rawPathExposed",
    "keyMaterialExposedToRenderer",
  ] as const;
  return createRuntimeSchema(`${method}.result`, (value) => {
    const parsed = outer.parse(value);
    const parsedObject = objectResult(parsed, method, "result");
    const hasSelectionResolution = Object.prototype.hasOwnProperty.call(parsedObject, "selectionResolution");
    const hasReselectionRequired = Object.prototype.hasOwnProperty.call(parsedObject, "reselectionRequired");
    if (hasSelectionResolution !== hasReselectionRequired) {
      return invalidResult(method, "microphone test selection shape");
    }
    const result = exactResultKeys(
      parsed,
      method,
      "result",
      hasSelectionResolution
        ? [...baseKeys, "selectionResolution", "reselectionRequired"]
        : baseKeys,
    );
    const accessError = canonicalMicrophoneAccessError(result.accessError, method);
    const rms = result.rms;
    const peak = result.peak;
    const expectedSignalState = result.clipping === true
      ? "clipping"
      : result.signalDetected === true
        ? "signal"
        : hasSelectionResolution
          ? "silence"
          : "inactive";
    const expectedState = accessError?.code === "MICROPHONE_PERMISSION_DENIED"
      ? "permission-denied"
      : accessError?.code === "MICROPHONE_DEVICE_DISCONNECTED"
        ? "device-disconnected"
        : result.captureComplete === true
          ? result.signalDetected === true ? "playback-ready" : "no-signal"
          : result.active === false
            ? "idle"
            : result.clipping === true
              ? "clipping"
              : result.signalDetected === true
                ? "signal-detected"
                : "listening";
    const expectedLastError = accessError?.code === "MICROPHONE_PERMISSION_DENIED"
      ? "microphone permission denied"
      : accessError?.code === "MICROPHONE_DEVICE_DISCONNECTED"
        ? "microphone device became unavailable"
        : null;
    if (
      result.implemented !== true
      || typeof result.active !== "boolean"
      || typeof result.state !== "string"
      || !microphoneTestStatusStates.has(result.state)
      || result.state !== expectedState
      || result.sampleRateHz !== MIC_TEST_SAMPLE_RATE_HZ
      || result.channelCount !== MIC_TEST_CHANNEL_COUNT
      || typeof rms !== "number"
      || !Number.isFinite(rms)
      || rms < 0
      || rms > 1
      || typeof peak !== "number"
      || !Number.isFinite(peak)
      || peak < 0
      || peak > 1
      || rms > peak + Number.EPSILON
      || typeof result.clipping !== "boolean"
      || typeof result.signalDetected !== "boolean"
      || result.signalState !== expectedSignalState
      || typeof result.captureComplete !== "boolean"
      || !isBoundedInteger(result.sampleCount, 0, MIC_TEST_MAX_SAMPLE_COUNT)
      || result.bufferedDurationMs !== Math.floor((result.sampleCount * 1_000) / MIC_TEST_SAMPLE_RATE_HZ)
      || !isBoundedInteger(result.durationMs, 0, MIC_TEST_MAX_DURATION_MS)
      || result.maxDurationMs !== MIC_TEST_MAX_DURATION_MS
      || result.lastError !== expectedLastError
      || result.ephemeral !== true
      || result.rawPathExposed !== false
      || result.keyMaterialExposedToRenderer !== false
    ) {
      return invalidResult(method, "microphone test status");
    }

    let deviceLabel: string | null = null;
    let sourceSampleRateHz: number | null = null;
    let sourceChannelCount: number | null = null;
    let selectionResolution: string | null | undefined;
    let reselectionRequired: boolean | undefined;
    if (hasSelectionResolution) {
      const metadataIsNull = result.deviceLabel === null
        && result.sourceSampleRateHz === null
        && result.sourceChannelCount === null
        && result.selectionResolution === null;
      const metadataIsPresent = isBoundedString(result.deviceLabel, 1, MAX_CAPTURE_DEVICE_LABEL_CHARS)
        && isBoundedInteger(result.sourceSampleRateHz, 1, 1_000_000)
        && isBoundedInteger(result.sourceChannelCount, 1, 256)
        && typeof result.selectionResolution === "string"
        && ["default", "fingerprint", "default-fallback", "ambiguous-fingerprint"]
          .includes(result.selectionResolution);
      if (
        (!metadataIsNull && !metadataIsPresent)
        || typeof result.reselectionRequired !== "boolean"
        || (metadataIsNull && result.reselectionRequired)
        || (metadataIsPresent
          && (result.selectionResolution === "default" || result.selectionResolution === "fingerprint")
          && result.reselectionRequired)
        || (metadataIsPresent
          && (result.selectionResolution === "default-fallback" || result.selectionResolution === "ambiguous-fingerprint")
          && !result.reselectionRequired)
      ) {
        return invalidResult(method, "microphone test selection");
      }
      deviceLabel = result.deviceLabel as string | null;
      sourceSampleRateHz = result.sourceSampleRateHz as number | null;
      sourceChannelCount = result.sourceChannelCount as number | null;
      selectionResolution = result.selectionResolution as string | null;
      reselectionRequired = result.reselectionRequired;
    } else if (
      result.active !== false
      || result.state !== "idle"
      || result.deviceLabel !== null
      || result.sourceSampleRateHz !== null
      || result.sourceChannelCount !== null
      || rms !== 0
      || peak !== 0
      || result.clipping !== false
      || result.signalDetected !== false
      || result.captureComplete !== false
      || result.sampleCount !== 0
      || result.bufferedDurationMs !== 0
      || result.durationMs !== 0
      || accessError !== null
    ) {
      return invalidResult(method, "inactive microphone test status");
    }

    return {
      implemented: true,
      active: result.active,
      state: result.state,
      deviceLabel,
      sourceSampleRateHz,
      sourceChannelCount,
      ...(hasSelectionResolution ? { selectionResolution, reselectionRequired } : {}),
      sampleRateHz: MIC_TEST_SAMPLE_RATE_HZ,
      channelCount: MIC_TEST_CHANNEL_COUNT,
      rms,
      peak,
      clipping: result.clipping,
      signalDetected: result.signalDetected,
      signalState: result.signalState,
      captureComplete: result.captureComplete,
      sampleCount: result.sampleCount,
      bufferedDurationMs: result.bufferedDurationMs,
      durationMs: result.durationMs,
      maxDurationMs: MIC_TEST_MAX_DURATION_MS,
      accessError,
      lastError: expectedLastError,
      ephemeral: true,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
  });
}

function microphoneTestStopResultSchema(method: string): JsonRuntimeSchema {
  const outer = jsonObjectResultSchema(method, {});
  return createRuntimeSchema(`${method}.result`, (value) => {
    const result = exactResultKeys(outer.parse(value), method, "result", [
      "implemented",
      "active",
      "state",
      "stopped",
      "bufferCleared",
      "captureComplete",
      "sampleRateHz",
      "channelCount",
      "maxDurationMs",
      "accessError",
      "lastError",
      "rawPathExposed",
      "keyMaterialExposedToRenderer",
    ]);
    if (
      result.implemented !== true
      || result.active !== false
      || result.state !== "idle"
      || result.stopped !== true
      || result.bufferCleared !== true
      || result.captureComplete !== false
      || result.sampleRateHz !== MIC_TEST_SAMPLE_RATE_HZ
      || result.channelCount !== MIC_TEST_CHANNEL_COUNT
      || result.maxDurationMs !== MIC_TEST_MAX_DURATION_MS
      || result.accessError !== null
      || result.lastError !== null
      || result.rawPathExposed !== false
      || result.keyMaterialExposedToRenderer !== false
    ) {
      return invalidResult(method, "stopped microphone test status");
    }
    return {
      implemented: true,
      active: false,
      state: "idle",
      stopped: true,
      bufferCleared: true,
      captureComplete: false,
      sampleRateHz: MIC_TEST_SAMPLE_RATE_HZ,
      channelCount: MIC_TEST_CHANNEL_COUNT,
      maxDurationMs: MIC_TEST_MAX_DURATION_MS,
      accessError: null,
      lastError: null,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
  });
}

function validStandardBase64(value: string): boolean {
  return value.length > 0
    && value.length <= MIC_TEST_MAX_BASE64_CHARS
    && value.length % 4 === 0
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

function validPcm16MonoWav(wav: Buffer, sampleCount: number): boolean {
  const dataBytes = sampleCount * 2;
  return wav.length === MIC_TEST_WAV_HEADER_BYTES + dataBytes
    && wav.toString("ascii", 0, 4) === "RIFF"
    && wav.readUInt32LE(4) === 36 + dataBytes
    && wav.toString("ascii", 8, 16) === "WAVEfmt "
    && wav.readUInt32LE(16) === 16
    && wav.readUInt16LE(20) === 1
    && wav.readUInt16LE(22) === MIC_TEST_CHANNEL_COUNT
    && wav.readUInt32LE(24) === MIC_TEST_SAMPLE_RATE_HZ
    && wav.readUInt32LE(28) === MIC_TEST_SAMPLE_RATE_HZ * 2
    && wav.readUInt16LE(32) === 2
    && wav.readUInt16LE(34) === 16
    && wav.toString("ascii", 36, 40) === "data"
    && wav.readUInt32LE(40) === dataBytes;
}

function microphoneTestSampleResultSchema(method: string): JsonRuntimeSchema {
  const outer = jsonObjectResultSchema(method, {});
  return createRuntimeSchema(`${method}.result`, (value) => {
    const result = exactResultKeys(outer.parse(value), method, "result", [
      "format",
      "mimeType",
      "sampleRateHz",
      "channelCount",
      "bitsPerSample",
      "sampleCount",
      "durationMs",
      "byteCount",
      "dataBase64",
      "clipping",
      "signalDetected",
      "bufferCleared",
      "maxDurationMs",
      "rawPathExposed",
      "keyMaterialExposedToRenderer",
    ]);
    if (
      result.format !== "wav"
      || result.mimeType !== "audio/wav"
      || result.sampleRateHz !== MIC_TEST_SAMPLE_RATE_HZ
      || result.channelCount !== MIC_TEST_CHANNEL_COUNT
      || result.bitsPerSample !== 16
      || !isBoundedInteger(result.sampleCount, 0, MIC_TEST_MAX_SAMPLE_COUNT)
      || result.durationMs !== Math.floor((result.sampleCount * 1_000) / MIC_TEST_SAMPLE_RATE_HZ)
      || result.byteCount !== MIC_TEST_WAV_HEADER_BYTES + (result.sampleCount * 2)
      || !isBoundedInteger(result.byteCount, MIC_TEST_WAV_HEADER_BYTES, MIC_TEST_MAX_WAV_BYTES)
      || typeof result.dataBase64 !== "string"
      || !validStandardBase64(result.dataBase64)
      || typeof result.clipping !== "boolean"
      || typeof result.signalDetected !== "boolean"
      || result.bufferCleared !== true
      || result.maxDurationMs !== MIC_TEST_MAX_DURATION_MS
      || result.rawPathExposed !== false
      || result.keyMaterialExposedToRenderer !== false
    ) {
      return invalidResult(method, "microphone test sample");
    }
    const wav = Buffer.from(result.dataBase64, "base64");
    const wavValid = wav.length === result.byteCount
      && wav.toString("base64") === result.dataBase64
      && validPcm16MonoWav(wav, result.sampleCount);
    wav.fill(0);
    if (!wavValid) {
      return invalidResult(method, "microphone test WAV");
    }
    return {
      format: "wav",
      mimeType: "audio/wav",
      sampleRateHz: MIC_TEST_SAMPLE_RATE_HZ,
      channelCount: MIC_TEST_CHANNEL_COUNT,
      bitsPerSample: 16,
      sampleCount: result.sampleCount,
      durationMs: result.durationMs,
      byteCount: result.byteCount,
      dataBase64: result.dataBase64,
      clipping: result.clipping,
      signalDetected: result.signalDetected,
      bufferCleared: true,
      maxDurationMs: MIC_TEST_MAX_DURATION_MS,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
  });
}

const UINT32_MAX = 4_294_967_295;
const SAFE_IDENTIFIER_PATTERN = /^[a-z](?:[a-z0-9]|-(?!-)){0,62}[a-z0-9]$|^[a-z0-9]$/;

function isSafeLowerIdentifier(value: JsonValue, maxBytes = 64): value is string {
  return typeof value === "string"
    && Buffer.byteLength(value, "utf8") <= maxBytes
    && SAFE_IDENTIFIER_PATTERN.test(value);
}

function isBoundedUtf8String(
  value: JsonValue,
  minimumBytes: number,
  maximumBytes: number,
): value is string {
  return typeof value === "string"
    && Buffer.byteLength(value, "utf8") >= minimumBytes
    && Buffer.byteLength(value, "utf8") <= maximumBytes;
}

function hasControlCharacter(value: string): boolean {
  return /\p{Cc}/u.test(value);
}

const builtInMeetingProfileIds = new Set([
  "general",
  "one-on-one",
  "interview",
  "standup",
  "lecture",
]);

function canonicalMeetingProfile(value: JsonValue, method: string, field: string): JsonValue {
  const profile = exactResultKeys(value, method, field, [
    "schemaVersion",
    "version",
    "id",
    "name",
    "captureSource",
    "language",
    "localModelTier",
    "speechModelId",
    "cleanupModelId",
    "summaryModelId",
    "dictionaryIds",
    "replacementRuleSetId",
    "recapTemplate",
    "liveTranscription",
    "builtIn",
  ]);
  if (!Array.isArray(profile.dictionaryIds) || profile.dictionaryIds.length > 16) {
    return invalidResult(method, `${field}.dictionaryIds`);
  }
  const dictionaryIds: string[] = [];
  const seenDictionaryIds = new Set<string>();
  for (const [index, dictionaryId] of profile.dictionaryIds.entries()) {
    if (!isSafeLowerIdentifier(dictionaryId) || seenDictionaryIds.has(dictionaryId)) {
      return invalidResult(method, `${field}.dictionaryIds[${index}]`);
    }
    seenDictionaryIds.add(dictionaryId);
    dictionaryIds.push(dictionaryId);
  }
  const languageValid = typeof profile.language === "string"
    && Buffer.byteLength(profile.language, "utf8") <= 35
    && (
      profile.language === "auto"
      || /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*$/.test(profile.language)
    );
  const builtIn = profile.builtIn;
  if (
    profile.schemaVersion !== 2
    || !isBoundedInteger(profile.version, 1, UINT32_MAX)
    || !isSafeLowerIdentifier(profile.id)
    || !isBoundedUtf8String(profile.name, 1, 80)
    || profile.name.trim() !== profile.name
    || hasControlCharacter(profile.name)
    || (profile.captureSource !== "microphone"
      && profile.captureSource !== "system-audio"
      && profile.captureSource !== "combined")
    || !languageValid
    || (profile.localModelTier !== "fast"
      && profile.localModelTier !== "balanced"
      && profile.localModelTier !== "maximum")
    || !new Set(["small.en", "small", "large-v3-turbo", "large-v3"]).has(profile.speechModelId as string)
    || (profile.cleanupModelId !== null && profile.cleanupModelId !== "qwen3-4b-official-q4_k_m")
    || (profile.summaryModelId !== null && profile.summaryModelId !== "qwen3-4b-official-q4_k_m")
    || (profile.replacementRuleSetId !== null
      && !isSafeLowerIdentifier(profile.replacementRuleSetId))
    || !isBoundedUtf8String(profile.recapTemplate, 0, 4 * 1024)
    || profile.recapTemplate.includes("\0")
    || typeof profile.liveTranscription !== "boolean"
    || typeof builtIn !== "boolean"
    || (builtIn !== builtInMeetingProfileIds.has(profile.id))
  ) {
    return invalidResult(method, field);
  }
  return {
    schemaVersion: 2,
    version: profile.version,
    id: profile.id,
    name: profile.name,
    captureSource: profile.captureSource,
    language: profile.language,
    localModelTier: profile.localModelTier,
    speechModelId: profile.speechModelId,
    cleanupModelId: profile.cleanupModelId,
    summaryModelId: profile.summaryModelId,
    dictionaryIds,
    replacementRuleSetId: profile.replacementRuleSetId,
    recapTemplate: profile.recapTemplate,
    liveTranscription: profile.liveTranscription,
    builtIn,
  };
}

function meetingProfilesListResultSchema(method: string): JsonRuntimeSchema {
  const outer = jsonObjectResultSchema(method, {});
  return createRuntimeSchema(`${method}.result`, (value) => {
    const result = exactResultKeys(outer.parse(value), method, "result", [
      "implemented",
      "schemaVersion",
      "profiles",
      "activeProfileId",
      "profileCount",
      "customProfileLimit",
      "localOnly",
      "networkAttempted",
      "rawPathExposed",
      "keyMaterialExposedToRenderer",
    ]);
    if (!Array.isArray(result.profiles) || result.profiles.length < 5 || result.profiles.length > 29) {
      return invalidResult(method, "profiles");
    }
    const profiles = result.profiles.map((profile, index) => (
      canonicalMeetingProfile(profile, method, `profiles[${index}]`)
    ));
    const ids = profiles.map((profile) => (profile as Record<string, JsonValue>).id as string);
    const uniqueIds = new Set(ids);
    if (
      result.implemented !== true
      || result.schemaVersion !== 2
      || uniqueIds.size !== profiles.length
      || [...builtInMeetingProfileIds].some((id) => !uniqueIds.has(id))
      || !isSafeLowerIdentifier(result.activeProfileId)
      || !uniqueIds.has(result.activeProfileId)
      || result.profileCount !== profiles.length
      || result.customProfileLimit !== 24
      || result.localOnly !== true
      || result.networkAttempted !== false
      || result.rawPathExposed !== false
      || result.keyMaterialExposedToRenderer !== false
    ) {
      return invalidResult(method, "meeting profile list");
    }
    return {
      implemented: true,
      schemaVersion: 2,
      profiles,
      activeProfileId: result.activeProfileId,
      profileCount: profiles.length,
      customProfileLimit: 24,
      localOnly: true,
      networkAttempted: false,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
  });
}

function meetingProfileResultSchema(method: string, customOnly: boolean): JsonRuntimeSchema {
  const outer = jsonObjectResultSchema(method, {});
  return createRuntimeSchema(`${method}.result`, (value) => {
    const result = exactResultKeys(outer.parse(value), method, "result", [
      "implemented",
      "profile",
      "localOnly",
      "networkAttempted",
      "rawPathExposed",
      "keyMaterialExposedToRenderer",
    ]);
    const profile = canonicalMeetingProfile(result.profile, method, "profile") as Record<string, JsonValue>;
    if (
      result.implemented !== true
      || (customOnly && profile.builtIn !== false)
      || result.localOnly !== true
      || result.networkAttempted !== false
      || result.rawPathExposed !== false
      || result.keyMaterialExposedToRenderer !== false
    ) {
      return invalidResult(method, "meeting profile response");
    }
    return {
      implemented: true,
      profile,
      localOnly: true,
      networkAttempted: false,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
  });
}

function canonicalReplacementRule(value: JsonValue, method: string, field: string): JsonValue {
  const rule = exactResultKeys(value, method, field, [
    "id",
    "order",
    "matchMode",
    "literal",
    "replacement",
    "protectedTermReview",
    "enabled",
  ]);
  if (
    !isSafeLowerIdentifier(rule.id)
    || !isBoundedInteger(rule.order, 0, 10_000)
    || (rule.matchMode !== "exact" && rule.matchMode !== "whole-word")
    || !isBoundedUtf8String(rule.literal, 1, 128)
    || rule.literal.includes("\0")
    || !isBoundedUtf8String(rule.replacement, 0, 512)
    || rule.replacement.includes("\0")
    || typeof rule.protectedTermReview !== "boolean"
    || typeof rule.enabled !== "boolean"
  ) {
    return invalidResult(method, field);
  }
  return {
    id: rule.id,
    order: rule.order,
    matchMode: rule.matchMode,
    literal: rule.literal,
    replacement: rule.replacement,
    protectedTermReview: rule.protectedTermReview,
    enabled: rule.enabled,
  };
}

function canonicalReplacementRuleSet(value: JsonValue, method: string, field: string): JsonValue {
  const ruleSet = exactResultKeys(value, method, field, [
    "schemaVersion",
    "version",
    "id",
    "name",
    "rules",
    "builtIn",
  ]);
  if (!Array.isArray(ruleSet.rules) || ruleSet.rules.length > 64) {
    return invalidResult(method, `${field}.rules`);
  }
  const rules = ruleSet.rules.map((rule, index) => (
    canonicalReplacementRule(rule, method, `${field}.rules[${index}]`)
  ));
  const seenIds = new Set<string>();
  const seenOrders = new Set<number>();
  let previousOrder = -1;
  for (const [index, value] of rules.entries()) {
    const rule = value as Record<string, JsonValue>;
    const id = rule.id as string;
    const order = rule.order as number;
    if (seenIds.has(id) || seenOrders.has(order) || order <= previousOrder) {
      return invalidResult(method, `${field}.rules[${index}] order`);
    }
    seenIds.add(id);
    seenOrders.add(order);
    previousOrder = order;
  }
  if (
    ruleSet.schemaVersion !== 1
    || !isBoundedInteger(ruleSet.version, 1, UINT32_MAX)
    || !isSafeLowerIdentifier(ruleSet.id)
    || !isBoundedUtf8String(ruleSet.name, 1, 80)
    || ruleSet.name.trim() !== ruleSet.name
    || hasControlCharacter(ruleSet.name)
    || typeof ruleSet.builtIn !== "boolean"
    || (ruleSet.builtIn !== (ruleSet.id === "none"))
    || (ruleSet.builtIn && rules.length !== 0)
  ) {
    return invalidResult(method, field);
  }
  return {
    schemaVersion: 1,
    version: ruleSet.version,
    id: ruleSet.id,
    name: ruleSet.name,
    rules,
    builtIn: ruleSet.builtIn,
  };
}

function replacementCustodyIsStrict(result: Record<string, JsonValue>): boolean {
  return result.separateFromAsrVocabularyHints === true
    && result.asrVocabularyHintsApplied === false
    && result.localOnly === true
    && result.networkAttempted === false
    && result.rawPathExposed === false
    && result.keyMaterialExposedToRenderer === false;
}

function replacementRuleSetsListResultSchema(method: string): JsonRuntimeSchema {
  const outer = jsonObjectResultSchema(method, {});
  return createRuntimeSchema(`${method}.result`, (value) => {
    const result = exactResultKeys(outer.parse(value), method, "result", [
      "implemented",
      "schemaVersion",
      "ruleSets",
      "ruleSetCount",
      "customRuleSetLimit",
      "ruleLimitPerSet",
      "separateFromAsrVocabularyHints",
      "asrVocabularyHintsApplied",
      "localOnly",
      "networkAttempted",
      "rawPathExposed",
      "keyMaterialExposedToRenderer",
    ]);
    if (!Array.isArray(result.ruleSets) || result.ruleSets.length < 1 || result.ruleSets.length > 17) {
      return invalidResult(method, "ruleSets");
    }
    const ruleSets = result.ruleSets.map((ruleSet, index) => (
      canonicalReplacementRuleSet(ruleSet, method, `ruleSets[${index}]`)
    ));
    const ids = ruleSets.map((ruleSet) => (ruleSet as Record<string, JsonValue>).id as string);
    if (
      result.implemented !== true
      || result.schemaVersion !== 1
      || new Set(ids).size !== ruleSets.length
      || ids.filter((id) => id === "none").length !== 1
      || result.ruleSetCount !== ruleSets.length
      || result.customRuleSetLimit !== 16
      || result.ruleLimitPerSet !== 64
      || !replacementCustodyIsStrict(result)
    ) {
      return invalidResult(method, "replacement rule set list");
    }
    return {
      implemented: true,
      schemaVersion: 1,
      ruleSets,
      ruleSetCount: ruleSets.length,
      customRuleSetLimit: 16,
      ruleLimitPerSet: 64,
      separateFromAsrVocabularyHints: true,
      asrVocabularyHintsApplied: false,
      localOnly: true,
      networkAttempted: false,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
  });
}

function replacementRuleSetResultSchema(method: string, customOnly: boolean): JsonRuntimeSchema {
  const outer = jsonObjectResultSchema(method, {});
  return createRuntimeSchema(`${method}.result`, (value) => {
    const result = exactResultKeys(outer.parse(value), method, "result", [
      "implemented",
      "ruleSet",
      "separateFromAsrVocabularyHints",
      "asrVocabularyHintsApplied",
      "localOnly",
      "networkAttempted",
      "rawPathExposed",
      "keyMaterialExposedToRenderer",
    ]);
    const ruleSet = canonicalReplacementRuleSet(result.ruleSet, method, "ruleSet") as Record<string, JsonValue>;
    if (
      result.implemented !== true
      || (customOnly && ruleSet.builtIn !== false)
      || !replacementCustodyIsStrict(result)
    ) {
      return invalidResult(method, "replacement rule set response");
    }
    return {
      implemented: true,
      ruleSet,
      separateFromAsrVocabularyHints: true,
      asrVocabularyHintsApplied: false,
      localOnly: true,
      networkAttempted: false,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
  });
}

function canonicalReplacementChange(value: JsonValue, method: string, field: string): JsonValue {
  const change = exactResultKeys(value, method, field, [
    "ruleId",
    "ruleOrder",
    "replacementCount",
    "protectedTermReview",
  ]);
  if (
    !isSafeLowerIdentifier(change.ruleId)
    || !isBoundedInteger(change.ruleOrder, 0, 10_000)
    || !isBoundedInteger(change.replacementCount, 1, UINT32_MAX)
    || typeof change.protectedTermReview !== "boolean"
  ) {
    return invalidResult(method, field);
  }
  return {
    ruleId: change.ruleId,
    ruleOrder: change.ruleOrder,
    replacementCount: change.replacementCount,
    protectedTermReview: change.protectedTermReview,
  };
}

function replacementPreviewResultSchema(method: string, applied: boolean): JsonRuntimeSchema {
  const outer = jsonObjectResultSchema(method, {});
  return createRuntimeSchema(`${method}.result`, (value) => {
    const result = exactResultKeys(outer.parse(value), method, "result", [
      "implemented",
      "applied",
      "changed",
      "previewText",
      "previewToken",
      "changes",
      "replacementCount",
      "protectedTermReviewRequired",
      "previewRequiredBeforeApply",
      "rulesAreOrdered",
      "rendererRegexAccepted",
      "separateFromAsrVocabularyHints",
      "asrVocabularyHintsApplied",
      "localOnly",
      "networkAttempted",
      "rawPathExposed",
      "keyMaterialExposedToRenderer",
    ]);
    if (!Array.isArray(result.changes) || result.changes.length > 64) {
      return invalidResult(method, "changes");
    }
    const changes = result.changes.map((change, index) => (
      canonicalReplacementChange(change, method, `changes[${index}]`)
    ));
    const seenIds = new Set<string>();
    const seenOrders = new Set<number>();
    let previousOrder = -1;
    let replacementCount = 0;
    let protectedTermReviewRequired = false;
    for (const [index, value] of changes.entries()) {
      const change = value as Record<string, JsonValue>;
      const id = change.ruleId as string;
      const order = change.ruleOrder as number;
      if (seenIds.has(id) || seenOrders.has(order) || order <= previousOrder) {
        return invalidResult(method, `changes[${index}] order`);
      }
      seenIds.add(id);
      seenOrders.add(order);
      previousOrder = order;
      replacementCount = Math.min(UINT32_MAX, replacementCount + (change.replacementCount as number));
      protectedTermReviewRequired ||= change.protectedTermReview === true;
    }
    if (
      result.implemented !== true
      || result.applied !== applied
      || typeof result.changed !== "boolean"
      || !isBoundedUtf8String(result.previewText, 0, 512 * 1024)
      || result.previewText.includes("\0")
      || typeof result.previewToken !== "string"
      || !/^[a-f0-9]{64}$/.test(result.previewToken)
      || result.replacementCount !== replacementCount
      || result.changed !== (replacementCount > 0)
      || result.protectedTermReviewRequired !== protectedTermReviewRequired
      || result.previewRequiredBeforeApply !== true
      || result.rulesAreOrdered !== true
      || result.rendererRegexAccepted !== false
      || !replacementCustodyIsStrict(result)
    ) {
      return invalidResult(method, "replacement preview");
    }
    return {
      implemented: true,
      applied,
      changed: result.changed,
      previewText: result.previewText,
      previewToken: result.previewToken,
      changes,
      replacementCount,
      protectedTermReviewRequired,
      previewRequiredBeforeApply: true,
      rulesAreOrdered: true,
      rendererRegexAccepted: false,
      separateFromAsrVocabularyHints: true,
      asrVocabularyHintsApplied: false,
      localOnly: true,
      networkAttempted: false,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
  });
}

function isBoundedRecordingIdentifier(value: JsonValue, maxLength: number): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= maxLength
    && /^[A-Za-z0-9_-]+$/.test(value);
}

function protectedTermReviewResultSchema(method: string): JsonRuntimeSchema {
  const outer = jsonObjectResultSchema(method, {});
  return createRuntimeSchema(`${method}.result`, (value) => {
    const result = exactResultKeys(outer.parse(value), method, "result", [
      "implemented",
      "recordingId",
      "revisionId",
      "ruleSetId",
      "ruleSetVersion",
      "reviewRequired",
      "replacementCount",
      "changes",
      "changedSegmentCount",
      "previewSegments",
      "previewTruncated",
      "previewToken",
      "durableApplyCreatesRevision",
      "rendererSuppliedTranscriptAccepted",
      "captureTimeRuleSnapshotUsed",
      "localOnly",
      "networkAttempted",
      "rawPathExposed",
      "keyMaterialExposedToRenderer",
    ]);
    const changes = canonicalReplacementChanges(result.changes, method, "changes", true);
    if (!Array.isArray(result.previewSegments) || result.previewSegments.length > 64) {
      return invalidResult(method, "previewSegments");
    }
    const previewSegments = result.previewSegments.map((candidate, index) => {
      const segment = exactResultKeys(candidate, method, `previewSegments[${index}]`, [
        "channel",
        "speaker",
        "startMs",
        "durationMs",
        "before",
        "after",
        "beforeTruncated",
        "afterTruncated",
      ]);
      if (
        !isBoundedRecordingIdentifier(segment.channel, 32)
        || (segment.speaker !== null
          && (typeof segment.speaker !== "string" || !isBoundedUtf8String(segment.speaker, 1, 80)))
        || !isBoundedInteger(segment.startMs, 0, Number.MAX_SAFE_INTEGER)
        || !isBoundedInteger(segment.durationMs, 0, Number.MAX_SAFE_INTEGER)
        || typeof segment.before !== "string"
        || !isBoundedUtf8String(segment.before, 0, 1_024)
        || typeof segment.after !== "string"
        || !isBoundedUtf8String(segment.after, 0, 1_024)
        || typeof segment.beforeTruncated !== "boolean"
        || typeof segment.afterTruncated !== "boolean"
        || segment.before === segment.after
      ) return invalidResult(method, `previewSegments[${index}]`);
      return segment;
    });
    let replacementCount = 0;
    for (const change of changes) {
      replacementCount = Math.min(
        UINT32_MAX,
        replacementCount + ((change as Record<string, JsonValue>).replacementCount as number),
      );
    }
    const revisionValid = result.revisionId === null
      || isBoundedRecordingIdentifier(result.revisionId, 96);
    const ruleSetValid = result.ruleSetId === null
      || (typeof result.ruleSetId === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(result.ruleSetId));
    const tokenValid = result.previewToken === null
      || (typeof result.previewToken === "string" && /^[a-f0-9]{64}$/.test(result.previewToken));
    const reviewRequired = replacementCount > 0;
    if (
      result.implemented !== true
      || !isBoundedRecordingIdentifier(result.recordingId, 96)
      || !revisionValid
      || !ruleSetValid
      || (result.ruleSetVersion !== null && !isBoundedInteger(result.ruleSetVersion, 1, UINT32_MAX))
      || (result.ruleSetId === null) !== (result.ruleSetVersion === null)
      || result.reviewRequired !== reviewRequired
      || result.replacementCount !== replacementCount
      || !isBoundedInteger(result.changedSegmentCount, 0, 100_000)
      || (result.changedSegmentCount as number) < previewSegments.length
      || result.previewTruncated !== ((result.changedSegmentCount as number) > previewSegments.length)
      || !tokenValid
      || (reviewRequired && (
        result.revisionId === null
        || result.ruleSetId === null
        || result.previewToken === null
        || previewSegments.length === 0
      ))
      || (!reviewRequired && (
        result.previewToken !== null
        || previewSegments.length !== 0
        || result.changedSegmentCount !== 0
      ))
      || result.durableApplyCreatesRevision !== true
      || result.rendererSuppliedTranscriptAccepted !== false
      || result.captureTimeRuleSnapshotUsed !== true
      || result.localOnly !== true
      || result.networkAttempted !== false
      || result.rawPathExposed !== false
      || result.keyMaterialExposedToRenderer !== false
    ) return invalidResult(method, "protected-term review");
    return {
      implemented: true,
      recordingId: result.recordingId,
      revisionId: result.revisionId,
      ruleSetId: result.ruleSetId,
      ruleSetVersion: result.ruleSetVersion,
      reviewRequired,
      replacementCount,
      changes,
      changedSegmentCount: result.changedSegmentCount,
      previewSegments,
      previewTruncated: result.previewTruncated,
      previewToken: result.previewToken,
      durableApplyCreatesRevision: true,
      rendererSuppliedTranscriptAccepted: false,
      captureTimeRuleSnapshotUsed: true,
      localOnly: true,
      networkAttempted: false,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
  });
}

function protectedTermApplyResultSchema(method: string): JsonRuntimeSchema {
  const outer = jsonObjectResultSchema(method, {});
  return createRuntimeSchema(`${method}.result`, (value) => {
    const result = exactResultKeys(outer.parse(value), method, "result", [
      "implemented",
      "recordingId",
      "applied",
      "replacementCount",
      "writtenSegmentCount",
      "ruleSetId",
      "ruleSetVersion",
      "trustHistory",
      "localOnly",
      "networkAttempted",
      "rawPathExposed",
      "keyMaterialExposedToRenderer",
    ]);
    const history = exactResultKeys(result.trustHistory, method, "trustHistory", [
      "recordingId",
      "revisionId",
      "version",
      "receiptId",
      "source",
      "current",
      "rawPathExposed",
      "keyMaterialExposedToRenderer",
    ]);
    if (
      result.implemented !== true
      || result.applied !== true
      || !isBoundedRecordingIdentifier(result.recordingId, 96)
      || !isBoundedInteger(result.replacementCount, 1, UINT32_MAX)
      || !isBoundedInteger(result.writtenSegmentCount, 0, 100_000)
      || typeof result.ruleSetId !== "string"
      || !/^[a-z][a-z0-9-]{0,63}$/.test(result.ruleSetId)
      || !isBoundedInteger(result.ruleSetVersion, 1, UINT32_MAX)
      || history.recordingId !== result.recordingId
      || !isBoundedRecordingIdentifier(history.revisionId, 96)
      || !isBoundedInteger(history.version, 1, 512)
      || !isBoundedRecordingIdentifier(history.receiptId, 96)
      || history.source !== "review"
      || history.current !== true
      || history.rawPathExposed !== false
      || history.keyMaterialExposedToRenderer !== false
      || result.localOnly !== true
      || result.networkAttempted !== false
      || result.rawPathExposed !== false
      || result.keyMaterialExposedToRenderer !== false
    ) return invalidResult(method, "protected-term review apply");
    return {
      implemented: true,
      recordingId: result.recordingId,
      applied: true,
      replacementCount: result.replacementCount,
      writtenSegmentCount: result.writtenSegmentCount,
      ruleSetId: result.ruleSetId,
      ruleSetVersion: result.ruleSetVersion,
      trustHistory: history,
      localOnly: true,
      networkAttempted: false,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
  });
}

function transcriptionPrepareReprocessResultSchema(method: string): JsonRuntimeSchema {
  const outer = jsonObjectResultSchema(method, {});
  return createRuntimeSchema(`${method}.result`, (value) => {
    const result = exactResultKeys(outer.parse(value), method, "result", [
      "recordingId",
      "channel",
      "inputKind",
      "audioChunkIndices",
      "audioChunkCount",
      "sourceAudioSha256",
      "sourceAudioIntegrity",
      "sampleRateHz",
      "channelCount",
      "bitsPerSample",
      "durationMs",
      "currentRevisionId",
      "revisionCount",
      "dispatchInput",
      "originalAudioModified",
      "rawPathExposed",
      "keyMaterialExposedToRenderer",
    ]);
    const dispatchInput = exactResultKeys(result.dispatchInput, method, "dispatchInput", [
      "recordingId",
      "channel",
    ]);
    if (
      !Array.isArray(result.audioChunkIndices)
      || result.audioChunkIndices.length < 1
      || result.audioChunkIndices.length > 100_000
    ) {
      return invalidResult(method, "audioChunkIndices");
    }
    const audioChunkIndices: number[] = [];
    let previousIndex = -1;
    for (const [index, chunkIndex] of result.audioChunkIndices.entries()) {
      if (!isBoundedInteger(chunkIndex, 0, UINT32_MAX) || chunkIndex <= previousIndex) {
        return invalidResult(method, `audioChunkIndices[${index}]`);
      }
      audioChunkIndices.push(chunkIndex);
      previousIndex = chunkIndex;
    }
    const integrityStates = new Set([
      "pending-background-content-hash-verification",
      "pending-background-encrypted-chunk-authentication",
      "pending-background-legacy-read",
    ]);
    const hashValid = result.sourceAudioSha256 === null
      || (typeof result.sourceAudioSha256 === "string" && /^[a-f0-9]{64}$/.test(result.sourceAudioSha256));
    const currentRevisionIdValid = result.currentRevisionId === null
      || isBoundedRecordingIdentifier(result.currentRevisionId, 96);
    if (
      !isBoundedRecordingIdentifier(result.recordingId, 96)
      || !isBoundedRecordingIdentifier(result.channel, 32)
      || result.inputKind !== "originalDurableAudio"
      || result.audioChunkCount !== audioChunkIndices.length
      || !hashValid
      || typeof result.sourceAudioIntegrity !== "string"
      || !integrityStates.has(result.sourceAudioIntegrity)
      || (result.sourceAudioIntegrity === "pending-background-content-hash-verification"
        ? result.sourceAudioSha256 === null
        : result.sourceAudioSha256 !== null)
      || !isBoundedInteger(result.sampleRateHz, 8_000, 192_000)
      || !isBoundedInteger(result.channelCount, 1, 8)
      || result.bitsPerSample !== 16
      || !isBoundedInteger(result.durationMs, 0, Number.MAX_SAFE_INTEGER)
      || !currentRevisionIdValid
      || !isBoundedInteger(result.revisionCount, 0, 100_000)
      || (result.currentRevisionId !== null && result.revisionCount === 0)
      || dispatchInput.recordingId !== result.recordingId
      || dispatchInput.channel !== result.channel
      || result.originalAudioModified !== false
      || result.rawPathExposed !== false
      || result.keyMaterialExposedToRenderer !== false
    ) {
      return invalidResult(method, "reprocessing plan");
    }
    return {
      recordingId: result.recordingId,
      channel: result.channel,
      inputKind: "originalDurableAudio",
      audioChunkIndices,
      audioChunkCount: audioChunkIndices.length,
      sourceAudioSha256: result.sourceAudioSha256,
      sourceAudioIntegrity: result.sourceAudioIntegrity,
      sampleRateHz: result.sampleRateHz,
      channelCount: result.channelCount,
      bitsPerSample: 16,
      durationMs: result.durationMs,
      currentRevisionId: result.currentRevisionId,
      revisionCount: result.revisionCount,
      dispatchInput: {
        recordingId: result.recordingId,
        channel: result.channel,
      },
      originalAudioModified: false,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
  });
}

function mediaLocalSourceValidationResultSchema(method: string): JsonRuntimeSchema {
  const fields = {
    schemaVersion: "integer",
    eligible: "boolean",
    sourceSizeBytes: "integer",
    localStorageVerified: "boolean",
    regularFile: "boolean",
    reparsePoint: "boolean",
    cloudPlaceholder: "boolean",
    localOnly: "boolean",
    networkAttempted: "boolean",
    rawPathExposed: "boolean",
    keyMaterialExposedToRenderer: "boolean",
  } as const;
  const outer = jsonObjectResultSchema(method, fields);
  return createRuntimeSchema(`${method}.result`, (value) => {
    const result = exactResultKeys(
      outer.parse(value),
      method,
      "result",
      Object.keys(fields),
    );
    if (
      result.schemaVersion !== 1
      || result.eligible !== true
      || typeof result.sourceSizeBytes !== "number"
      || result.sourceSizeBytes < 1
      || result.sourceSizeBytes > 2 * 1024 * 1024 * 1024
      || result.localStorageVerified !== true
      || result.regularFile !== true
      || result.reparsePoint !== false
      || result.cloudPlaceholder !== false
      || result.localOnly !== true
      || result.networkAttempted !== false
      || result.rawPathExposed !== false
      || result.keyMaterialExposedToRenderer !== false
    ) {
      return invalidResult(method, "private local media eligibility");
    }
    return result;
  });
}

const rendererConfigs: readonly OperationConfig[] = [
  { method: "core.ping", channel: "candor-core:core-ping", result: { pong: "boolean" } },
  // Cold start includes bounded local bundle verification before stdin is read. A verified
  // multi-gigabyte bundle can take longer than the ordinary request budget on Windows.
  { method: "core.version", channel: "candor-core:core-version", timeoutMs: 15_000, result: { version: "string", protocolVersion: "string", schemaVersion: "integer", capabilities: "string-array", build: "object" } },
  { method: "core.capabilities", channel: "candor-core:core-capabilities", result: { transport: "string", maxRpcFrameBytes: "integer", allowedMethods: "string-array", deniedCapabilities: "string-array" } },
  { method: "core.status", channel: "candor-core:core-status", result: { version: "string", protocolVersion: "string", uptimeMs: "integer", networkPolicy: "string", updaterPolicy: "string", vaultState: "string", sidecarTransport: "string", startupRecovery: "object" } },
  { method: "vault.openLocal", channel: "candor-core:vault-open-local", result: { state: "string", backend: "string", encrypted: "boolean", schemaVersion: "integer", rawPathExposed: "boolean" } },
  { method: "vault.status", channel: "candor-core:vault-status", result: { state: "string", backend: "string", encrypted: "boolean", rawPathExposed: "boolean" } },
  { method: "privacy.auditSnapshot", channel: "candor-core:privacy-audit-snapshot", result: { networkPolicy: "string", externalCallsAttempted: "integer", recordedAt: "integer" } },
  { method: "privacy.capabilities", channel: "candor-core:privacy-capabilities", result: { policy: "string", externalCallsAttempted: "integer", capabilities: "array", rawPathExposed: "boolean" } },
  { method: "updates.status", channel: "candor-core:updates-status", result: { implemented: "boolean", policy: "string", backgroundChecks: "boolean", rawPathExposed: "boolean" } },
  { method: "import.v2.status", channel: "candor-core:v2-import-status", result: { implemented: "boolean", localOnly: "boolean", originalsUntouched: "boolean", rawPathExposed: "boolean" } },
  { method: "media.importStatus", channel: "candor-core:media-import-status", result: { implemented: "boolean", supportedContainers: "string-array", nativeImportReady: "string-array", decoderUnavailable: "string-array", pickerOwnedByMainProcess: "boolean", rendererPathAccepted: "boolean", localOnly: "boolean", networkAttempted: "boolean", rawPathExposed: "boolean", keyMaterialExposedToRenderer: "boolean" } },
  { method: "consent.status", channel: "candor-core:consent-status", result: { schemaVersion: "integer", items: "array", readyForMicRecording: "boolean", readyForSystemAudioRecording: "boolean", rawPathExposed: "boolean" } },
  { method: "consent.acknowledge", channel: "candor-core:consent-acknowledge", result: { schemaVersion: "integer", items: "array", readyForMicRecording: "boolean", readyForSystemAudioRecording: "boolean", rawPathExposed: "boolean" } },
  { method: "capture.status", channel: "candor-core:capture-status", result: { implemented: "boolean", active: "boolean", activeSession: "capture-session-or-null", sources: "object", rawPathExposed: "boolean", keyMaterialExposedToRenderer: "boolean" } },
  { method: "capture.devices", channel: "candor-core:capture-devices", result: { defaultInputAvailable: "boolean", defaultOutputAvailable: "boolean", inputs: "array", outputs: "array", rawPathExposed: "boolean", keyMaterialExposedToRenderer: "boolean" }, resultSchema: captureDevicesResultSchema("capture.devices") },
  { method: "capture.preferences", channel: "candor-core:capture-preferences", result: { implemented: "boolean", state: "string", configured: "boolean", preferredMicrophoneId: "string", preferredMicrophone: "object", failureCode: "string-or-null", localOnly: "boolean", rawPathExposed: "boolean", keyMaterialExposedToRenderer: "boolean" }, resultSchema: capturePreferencesResultSchema("capture.preferences") },
  { method: "capture.setPreferredMicrophone", channel: "candor-core:capture-set-preferred-microphone", result: { implemented: "boolean", state: "string", configured: "boolean", preferredMicrophoneId: "string", preferredMicrophone: "object", failureCode: "string-or-null", localOnly: "boolean", rawPathExposed: "boolean", keyMaterialExposedToRenderer: "boolean" }, resultSchema: capturePreferencesResultSchema("capture.setPreferredMicrophone") },
  { method: "capture.micTestStart", channel: "candor-core:capture-mic-test-start", timeoutMs: 15_000, result: { implemented: "boolean", active: "boolean", state: "string", sampleRateHz: "integer", channelCount: "integer", rms: "number", peak: "number", clipping: "boolean", signalDetected: "boolean", durationMs: "integer", maxDurationMs: "integer", ephemeral: "boolean", rawPathExposed: "boolean", keyMaterialExposedToRenderer: "boolean" }, resultSchema: microphoneTestStatusResultSchema("capture.micTestStart") },
  { method: "capture.micTestStatus", channel: "candor-core:capture-mic-test-status", result: { implemented: "boolean", active: "boolean", state: "string", sampleRateHz: "integer", channelCount: "integer", rms: "number", peak: "number", clipping: "boolean", signalDetected: "boolean", durationMs: "integer", maxDurationMs: "integer", ephemeral: "boolean", rawPathExposed: "boolean", keyMaterialExposedToRenderer: "boolean" }, resultSchema: microphoneTestStatusResultSchema("capture.micTestStatus") },
  { method: "capture.micTestSample", channel: "candor-core:capture-mic-test-sample", result: { format: "string", mimeType: "string", sampleRateHz: "integer", channelCount: "integer", bitsPerSample: "integer", sampleCount: "integer", durationMs: "integer", byteCount: "integer", dataBase64: "string", bufferCleared: "boolean", maxDurationMs: "integer", rawPathExposed: "boolean", keyMaterialExposedToRenderer: "boolean" }, resultSchema: microphoneTestSampleResultSchema("capture.micTestSample") },
  { method: "capture.micTestStop", channel: "candor-core:capture-mic-test-stop", timeoutMs: 15_000, result: { implemented: "boolean", active: "boolean", state: "string", bufferCleared: "boolean", sampleRateHz: "integer", channelCount: "integer", maxDurationMs: "integer", rawPathExposed: "boolean", keyMaterialExposedToRenderer: "boolean" }, resultSchema: microphoneTestStopResultSchema("capture.micTestStop") },
  { method: "capture.startMic", channel: "candor-core:capture-start-mic", timeoutMs: 15_000, result: { recording: "object", capture: "object", rawPathExposed: "boolean" } },
  { method: "capture.startSystem", channel: "candor-core:capture-start-system", timeoutMs: 15_000, result: { recording: "object", capture: "object", rawPathExposed: "boolean" } },
  { method: "capture.startMicAndSystem", channel: "candor-core:capture-start-mic-and-system", timeoutMs: 20_000, result: { recording: "object", capture: "object", rawPathExposed: "boolean" } },
  { method: "capture.stop", channel: "candor-core:capture-stop", timeoutMs: 20_000, result: { recording: "object", capture: "object", rawPathExposed: "boolean" } },
  { method: "models.status", channel: "candor-core:models-status", result: { implemented: "boolean", localOnly: "boolean", models: "array", rawPathExposed: "boolean" } },
  { method: "models.listLocal", channel: "candor-core:models-list-local", result: { localOnly: "boolean", installedModelCount: "integer", models: "array", rawPathExposed: "boolean" }, resultSchema: modelsListLocalResultSchema("models.listLocal") },
  { method: "models.verifyLocal", channel: "candor-core:models-verify-local", timeoutMs: 120_000, result: { modelId: "string", installed: "boolean", verified: "boolean", rawPathExposed: "boolean" } },
  { method: "ai.status", channel: "candor-core:ai-status", result: { implemented: "boolean", localOnly: "boolean", engine: "string", rawPathExposed: "boolean" } },
  { method: "ai.bundledAssetsStatus", channel: "candor-core:ai-bundled-assets-status", timeoutMs: 120_000, result: { implemented: "boolean", localOnly: "boolean", cloudAi: "boolean", releaseReady: "boolean", fixture: "boolean", selectionStatus: "string", state: "string", ready: "boolean", repairRequired: "boolean", repairPolicy: "string", repairAction: "string", speech: "object", language: "object", requiredDownload: "boolean", backgroundDownloads: "boolean", runtimePathAcceptedFromRenderer: "boolean", rawPathExposed: "boolean", hashExposed: "boolean", keyMaterialExposedToRenderer: "boolean" } },
  { method: "ai.instructAssetsStatus", channel: "candor-core:ai-instruct-assets-status", result: { implemented: "boolean", localOnly: "boolean", rawPathExposed: "boolean" } },
  { method: "ai.instructStatus", channel: "candor-core:ai-instruct-status", result: { implemented: "boolean", localOnly: "boolean", rawPathExposed: "boolean" } },
  { method: "ai.fallbackPreference.status", channel: "candor-core:ai-fallback-preference-status", result: { implemented: "boolean", state: "string", preference: "string", userAuthorizationRequired: "boolean", automaticFallback: "boolean", fallbackDisabled: "boolean", failureCode: "string-or-null", localOnly: "boolean", cloudAi: "boolean", rawPathExposed: "boolean", keyMaterialExposedToRenderer: "boolean" } },
  { method: "ai.fallbackPreference.update", channel: "candor-core:ai-fallback-preference-update", result: { implemented: "boolean", state: "string", preference: "string", userAuthorizationRequired: "boolean", automaticFallback: "boolean", fallbackDisabled: "boolean", failureCode: "string-or-null", localOnly: "boolean", cloudAi: "boolean", rawPathExposed: "boolean", keyMaterialExposedToRenderer: "boolean" } },
  { method: "ai.schedulerStatus", channel: "candor-core:ai-scheduler-status", result: { implemented: "boolean", active: "boolean", singleLocalModelJob: "boolean", rawPathExposed: "boolean" } },
  { method: "transcription.status", channel: "candor-core:transcription-status", result: { implemented: "boolean", active: "boolean", localOnly: "boolean", engine: "string", rawPathExposed: "boolean" } },
  { method: "transcription.quality.status", channel: "candor-core:transcription-quality-status", result: { implemented: "boolean", state: "string", tier: "string", languagePreference: "string", recommendedTier: "string", benchmarkState: "string", estimatedMinutesPerHour: "integer-or-null", estimatedCompletionAvailable: "boolean", hardware: "object", tiers: "array", localOnly: "boolean", cloudAi: "boolean", rawPathExposed: "boolean" }, resultSchema: transcriptionQualityResultSchema("transcription.quality.status") },
  { method: "transcription.quality.update", channel: "candor-core:transcription-quality-update", result: { implemented: "boolean", state: "string", tier: "string", languagePreference: "string", recommendedTier: "string", benchmarkState: "string", estimatedMinutesPerHour: "integer-or-null", estimatedCompletionAvailable: "boolean", hardware: "object", tiers: "array", localOnly: "boolean", cloudAi: "boolean", rawPathExposed: "boolean" }, resultSchema: transcriptionQualityResultSchema("transcription.quality.update") },
  { method: "liveTranscript.enable", channel: "candor-core:live-transcript-enable", result: {}, resultSchema: liveTranscriptSessionResultSchema("liveTranscript.enable") },
  { method: "liveTranscript.start", channel: "candor-core:live-transcript-start", result: {}, resultSchema: liveTranscriptSessionResultSchema("liveTranscript.start") },
  { method: "liveTranscript.snapshot", channel: "candor-core:live-transcript-snapshot", result: {}, resultSchema: liveTranscriptSnapshotResultSchema("liveTranscript.snapshot") },
  { method: "liveTranscript.clear", channel: "candor-core:live-transcript-clear", result: {}, resultSchema: liveTranscriptClearResultSchema("liveTranscript.clear") },
  { method: "liveTranscript.stop", channel: "candor-core:live-transcript-stop", result: {}, resultSchema: liveTranscriptClearResultSchema("liveTranscript.stop") },
  { method: "liveTranscript.eventsDrain", channel: "candor-core:live-transcript-events-drain", result: {}, resultSchema: liveTranscriptDrainResultSchema("liveTranscript.eventsDrain") },
  { method: "diarization.status", channel: "candor-core:diarization-status", result: {}, resultSchema: diarizationStatusResultSchema("diarization.status") },
  { method: "diarization.updatePreference", channel: "candor-core:diarization-update-preference", result: {}, resultSchema: diarizationStatusResultSchema("diarization.updatePreference") },
  { method: "diarization.speakerNames", channel: "candor-core:diarization-speaker-names", result: {}, resultSchema: speakerNamesResultSchema("diarization.speakerNames") },
  { method: "diarization.assignSpeakerName", channel: "candor-core:diarization-assign-speaker-name", result: {}, resultSchema: speakerNamesResultSchema("diarization.assignSpeakerName") },
  { method: "diarization.removeSpeakerName", channel: "candor-core:diarization-remove-speaker-name", result: {}, resultSchema: speakerNamesResultSchema("diarization.removeSpeakerName", true) },
  { method: "profiles.list", channel: "candor-core:profiles-list", result: { implemented: "boolean", schemaVersion: "integer", profiles: "array", activeProfileId: "string", profileCount: "integer", customProfileLimit: "integer", localOnly: "boolean", networkAttempted: "boolean", rawPathExposed: "boolean", keyMaterialExposedToRenderer: "boolean" }, resultSchema: meetingProfilesListResultSchema("profiles.list") },
  { method: "profiles.get", channel: "candor-core:profiles-get", result: { implemented: "boolean", profile: "object", localOnly: "boolean", networkAttempted: "boolean", rawPathExposed: "boolean", keyMaterialExposedToRenderer: "boolean" }, resultSchema: meetingProfileResultSchema("profiles.get", false) },
  { method: "profiles.upsert", channel: "candor-core:profiles-upsert", result: { implemented: "boolean", profile: "object", localOnly: "boolean", networkAttempted: "boolean", rawPathExposed: "boolean", keyMaterialExposedToRenderer: "boolean" }, resultSchema: meetingProfileResultSchema("profiles.upsert", true) },
  { method: "profiles.delete", channel: "candor-core:profiles-delete", result: { implemented: "boolean", deleted: "boolean", id: "string", localOnly: "boolean", networkAttempted: "boolean", rawPathExposed: "boolean", keyMaterialExposedToRenderer: "boolean" } },
  { method: "profiles.select", channel: "candor-core:profiles-select", result: { implemented: "boolean", activeProfileId: "string", savedLocally: "boolean", localOnly: "boolean", networkAttempted: "boolean", rawPathExposed: "boolean", keyMaterialExposedToRenderer: "boolean" } },
  { method: "replacements.list", channel: "candor-core:replacements-list", result: { implemented: "boolean", schemaVersion: "integer", ruleSets: "array", ruleSetCount: "integer", customRuleSetLimit: "integer", ruleLimitPerSet: "integer", separateFromAsrVocabularyHints: "boolean", asrVocabularyHintsApplied: "boolean", localOnly: "boolean", networkAttempted: "boolean", rawPathExposed: "boolean", keyMaterialExposedToRenderer: "boolean" }, resultSchema: replacementRuleSetsListResultSchema("replacements.list") },
  { method: "replacements.get", channel: "candor-core:replacements-get", result: { implemented: "boolean", ruleSet: "object", separateFromAsrVocabularyHints: "boolean", asrVocabularyHintsApplied: "boolean", localOnly: "boolean", networkAttempted: "boolean", rawPathExposed: "boolean", keyMaterialExposedToRenderer: "boolean" }, resultSchema: replacementRuleSetResultSchema("replacements.get", false) },
  { method: "replacements.upsert", channel: "candor-core:replacements-upsert", result: { implemented: "boolean", ruleSet: "object", separateFromAsrVocabularyHints: "boolean", asrVocabularyHintsApplied: "boolean", localOnly: "boolean", networkAttempted: "boolean", rawPathExposed: "boolean", keyMaterialExposedToRenderer: "boolean" }, resultSchema: replacementRuleSetResultSchema("replacements.upsert", true) },
  { method: "replacements.delete", channel: "candor-core:replacements-delete", result: { implemented: "boolean", deleted: "boolean", id: "string", separateFromAsrVocabularyHints: "boolean", asrVocabularyHintsApplied: "boolean", localOnly: "boolean", networkAttempted: "boolean", rawPathExposed: "boolean", keyMaterialExposedToRenderer: "boolean" } },
  { method: "replacements.preview", channel: "candor-core:replacements-preview", result: { implemented: "boolean", applied: "boolean", changed: "boolean", previewText: "string", previewToken: "string", changes: "array", replacementCount: "integer", protectedTermReviewRequired: "boolean", previewRequiredBeforeApply: "boolean", rulesAreOrdered: "boolean", rendererRegexAccepted: "boolean", separateFromAsrVocabularyHints: "boolean", asrVocabularyHintsApplied: "boolean", localOnly: "boolean", networkAttempted: "boolean", rawPathExposed: "boolean", keyMaterialExposedToRenderer: "boolean" }, resultSchema: replacementPreviewResultSchema("replacements.preview", false) },
  { method: "replacements.apply", channel: "candor-core:replacements-apply", result: { implemented: "boolean", applied: "boolean", changed: "boolean", previewText: "string", previewToken: "string", changes: "array", replacementCount: "integer", protectedTermReviewRequired: "boolean", previewRequiredBeforeApply: "boolean", rulesAreOrdered: "boolean", rendererRegexAccepted: "boolean", separateFromAsrVocabularyHints: "boolean", asrVocabularyHintsApplied: "boolean", localOnly: "boolean", networkAttempted: "boolean", rawPathExposed: "boolean", keyMaterialExposedToRenderer: "boolean" }, resultSchema: replacementPreviewResultSchema("replacements.apply", true) },
  { method: "terminology.status", channel: "candor-core:terminology-status", result: { implemented: "boolean", state: "string", dictionaryCount: "integer", entryCount: "integer", dictionaries: "array", encryptedAtRest: "boolean", projectScopeAvailable: "boolean", promptWritingRequired: "boolean", automaticCorrection: "boolean", localOnly: "boolean", cloudAi: "boolean", rawPathExposed: "boolean" } },
  { method: "terminology.setEnabled", channel: "candor-core:terminology-set-enabled", result: { dictionaryId: "string", enabled: "boolean", savedLocally: "boolean", rawPathExposed: "boolean" } },
  { method: "terminology.assign", channel: "candor-core:terminology-assign", result: { recordingId: "string", dictionaryId: "string", assigned: "boolean", savedLocally: "boolean", rawPathExposed: "boolean" } },
  { method: "terminology.proposals", channel: "candor-core:terminology-proposals", result: { recordingId: "string", proposalCount: "integer", proposals: "array", automaticCorrection: "boolean", approvalRequired: "boolean", rawPathExposed: "boolean" } },
  { method: "terminology.decide", channel: "candor-core:terminology-decide", result: { recordingId: "string", proposalId: "string", decision: "string", savedLocally: "boolean", encryptedAtRest: "boolean", rawPathExposed: "boolean" } },
  { method: "recording.durable.status", channel: "candor-core:recording-durable-status", result: { rootKind: "string", recordingCount: "integer", storageHealth: "object", rawPathExposed: "boolean" } },
  { method: "recording.durable.listPage", channel: "candor-core:recording-durable-list-page", result: { offset: "integer", limit: "integer", totalCount: "integer", hasMore: "boolean", recordings: "array", rawPathExposed: "boolean" } },
  { method: "recording.durable.read", channel: "candor-core:recording-durable-read", result: { summary: "object", chunks: "array", chunkCount: "integer", rawPathExposed: "boolean" } },
  { method: "recording.durable.replayManifest", channel: "candor-core:recording-durable-replay-manifest", result: { recordingId: "string", state: "string", durationMs: "integer", audioChunks: "array", rawPathExposed: "boolean" } },
  { method: "recording.durable.transcriptPage", channel: "candor-core:recording-durable-transcript-page", result: { recordingId: "string", segmentCount: "integer", durationMs: "integer", segments: "array", rawPathExposed: "boolean" } },
  { method: "recording.trustHistory", channel: "candor-core:recording-trust-history", result: { recordingId: "string", currentRevisionId: "string-or-null", currentCleanedRevisionId: "string-or-null", revisionCount: "integer", revisions: "array", receiptCount: "integer", processingReceipts: "array", immutableRevisions: "boolean", originalAudioRetained: "boolean", rawPathExposed: "boolean", keyMaterialExposedToRenderer: "boolean" }, resultSchema: trustHistoryResultSchema("recording.trustHistory") },
  { method: "recording.transcriptRevision", channel: "candor-core:recording-transcript-revision", result: { recordingId: "string", revision: "object", current: "boolean", segmentCount: "integer", returnedSegmentCount: "integer", hasMore: "boolean", segments: "array", comparisonView: "object", rawPathExposed: "boolean", keyMaterialExposedToRenderer: "boolean" }, resultSchema: transcriptRevisionResultSchema("recording.transcriptRevision") },
  { method: "recording.selectTranscriptRevision", channel: "candor-core:recording-select-transcript-revision", result: { recordingId: "string", currentRevisionId: "string", currentVersion: "integer", olderRevisionsRetained: "integer", rawPathExposed: "boolean", keyMaterialExposedToRenderer: "boolean" } },
  { method: "transcription.prepareReprocess", channel: "candor-core:transcription-prepare-reprocess", timeoutMs: 15_000, result: { recordingId: "string", channel: "string", inputKind: "string", audioChunkIndices: "array", audioChunkCount: "integer", sourceAudioSha256: "string-or-null", sourceAudioIntegrity: "string", sampleRateHz: "integer", channelCount: "integer", bitsPerSample: "integer", durationMs: "integer", currentRevisionId: "string-or-null", revisionCount: "integer", dispatchInput: "object", originalAudioModified: "boolean", rawPathExposed: "boolean", keyMaterialExposedToRenderer: "boolean" }, resultSchema: transcriptionPrepareReprocessResultSchema("transcription.prepareReprocess") },
  { method: "transcription.protectedTermReview", channel: "candor-core:transcription-protected-term-review", result: {}, resultSchema: protectedTermReviewResultSchema("transcription.protectedTermReview") },
  { method: "transcription.applyProtectedTermReview", channel: "candor-core:transcription-apply-protected-term-review", timeoutMs: 15_000, result: {}, resultSchema: protectedTermApplyResultSchema("transcription.applyProtectedTermReview") },
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
  { method: "media.validateLocalSourcePath", timeoutMs: 5_000, result: { schemaVersion: "integer", eligible: "boolean", sourceSizeBytes: "integer", localStorageVerified: "boolean", regularFile: "boolean", reparsePoint: "boolean", cloudPlaceholder: "boolean", localOnly: "boolean", networkAttempted: "boolean", rawPathExposed: "boolean", keyMaterialExposedToRenderer: "boolean" }, resultSchema: mediaLocalSourceValidationResultSchema("media.validateLocalSourcePath") },
  { method: "media.importFromPath", timeoutMs: 10_000, mode: "job", result: { jobId: "string", type: "string", state: "string", createdAt: "string", rawPathExposed: "boolean", keyMaterialExposedToRenderer: "boolean" } },
  { method: "recording.durable.recover", timeoutMs: 30_000, result: { rootKind: "string", recoveredRecordings: "array", recoveredCount: "integer", quarantinedRecordings: "array", quarantinedCount: "integer", completedDeletionCount: "integer", pendingDeletionCount: "integer", vaultIndex: "object", rawPathExposed: "boolean" } },
  { method: "jobs.list", result: { jobs: "array", jobCount: "integer", activeCount: "integer", persistenceState: "string", encryptedAtRest: "boolean", recordingPriorityActive: "boolean", rawPathExposed: "boolean" } },
  { method: "jobs.activeSummary", result: { activeCount: "integer", jobs: "array", rawPathExposed: "boolean" } },
  { method: "jobs.get", result: { jobId: "string", type: "string", state: "string", createdAt: "string", updatedAt: "string", terminal: "boolean", rawPathExposed: "boolean" } },
  { method: "jobs.cancel", result: { jobId: "string", state: "string", cancelRequested: "boolean", terminal: "boolean", rawPathExposed: "boolean" } },
  { method: "jobs.cancelAll", result: { cancelRequestedCount: "integer", requestedCount: "integer", skippedCount: "integer", rawPathExposed: "boolean" } },
  { method: "jobs.pauseAll", result: { pausedCount: "integer", restartOnNextLaunch: "boolean", rawPathExposed: "boolean" } },
  { method: "jobs.retry", result: { jobId: "string", type: "string", state: "string", createdAt: "string", rawPathExposed: "boolean" } },
  { method: "jobs.acknowledge", result: { jobId: "string", acknowledged: "boolean", rawPathExposed: "boolean" } },
  { method: "transcription.quality.benchmark.start", timeoutMs: 10_000, mode: "job", result: { jobId: "string", type: "string", state: "string", createdAt: "string", rawPathExposed: "boolean" } },
  { method: "transcription.start", timeoutMs: 10_000, mode: "job", result: { jobId: "string", type: "string", state: "string", createdAt: "string", rawPathExposed: "boolean" } },
  { method: "ai.ask.start", timeoutMs: 10_000, mode: "job", result: { jobId: "string", type: "string", state: "string", createdAt: "string", rawPathExposed: "boolean" } },
  { method: "ai.cleanup.start", timeoutMs: 10_000, mode: "job", result: { jobId: "string", type: "string", state: "string", createdAt: "string", rawPathExposed: "boolean" } },
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
    resultSchema: config.resultSchema
      ?? jsonObjectResultSchema(config.method, config.result, scope === "renderer"),
    timeoutMs: config.timeoutMs ?? 5_000,
    requiresHandshake: config.method !== "core.version",
    mode: config.mode ?? "request",
    scope,
    ...(scope === "renderer" && EXACT_RENDERER_RESULT_METHODS.has(config.method)
      ? { rendererResultFields: Object.freeze(Object.keys(config.result)) }
      : {}),
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

interface CompletedJobResultDefinition {
  readonly schema: JsonRuntimeSchema;
  readonly fields: readonly string[];
}

function canonicalProfileBinding(value: JsonValue, method: string): JsonValue {
  if (value === null) return null;
  const profile = objectResult(value, method, "processingProfile");
  const safeId = /^[a-z][a-z0-9-]{0,63}$/;
  const schemaVersion = profile.schemaVersion;
  if (
    (schemaVersion !== 1 && schemaVersion !== 2)
    || typeof profile.profileId !== "string"
    || !safeId.test(profile.profileId)
    || typeof profile.profileVersion !== "number"
    || !Number.isSafeInteger(profile.profileVersion)
    || profile.profileVersion < 1
    || typeof profile.modelId !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profile.modelId)
    || (schemaVersion === 2 && profile.speechModelId !== profile.modelId)
    || (schemaVersion === 2
      && !new Set(["small.en", "small", "large-v3-turbo", "large-v3"]).has(profile.speechModelId as string))
    || (schemaVersion === 2
      && profile.cleanupModelId !== null
      && profile.cleanupModelId !== "qwen3-4b-official-q4_k_m")
    || (schemaVersion === 2
      && profile.summaryModelId !== null
      && profile.summaryModelId !== "qwen3-4b-official-q4_k_m")
    || typeof profile.language !== "string"
    || profile.language.length > 35
    || typeof profile.transcriptionLanguage !== "string"
    || !/^(?:auto|[a-z]{2,3})$/.test(profile.transcriptionLanguage)
    || !Array.isArray(profile.dictionaryIds)
    || profile.dictionaryIds.length > 16
    || profile.dictionaryIds.some((id) => typeof id !== "string" || !safeId.test(id))
    || (profile.replacementRuleSetId !== null
      && (typeof profile.replacementRuleSetId !== "string" || !safeId.test(profile.replacementRuleSetId)))
    || (profile.replacementRuleSetVersion !== null
      && (typeof profile.replacementRuleSetVersion !== "number"
        || !Number.isSafeInteger(profile.replacementRuleSetVersion)
        || profile.replacementRuleSetVersion < 1))
    || profile.immutableAtCaptureStart !== true
    || profile.rawPathExposed !== false
  ) {
    return invalidResult(method, "processingProfile");
  }
  return canonicalResult(profile, [
    "schemaVersion", "profileId", "profileVersion", "modelId", "language", "transcriptionLanguage", "dictionaryIds",
    "speechModelId", "cleanupModelId", "summaryModelId", "replacementRuleSetId", "replacementRuleSetVersion",
    "immutableAtCaptureStart", "rawPathExposed",
  ]);
}

function canonicalReplacementChanges(value: JsonValue, method: string, field: string, protectedTerm: boolean): JsonValue[] {
  if (!Array.isArray(value) || value.length > 64) return invalidResult(method, field);
  return value.map((candidate, index) => {
    const change = objectResult(candidate, method, `${field}[${index}]`);
    if (
      typeof change.ruleId !== "string"
      || !/^[a-z][a-z0-9-]{0,63}$/.test(change.ruleId)
      || typeof change.ruleOrder !== "number"
      || !Number.isSafeInteger(change.ruleOrder)
      || change.ruleOrder < 0
      || change.ruleOrder > 10_000
      || typeof change.replacementCount !== "number"
      || !Number.isSafeInteger(change.replacementCount)
      || change.replacementCount < 1
      || change.protectedTermReview !== protectedTerm
    ) return invalidResult(method, `${field}[${index}]`);
    return canonicalResult(change, ["ruleId", "ruleOrder", "replacementCount", "protectedTermReview"]);
  });
}

function canonicalTranscriptNormalization(value: JsonValue, method: string): JsonValue {
  if (value === null) return null;
  const normalization = objectResult(value, method, "normalization");
  const automaticChanges = canonicalReplacementChanges(
    normalization.automaticChanges,
    method,
    "normalization.automaticChanges",
    false,
  );
  const protectedTermMatches = canonicalReplacementChanges(
    normalization.protectedTermMatches,
    method,
    "normalization.protectedTermMatches",
    true,
  );
  if (
    (normalization.ruleSetId !== null
      && (typeof normalization.ruleSetId !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(normalization.ruleSetId)))
    || (normalization.ruleSetVersion !== null
      && (typeof normalization.ruleSetVersion !== "number"
        || !Number.isSafeInteger(normalization.ruleSetVersion)
        || normalization.ruleSetVersion < 1))
    || typeof normalization.automaticReplacementCount !== "number"
    || !Number.isSafeInteger(normalization.automaticReplacementCount)
    || normalization.automaticReplacementCount < 0
    || normalization.protectedTermReviewRequired !== (protectedTermMatches.length > 0)
    || normalization.protectedTermsAutoReplaced !== false
    || normalization.rulesAppliedInDeterministicOrder !== true
  ) return invalidResult(method, "normalization");
  return {
    ruleSetId: normalization.ruleSetId,
    ruleSetVersion: normalization.ruleSetVersion,
    automaticReplacementCount: normalization.automaticReplacementCount,
    automaticChanges,
    protectedTermReviewRequired: normalization.protectedTermReviewRequired,
    protectedTermMatches,
    protectedTermsAutoReplaced: false,
    rulesAppliedInDeterministicOrder: true,
  };
}

function completedTranscriptionResultSchema(): JsonRuntimeSchema {
  const outer = jsonObjectResultSchema("transcription job", {
    recordingId: "string",
    engine: "string",
    segmentCount: "integer",
    rawPathExposed: "boolean",
  });
  return createRuntimeSchema("transcription job.result", (value) => {
    const result = objectResult(outer.parse(value), "transcription job", "result");
    return {
      ...result,
      ...(result.processingProfile !== undefined
        ? { processingProfile: canonicalProfileBinding(result.processingProfile, "transcription job") }
        : {}),
      ...(result.normalization !== undefined
        ? { normalization: canonicalTranscriptNormalization(result.normalization, "transcription job") }
        : {}),
    };
  });
}

function completedCleanupResultSchema(): JsonRuntimeSchema {
  const outer = jsonObjectResultSchema("transcript cleanup job", {
    recordingId: "string",
    localOnly: "boolean",
    rawPathExposed: "boolean",
    keyMaterialExposedToRenderer: "boolean",
  });
  return createRuntimeSchema("transcript cleanup job.result", (value) => {
    const result = objectResult(outer.parse(value), "transcript cleanup job", "result");
    if (
      result.localOnly !== true
      || result.rawPathExposed !== false
      || result.keyMaterialExposedToRenderer !== false
    ) invalidResult("transcript cleanup job", "local custody");
    const fallback = result.fallbackApplied === true;
    if (fallback) {
      if (
        result.cleaned !== false
        || !new Set(["raw-asr", "normalized", "legacy"]).has(result.fallbackInputKind as string)
        || typeof result.failureCode !== "string"
        || !stableProcessingCode.test(result.failureCode)
      ) invalidResult("transcript cleanup job", "fallback result");
    } else if (
      typeof result.revisionId !== "string"
      || typeof result.parentRevisionId !== "string"
      || result.kind !== "ai-cleaned"
      || result.source !== "ai-cleanup"
      || result.current !== false
      || result.currentCleaned !== true
      || result.validationResult !== "passed"
      || typeof result.segmentCount !== "number"
      || result.segmentCount < 1
    ) {
      invalidResult("transcript cleanup job", "validated cleanup result");
    }
    return result;
  });
}

const localAiResultFields = [
  "recordingId", "label", "question", "answer", "answerFound", "intent", "engine", "mode",
  "inputRevisionId", "inputRevisionKind", "cleanupFallbackApplied",
  "localOnly", "cloudAi", "modelRequired", "segmentCount", "matchedSegmentCount", "summary",
  "decisions", "actions", "risks", "questions", "citations", "recapMarkdown", "output", "sourceIds",
  "outputSchemaVersion", "strictOutputValidated", "groundingMethod", "modelOutputGrounded",
  "citationsAddedByCore", "unsupportedClaimsRemoved", "rawPathExposed", "keyMaterialExposedToRenderer",
  "provenance",
] as const;

const completedJobResultDefinitions: ReadonlyMap<string, CompletedJobResultDefinition> = new Map([
  ["transcription", {
    schema: completedTranscriptionResultSchema(),
    fields: [
      "recordingId", "engine", "segmentCount", "modelId", "language", "processingProfile",
      "normalization", "revisionId", "receiptId", "rawPathExposed",
    ],
  }],
  ["transcript-cleanup", {
    schema: completedCleanupResultSchema(),
    fields: [
      "recordingId", "revisionId", "parentRevisionId", "version", "receiptId", "source", "kind",
      "current", "currentCleaned", "segmentCount", "validationResult", "promptVersion", "cleaned",
      "fallbackApplied", "fallbackInputKind", "failureCode", "reused", "localOnly", "rawPathExposed",
      "keyMaterialExposedToRenderer",
    ],
  }],
  ["recap", { schema: strictLocalAiResultSchema("recap job", "recap", true), fields: localAiResultFields }],
  ["ask", { schema: strictLocalAiResultSchema("ask job", "ask", true), fields: localAiResultFields }],
  ["export", {
    schema: jsonObjectResultSchema("export job", { format: "string", fileName: "string", bytes: "integer", rawPathExposed: "boolean" }),
    fields: [
      "format", "mimeType", "fileName", "bytes", "dataBase64", "markdown", "pageCount", "warningCount",
      "structuredReport", "editable", "searchableText", "bookmarks", "generatedLocally", "channel",
      "sampleRateHz", "channelCount", "bitsPerSample", "durationMs", "localOnly", "cloudAi",
      "networkAttempted", "downloadsAttempted", "rawPathExposed", "keyMaterialExposedToRenderer",
    ],
  }],
  ["legacy-import", {
    schema: jsonObjectResultSchema("legacy import job", { importedCount: "integer", skippedCount: "integer", originalsUntouched: "boolean", rawPathExposed: "boolean" }),
    fields: [
      "importedCount", "skippedCount", "audioImportedCount", "audioSkippedCount", "originalsUntouched",
      "localOnly", "cloudAi", "rawPathExposed", "keyMaterialExposedToRenderer",
    ],
  }],
  ["speech-model-verification", {
    schema: jsonObjectResultSchema("speech model verification job", { modelId: "string", installed: "boolean", verified: "boolean", rawPathExposed: "boolean" }),
    fields: ["modelId", "installed", "verified", "failureCode", "rawPathExposed"],
  }],
  ["speech-model-import", {
    schema: jsonObjectResultSchema("speech model import job", { importId: "string", modelId: "string", imported: "boolean", rejected: "boolean", rawPathExposed: "boolean" }),
    fields: ["importId", "modelId", "imported", "rejected", "failureCode", "rawPathExposed"],
  }],
  ["local-ai-component-import", {
    schema: jsonObjectResultSchema("local AI component import job", { assetKind: "string", imported: "boolean", integrityVerified: "boolean", rawPathExposed: "boolean" }),
    fields: ["assetKind", "imported", "integrityVerified", "rawPathExposed"],
  }],
  ["local-ai-benchmark", {
    schema: jsonObjectResultSchema("local AI benchmark job", { benchmarkState: "string", tier: "string", passed: "boolean", whisperMeasured: "boolean", localLlmMeasured: "boolean", localOnly: "boolean", cloudAi: "boolean", rawModelNamesExposed: "boolean", rawHashExposed: "boolean", rawMetricExposed: "boolean", rawPathExposed: "boolean" }),
    fields: [
      "benchmarkState", "tier", "passed", "whisperMeasured", "localLlmMeasured", "localOnly", "cloudAi",
      "rawModelNamesExposed", "rawHashExposed", "rawMetricExposed", "rawPathExposed", "keyMaterialExposedToRenderer",
    ],
  }],
  ["dictionary-import", {
    schema: jsonObjectResultSchema("dictionary import job", { imported: "boolean", dictionaryId: "string", name: "string", entryCount: "integer", enabled: "boolean", trustLabel: "string", scope: "string", encryptedAtRest: "boolean", localOnly: "boolean", rawPathExposed: "boolean", keyMaterialExposedToRenderer: "boolean" }),
    fields: [
      "imported", "dictionaryId", "name", "entryCount", "enabled", "trustLabel", "scope",
      "encryptedAtRest", "localOnly", "rawPathExposed", "keyMaterialExposedToRenderer",
    ],
  }],
  ["dictionary-index", {
    schema: jsonObjectResultSchema("dictionary index job", { state: "string", dictionaryCount: "integer", entryCount: "integer", indexedDictionaryId: "string", encryptedAtRest: "boolean", localOnly: "boolean", rawPathExposed: "boolean", keyMaterialExposedToRenderer: "boolean" }),
    fields: [
      "state", "dictionaryCount", "entryCount", "indexedDictionaryId", "encryptedAtRest", "localOnly",
      "rawPathExposed", "keyMaterialExposedToRenderer",
    ],
  }],
  ["media-import", {
    schema: jsonObjectResultSchema("media import job", {
      schemaVersion: "integer",
      displayName: "string",
      mediaKind: "string",
      status: "string",
      imported: "boolean",
      recordingId: "string-or-null",
      sourceSizeBytes: "integer",
      importedPcmBytes: "integer",
      durationMs: "integer-or-null",
      sampleRateHz: "integer-or-null",
      channelCount: "integer-or-null",
      bitsPerSample: "integer-or-null",
      durableChunkCount: "integer",
      originalAudioRetained: "boolean",
      containerMetadataPreserved: "boolean",
      sourceModified: "boolean",
      decoderExecutionAttempted: "boolean",
      localOnly: "boolean",
      networkAttempted: "boolean",
      rawPathExposed: "boolean",
      keyMaterialExposedToRenderer: "boolean",
    }),
    fields: [
      "schemaVersion", "displayName", "mediaKind", "status", "imported", "recordingId",
      "sourceSizeBytes", "importedPcmBytes", "durationMs", "sampleRateHz", "channelCount",
      "bitsPerSample", "durableChunkCount", "originalAudioRetained", "containerMetadataPreserved",
      "sourceModified", "decoderExecutionAttempted", "localOnly", "networkAttempted",
      "rawPathExposed", "keyMaterialExposedToRenderer",
    ],
  }],
]);

const forbiddenCompletedResultKeys = new Set([
  "archiveBase64",
  "keyMaterial",
  "licenseToken",
  "modelPath",
  "path",
  "privateKey",
  "prompt",
  "rawPrompt",
  "runnerPath",
  "secret",
  "sourcePath",
  "systemPrompt",
  "transcript",
]);

function rejectSensitiveResultKeys(value: JsonValue): void {
  if (Array.isArray(value)) {
    for (const item of value) rejectSensitiveResultKeys(item);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (forbiddenCompletedResultKeys.has(key)) {
      throw new Error(`Completed job result included forbidden ${key} data`);
    }
    rejectSensitiveResultKeys(nested);
  }
}

function canonicalResult(value: JsonValue, fields: readonly string[]): JsonValue {
  const source = value as Record<string, JsonValue>;
  return Object.fromEntries(fields.filter((field) => field in source).map((field) => [field, source[field]]));
}

function requireCompletedResultValue(
  type: string,
  result: Record<string, JsonValue>,
  field: string,
  expected: JsonValue,
): void {
  if (result[field] !== expected) invalidResult(`${type} job`, field);
}

function requireOptionalCompletedResultValue(
  type: string,
  result: Record<string, JsonValue>,
  field: string,
  expected: JsonValue,
): void {
  if (field in result && result[field] !== expected) invalidResult(`${type} job`, field);
}

function validateCompletedResultSemantics(type: string, value: JsonValue): void {
  const result = objectResult(value, `${type} job`, "result");
  requireCompletedResultValue(type, result, "rawPathExposed", false);
  requireOptionalCompletedResultValue(type, result, "keyMaterialExposedToRenderer", false);
  requireOptionalCompletedResultValue(type, result, "localOnly", true);
  requireOptionalCompletedResultValue(type, result, "cloudAi", false);
  requireOptionalCompletedResultValue(type, result, "generatedLocally", true);
  requireOptionalCompletedResultValue(type, result, "networkAttempted", false);
  requireOptionalCompletedResultValue(type, result, "downloadsAttempted", false);
  requireOptionalCompletedResultValue(type, result, "rawModelNamesExposed", false);
  requireOptionalCompletedResultValue(type, result, "rawHashExposed", false);
  requireOptionalCompletedResultValue(type, result, "rawMetricExposed", false);

  if (type === "transcription") {
    if (result.engine !== "whisper-rs" || (result.segmentCount as number) < 0) {
      invalidResult(`${type} job`, "local transcription result");
    }
    return;
  }

  if (type === "export") {
    if (
      !new Set(["markdown", "docx", "pdf", "wav"]).has(result.format as string)
      || (result.bytes as number) <= 0
      || typeof result.fileName !== "string"
      || result.fileName.length === 0
      || result.fileName.includes("/")
      || result.fileName.includes("\\")
    ) {
      invalidResult(`${type} job`, "local export result");
    }
    return;
  }

  if (type === "legacy-import") {
    requireCompletedResultValue(type, result, "originalsUntouched", true);
    return;
  }

  if (type === "local-ai-benchmark") {
    if (
      result.benchmarkState !== "measured"
      || (result.tier !== "balanced" && result.tier !== "maximum")
    ) {
      invalidResult(`${type} job`, "benchmark result");
    }
    return;
  }

  if (type === "dictionary-import") {
    if (
      result.encryptedAtRest !== true
      || (result.trustLabel !== "verified-candor" && result.trustLabel !== "community-unverified")
      || !new Set(["meeting", "organization", "personal", "specialist", "general"]).has(result.scope as string)
      || (result.entryCount as number) < 0
    ) {
      invalidResult(`${type} job`, "dictionary trust result");
    }
    return;
  }

  if (type === "dictionary-index" && (
    result.state !== "ready"
    || result.encryptedAtRest !== true
    || (result.dictionaryCount as number) < 0
    || (result.entryCount as number) < 0
  )) {
    invalidResult(`${type} job`, "dictionary index result");
  }

  if (type === "media-import" && (
    result.imported !== true
    || result.status !== "ready"
    || typeof result.recordingId !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(result.recordingId)
    || result.sourceModified !== false
    || (result.importedPcmBytes as number) <= 0
    || (result.durableChunkCount as number) <= 0
    || result.bitsPerSample !== 16
  )) {
    invalidResult(`${type} job`, "local media import result");
  }
}

export function validateCompletedJobResult(value: JsonValue): JsonValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const job = value as Record<string, JsonValue>;
  if (job.state !== "completed") return value;
  if (typeof job.type !== "string") throw new Error("Completed job omitted its type");
  const definition = completedJobResultDefinitions.get(job.type);
  if (!definition) throw new Error(`Completed job type is not registered: ${job.type}`);
  const result = definition.schema.parse(job.result);
  rejectSensitiveResultKeys(result);
  validateCompletedResultSemantics(job.type, result);
  return { ...job, result: canonicalResult(result, definition.fields) };
}
