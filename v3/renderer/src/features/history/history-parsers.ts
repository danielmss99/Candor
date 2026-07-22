import type {
  ProcessingReceipt,
  ProtectedTermChange,
  ProtectedTermPreviewSegment,
  ProtectedTermReview,
  TranscriptComparison,
  TranscriptComparisonView,
  TranscriptRevision,
  TranscriptRevisionDetail,
  TranscriptSegment,
  TrustHistory,
} from "./types";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function string(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function comparison(value: unknown): TranscriptComparison | null {
  const item = record(value);
  if (!item) return null;
  return {
    rawTextSha256: string(item.rawTextSha256),
    normalizedTextSha256: string(item.normalizedTextSha256),
    rawTextBytes: nonNegativeNumber(item.rawTextBytes),
    normalizedTextBytes: nonNegativeNumber(item.normalizedTextBytes),
    rawSegmentCount: nonNegativeNumber(item.rawSegmentCount),
    normalizedSegmentCount: nonNegativeNumber(item.normalizedSegmentCount),
    changed: item.changed === true,
  };
}

function revision(value: unknown): TranscriptRevision | null {
  const item = record(value);
  const revisionId = string(item?.revisionId);
  if (!item || !revisionId) return null;
  const source = item.source === "initial" || item.source === "reprocess" || item.source === "import" || item.source === "review" || item.source === "ai-cleanup"
    ? item.source
    : "unknown";
  const kind = item.kind === "raw-asr" || item.kind === "normalized" || item.kind === "ai-cleaned" || item.kind === "legacy"
    ? item.kind
    : "unknown";
  return {
    revisionId,
    version: nonNegativeNumber(item.version),
    source,
    kind,
    parentRevisionId: nullableString(item.parentRevisionId),
    engine: string(item.engine, "Not reported"),
    modelId: nullableString(item.modelId),
    modelSha256: nullableString(item.modelSha256),
    createdAtMs: nonNegativeNumber(item.createdAtMs),
    comparison: comparison(item.comparison),
    rawComparisonAvailable: item.rawComparisonAvailable === true,
  };
}

function protectedTermChange(value: unknown): ProtectedTermChange | null {
  const item = record(value);
  if (
    !item
    || typeof item.ruleId !== "string"
    || typeof item.ruleOrder !== "number"
    || !Number.isSafeInteger(item.ruleOrder)
    || typeof item.replacementCount !== "number"
    || !Number.isSafeInteger(item.replacementCount)
    || item.replacementCount < 1
    || item.protectedTermReview !== true
  ) return null;
  return {
    ruleId: item.ruleId,
    ruleOrder: item.ruleOrder,
    replacementCount: item.replacementCount,
  };
}

function protectedTermPreviewSegment(value: unknown): ProtectedTermPreviewSegment | null {
  const item = record(value);
  if (
    !item
    || typeof item.channel !== "string"
    || (item.speaker !== null && typeof item.speaker !== "string")
    || typeof item.startMs !== "number"
    || !Number.isSafeInteger(item.startMs)
    || item.startMs < 0
    || typeof item.durationMs !== "number"
    || !Number.isSafeInteger(item.durationMs)
    || item.durationMs < 0
    || typeof item.before !== "string"
    || typeof item.after !== "string"
    || item.before === item.after
    || typeof item.beforeTruncated !== "boolean"
    || typeof item.afterTruncated !== "boolean"
  ) return null;
  return {
    channel: item.channel,
    speaker: item.speaker,
    startMs: item.startMs,
    durationMs: item.durationMs,
    before: item.before,
    after: item.after,
    beforeTruncated: item.beforeTruncated,
    afterTruncated: item.afterTruncated,
  };
}

export function parseProtectedTermReview(value: unknown): ProtectedTermReview | null {
  const item = record(value);
  if (!item || typeof item.recordingId !== "string" || typeof item.reviewRequired !== "boolean") return null;
  const changes = Array.isArray(item.changes)
    ? item.changes.map(protectedTermChange).filter((entry): entry is ProtectedTermChange => entry !== null).slice(0, 64)
    : [];
  const previewSegments = Array.isArray(item.previewSegments)
    ? item.previewSegments.map(protectedTermPreviewSegment).filter((entry): entry is ProtectedTermPreviewSegment => entry !== null).slice(0, 64)
    : [];
  const replacementCount = nonNegativeNumber(item.replacementCount);
  const changedSegmentCount = nonNegativeNumber(item.changedSegmentCount);
  const revisionId = nullableString(item.revisionId);
  const ruleSetId = nullableString(item.ruleSetId);
  const previewToken = nullableString(item.previewToken);
  if (
    item.implemented !== true
    || item.durableApplyCreatesRevision !== true
    || item.rendererSuppliedTranscriptAccepted !== false
    || item.captureTimeRuleSnapshotUsed !== true
    || item.localOnly !== true
    || item.networkAttempted !== false
    || item.rawPathExposed !== false
    || item.keyMaterialExposedToRenderer !== false
    || typeof item.previewTruncated !== "boolean"
    || (item.reviewRequired && (!revisionId || !ruleSetId || !previewToken || previewSegments.length === 0))
    || (!item.reviewRequired && (previewToken !== null || previewSegments.length !== 0))
  ) return null;
  return {
    recordingId: item.recordingId,
    revisionId,
    ruleSetId,
    ruleSetVersion: typeof item.ruleSetVersion === "number" && Number.isSafeInteger(item.ruleSetVersion)
      ? item.ruleSetVersion
      : null,
    reviewRequired: item.reviewRequired,
    replacementCount,
    changes,
    changedSegmentCount,
    previewSegments,
    previewTruncated: item.previewTruncated,
    previewToken,
  };
}

function receipt(value: unknown): ProcessingReceipt | null {
  const item = record(value);
  const receiptId = string(item?.receiptId);
  if (!item || !receiptId) return null;
  const outcome = item.outcome === "succeeded" || item.outcome === "failed" || item.outcome === "cancelled"
    ? item.outcome
    : "unknown";
  const stage = item.stage === "transcription" || item.stage === "normalization" || item.stage === "cleanup" || item.stage === "recap"
    ? item.stage
    : "unknown";
  const inputRevisionKind = item.inputRevisionKind === "raw-asr" || item.inputRevisionKind === "normalized" || item.inputRevisionKind === "ai-cleaned" || item.inputRevisionKind === "legacy"
    ? item.inputRevisionKind
    : null;
  const validationResult = item.validationResult === "passed" || item.validationResult === "failed" || item.validationResult === "not-applicable"
    ? item.validationResult
    : "unknown";
  return {
    receiptId,
    attempt: nonNegativeNumber(item.attempt),
    operation: string(item.operation, "Not reported"),
    stage,
    outcome,
    engine: string(item.engine, "Not reported"),
    modelId: nullableString(item.modelId),
    modelSha256: nullableString(item.modelSha256),
    revisionId: nullableString(item.revisionId),
    inputRevisionId: nullableString(item.inputRevisionId),
    inputRevisionKind,
    promptTemplateSha256: nullableString(item.promptTemplateSha256),
    validationResult,
    fallbackApplied: item.fallbackApplied === true,
    errorCode: nullableString(item.errorCode),
    errorSummary: nullableString(item.errorSummary),
    startedAtMs: nonNegativeNumber(item.startedAtMs),
    finishedAtMs: nonNegativeNumber(item.finishedAtMs),
    elapsedMs: nonNegativeNumber(item.elapsedMs),
    comparison: comparison(item.comparison),
  };
}

export function parseTrustHistory(value: unknown): TrustHistory | null {
  const item = record(value);
  const recordingId = string(item?.recordingId);
  if (!item || !recordingId) return null;
  const revisions = Array.isArray(item.revisions)
    ? item.revisions.map(revision).filter((entry): entry is TranscriptRevision => entry !== null).slice(0, 512)
    : [];
  const processingReceipts = Array.isArray(item.processingReceipts)
    ? item.processingReceipts.map(receipt).filter((entry): entry is ProcessingReceipt => entry !== null).slice(0, 2_048)
    : [];
  return {
    recordingId,
    currentRevisionId: nullableString(item.currentRevisionId),
    currentCleanedRevisionId: nullableString(item.currentCleanedRevisionId),
    revisions,
    processingReceipts,
    immutableRevisions: item.immutableRevisions === true,
    originalAudioRetained: item.originalAudioRetained === true,
  };
}

function segment(value: unknown): TranscriptSegment | null {
  const item = record(value);
  if (!item || typeof item.text !== "string") return null;
  return {
    startMs: typeof item.startMs === "number" && Number.isFinite(item.startMs) ? Math.max(0, item.startMs) : null,
    endMs: typeof item.endMs === "number" && Number.isFinite(item.endMs) ? Math.max(0, item.endMs) : null,
    speaker: nullableString(item.speaker),
    text: item.text,
  };
}

const MAX_COMPARISON_TEXT_BYTES = 64 * 1024;

function comparisonView(value: unknown): TranscriptComparisonView | null {
  const item = record(value);
  if (
    !item
    || typeof item.available !== "boolean"
    || item.maxTextBytesPerSide !== MAX_COMPARISON_TEXT_BYTES
    || item.rawPathExposed !== false
    || item.keyMaterialExposedToRenderer !== false
  ) return null;
  if (!item.available) {
    if (item.reason !== "legacy-revision" || item.encryptedAtRest !== false) return null;
    return {
      available: false,
      rawText: null,
      normalizedText: null,
      rawTextTruncated: false,
      normalizedTextTruncated: false,
      maxTextBytesPerSide: MAX_COMPARISON_TEXT_BYTES,
      encryptedAtRest: false,
      reason: "legacy-revision",
    };
  }
  if (
    typeof item.rawText !== "string"
    || typeof item.normalizedText !== "string"
    || new TextEncoder().encode(item.rawText).byteLength > MAX_COMPARISON_TEXT_BYTES
    || new TextEncoder().encode(item.normalizedText).byteLength > MAX_COMPARISON_TEXT_BYTES
    || typeof item.rawTextTruncated !== "boolean"
    || typeof item.normalizedTextTruncated !== "boolean"
    || item.encryptedAtRest !== true
  ) return null;
  return {
    available: true,
    rawText: item.rawText,
    normalizedText: item.normalizedText,
    rawTextTruncated: item.rawTextTruncated,
    normalizedTextTruncated: item.normalizedTextTruncated,
    maxTextBytesPerSide: MAX_COMPARISON_TEXT_BYTES,
    encryptedAtRest: true,
    reason: null,
  };
}

export function parseTranscriptRevisionDetail(value: unknown): TranscriptRevisionDetail | null {
  const item = record(value);
  const parsedRevision = revision(item?.revision);
  const recordingId = string(item?.recordingId);
  const parsedComparisonView = comparisonView(item?.comparisonView);
  if (!item || !recordingId || !parsedRevision || !parsedComparisonView) return null;
  const segmentCount = nonNegativeNumber(item.segmentCount);
  const returnedSegmentCount = nonNegativeNumber(item.returnedSegmentCount);
  const segments = Array.isArray(item.segments)
    ? item.segments.map(segment).filter((entry): entry is TranscriptSegment => entry !== null).slice(0, 500)
    : [];
  if (
    returnedSegmentCount !== segments.length
    || returnedSegmentCount > segmentCount
    || item.hasMore !== (returnedSegmentCount < segmentCount)
  ) return null;
  return {
    recordingId,
    revision: parsedRevision,
    current: item.current === true,
    currentCleaned: item.currentCleaned === true,
    segmentCount,
    returnedSegmentCount,
    hasMore: item.hasMore,
    segments,
    comparisonView: parsedComparisonView,
  };
}
