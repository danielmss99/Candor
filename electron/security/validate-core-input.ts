import type { JsonValue } from "../core/json.js";
import { INPUT_LIMITS, validModelId, validRecordingId } from "./input-limits.js";

const noParameterMethods = new Set([
  "core.version",
  "core.ping",
  "core.capabilities",
  "core.status",
  "vault.openLocal",
  "vault.status",
  "privacy.auditSnapshot",
  "privacy.capabilities",
  "updates.status",
  "import.v2.status",
  "consent.status",
  "capture.status",
  "capture.devices",
  "capture.stop",
  "models.status",
  "models.listLocal",
  "ai.status",
  "ai.bundledAssetsStatus",
  "ai.instructAssetsStatus",
  "ai.instructStatus",
  "ai.schedulerStatus",
  "transcription.status",
  "transcription.quality.status",
  "recording.durable.status",
  "retention.status",
]);

const recordingIdMethods = new Set([
  "ai.recapHeuristic",
  "recording.durable.read",
  "recording.durable.replayManifest",
  "recording.privacyReceipt",
  "recording.notes.read",
]);

const consentItemIds = new Set([
  "localOnlyStorage",
  "micRecording",
  "systemAudioRecording",
  "macosScreenCaptureSystemAudio",
]);

export class CoreInputValidationError extends Error {
  readonly code = "INVALID_RENDERER_INPUT";

  constructor(method: string, detail: string) {
    super(`Invalid ${method} request: ${detail}`);
    this.name = "CoreInputValidationError";
  }
}

function fail(method: string, detail: string): never {
  throw new CoreInputValidationError(method, detail);
}

function objectInput(method: string, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail(method, "expected an object payload");
  }
  return value as Record<string, unknown>;
}

function exactFields(method: string, value: Record<string, unknown>, fields: readonly string[]): void {
  const allowed = new Set(fields);
  const unknown = Object.keys(value).find((field) => !allowed.has(field));
  if (unknown) fail(method, `field ${unknown} is not allowed`);
}

function requiredString(method: string, value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string") return fail(method, `${field} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    return fail(method, `${field} must contain 1 to ${maximum} characters`);
  }
  return normalized;
}

function optionalString(
  method: string,
  value: unknown,
  field: string,
  maximum: number,
): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(method, value, field, maximum);
}

function optionalInteger(
  method: string,
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    return fail(method, `${field} must be an integer from ${minimum} to ${maximum}`);
  }
  return Number(value);
}

function requiredRecordingId(method: string, value: unknown): string {
  if (!validRecordingId(value)) return fail(method, "recordingId is invalid");
  return value;
}

function requiredLocalId(method: string, value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,96}$/.test(value)) {
    return fail(method, `${field} is invalid`);
  }
  return value;
}

function optionalModelId(method: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!validModelId(value)) return fail(method, "modelId is invalid");
  return value;
}

function boundedJson(method: string, value: unknown, field: string): JsonValue {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return fail(method, `${field} must be JSON serializable`);
  }
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > INPUT_LIMITS.eventPayloadBytes) {
    return fail(method, `${field} exceeds the ${INPUT_LIMITS.eventPayloadBytes} byte limit`);
  }
  return JSON.parse(serialized) as JsonValue;
}

function captureParams(method: string, input: unknown, combined: boolean): JsonValue {
  const value = objectInput(method, input);
  const deviceFields = combined ? ["micDeviceId", "systemDeviceId"] : ["deviceId"];
  exactFields(method, value, ["label", ...deviceFields, "chunkMs"]);
  const result: Record<string, JsonValue> = {};
  const label = optionalString(method, value.label, "label", INPUT_LIMITS.meetingTitle);
  if (label !== undefined) result.label = label;
  for (const field of deviceFields) {
    const deviceId = optionalString(method, value[field], field, INPUT_LIMITS.deviceId);
    if (deviceId !== undefined) result[field] = deviceId;
  }
  const chunkMs = optionalInteger(
    method,
    value.chunkMs,
    "chunkMs",
    INPUT_LIMITS.captureChunkMinimumMs,
    INPUT_LIMITS.captureChunkMaximumMs,
  );
  if (chunkMs !== undefined) result.chunkMs = chunkMs;
  return result;
}

function recordingQuestion(method: string, input: unknown, allowMaxTokens: boolean): JsonValue {
  const value = objectInput(method, input);
  exactFields(method, value, allowMaxTokens ? ["recordingId", "question", "maxTokens"] : ["recordingId", "question"]);
  const result: Record<string, JsonValue> = {
    recordingId: requiredRecordingId(method, value.recordingId),
    question: requiredString(method, value.question, "question", INPUT_LIMITS.question),
  };
  if (allowMaxTokens) {
    const maxTokens = optionalInteger(method, value.maxTokens, "maxTokens", 1, INPUT_LIMITS.maxTokens);
    if (maxTokens !== undefined) result.maxTokens = maxTokens;
  }
  return result;
}

function recordingOnly(method: string, input: unknown, allowMaxTokens = false): JsonValue {
  const value = objectInput(method, input);
  exactFields(method, value, allowMaxTokens ? ["recordingId", "maxTokens"] : ["recordingId"]);
  const result: Record<string, JsonValue> = {
    recordingId: requiredRecordingId(method, value.recordingId),
  };
  if (allowMaxTokens) {
    const maxTokens = optionalInteger(method, value.maxTokens, "maxTokens", 1, INPUT_LIMITS.maxTokens);
    if (maxTokens !== undefined) result.maxTokens = maxTokens;
  }
  return result;
}

function pagedRecordingInput(method: string, input: unknown, transcript: boolean): JsonValue {
  const value = objectInput(method, input);
  exactFields(method, value, transcript ? ["recordingId", "offset", "limit"] : ["offset", "limit"]);
  const result: Record<string, JsonValue> = {};
  if (transcript) result.recordingId = requiredRecordingId(method, value.recordingId);
  result.offset = optionalInteger(method, value.offset, "offset", 0, Number.MAX_SAFE_INTEGER) ?? 0;
  result.limit = optionalInteger(method, value.limit, "limit", 1, INPUT_LIMITS.pageSize) ?? 50;
  return result;
}

function transcriptionInput(method: string, input: unknown): JsonValue {
  const value = objectInput(method, input);
  exactFields(method, value, ["recordingId", "channel", "modelId"]);
  const result: Record<string, JsonValue> = {
    recordingId: requiredRecordingId(method, value.recordingId),
  };
  const channel = optionalString(method, value.channel, "channel", INPUT_LIMITS.channel);
  const modelId = optionalModelId(method, value.modelId);
  if (channel !== undefined) result.channel = channel;
  if (modelId !== undefined) result.modelId = modelId;
  return result;
}

function exportInput(method: string, input: unknown): JsonValue {
  const value = objectInput(method, input);
  exactFields(method, value, ["recordingId", "format", "channel", "report", "options"]);
  const format = value.format === undefined ? "markdown" : value.format;
  if (format !== "markdown" && format !== "docx" && format !== "pdf" && format !== "wav") {
    return fail(method, "format is not supported");
  }
  const result: Record<string, JsonValue> = {
    recordingId: requiredRecordingId(method, value.recordingId),
    format,
  };
  const channel = optionalString(method, value.channel, "channel", INPUT_LIMITS.channel);
  if (channel !== undefined) result.channel = channel;
  if (value.report !== undefined) result.report = boundedJson(method, value.report, "report");
  if (value.options !== undefined) result.options = boundedJson(method, value.options, "options");
  boundedJson(method, result, "export payload");
  return result;
}

export function validateRendererCoreParams(method: string, input: unknown): JsonValue {
  if (noParameterMethods.has(method)) {
    if (input !== null && input !== undefined) fail(method, "parameters are not accepted");
    return null;
  }
  if (method === "consent.acknowledge") {
    const value = objectInput(method, input);
    exactFields(method, value, ["items"]);
    if (!Array.isArray(value.items) || value.items.length < 1 || value.items.length > consentItemIds.size) {
      return fail(method, "items must be a non-empty consent identifier list");
    }
    const items = value.items.map((item) => {
      if (typeof item !== "string" || !consentItemIds.has(item)) fail(method, "items contains an unknown identifier");
      return item;
    });
    if (new Set(items).size !== items.length) fail(method, "items contains duplicates");
    return { items };
  }
  if (method === "capture.startMic" || method === "capture.startSystem") {
    return captureParams(method, input, false);
  }
  if (method === "capture.startMicAndSystem") return captureParams(method, input, true);
  if (method === "models.verifyLocal") {
    const value = objectInput(method, input);
    exactFields(method, value, ["modelId"]);
    const modelId = optionalModelId(method, value.modelId);
    return modelId === undefined ? {} : { modelId };
  }
  if (method === "ai.askHeuristic") return recordingQuestion(method, input, false);
  if (method === "ai.askInstruct") return recordingQuestion(method, input, true);
  if (method === "ai.recapInstruct") return recordingOnly(method, input, true);
  if (method === "transcription.quality.update") {
    const value = objectInput(method, input);
    exactFields(method, value, ["tier", "languagePreference"]);
    if (value.tier !== "fast" && value.tier !== "balanced" && value.tier !== "maximum") {
      return fail(method, "tier must be fast, balanced, or maximum");
    }
    if (value.languagePreference !== undefined
        && value.languagePreference !== "english"
        && value.languagePreference !== "multilingual") {
      return fail(method, "languagePreference must be english or multilingual");
    }
    return {
      tier: value.tier,
      ...(value.languagePreference === undefined ? {} : { languagePreference: value.languagePreference }),
    };
  }
  if (method === "terminology.status") {
    const value = objectInput(method, input);
    exactFields(method, value, ["recordingId"]);
    return value.recordingId === undefined
      ? {}
      : { recordingId: requiredRecordingId(method, value.recordingId) };
  }
  if (method === "terminology.setEnabled") {
    const value = objectInput(method, input);
    exactFields(method, value, ["dictionaryId", "enabled"]);
    if (typeof value.enabled !== "boolean") return fail(method, "enabled must be a boolean");
    return {
      dictionaryId: requiredLocalId(method, value.dictionaryId, "dictionaryId"),
      enabled: value.enabled,
    };
  }
  if (method === "terminology.assign") {
    const value = objectInput(method, input);
    exactFields(method, value, ["recordingId", "dictionaryId", "enabled"]);
    if (typeof value.enabled !== "boolean") return fail(method, "enabled must be a boolean");
    return {
      recordingId: requiredRecordingId(method, value.recordingId),
      dictionaryId: requiredLocalId(method, value.dictionaryId, "dictionaryId"),
      enabled: value.enabled,
    };
  }
  if (method === "terminology.proposals") return recordingOnly(method, input);
  if (method === "terminology.decide") {
    const value = objectInput(method, input);
    exactFields(method, value, ["recordingId", "proposalId", "decision"]);
    if (value.decision !== "accepted" && value.decision !== "rejected") {
      return fail(method, "decision must be accepted or rejected");
    }
    return {
      recordingId: requiredRecordingId(method, value.recordingId),
      proposalId: requiredLocalId(method, value.proposalId, "proposalId"),
      decision: value.decision,
    };
  }
  if (recordingIdMethods.has(method)) return recordingOnly(method, input);
  if (method === "transcription.runLocal") return transcriptionInput(method, input);
  if (method === "recording.durable.listPage") return pagedRecordingInput(method, input, false);
  if (method === "recording.durable.transcriptPage") return pagedRecordingInput(method, input, true);
  if (method === "recording.durable.readAudioChunk") {
    const value = objectInput(method, input);
    exactFields(method, value, ["recordingId", "index"]);
    return {
      recordingId: requiredRecordingId(method, value.recordingId),
      index: optionalInteger(method, value.index, "index", 0, 0xffff_ffff) ?? fail(method, "index is required"),
    };
  }
  if (method === "recording.durable.search") {
    const value = objectInput(method, input);
    exactFields(method, value, ["query"]);
    return { query: requiredString(method, value.query, "query", INPUT_LIMITS.searchQuery) };
  }
  if (method === "recording.notes.save") {
    const value = objectInput(method, input);
    exactFields(method, value, ["recordingId", "markdown"]);
    if (
      typeof value.markdown !== "string" ||
      value.markdown.length > INPUT_LIMITS.notesCharacters ||
      Buffer.byteLength(value.markdown, "utf8") > INPUT_LIMITS.notesUtf8Bytes
    ) {
      return fail(
        method,
        `markdown must be at most ${INPUT_LIMITS.notesCharacters} characters and ${INPUT_LIMITS.notesUtf8Bytes} UTF-8 bytes`,
      );
    }
    return { recordingId: requiredRecordingId(method, value.recordingId), markdown: value.markdown };
  }
  if (method === "export.create") return exportInput(method, input);
  return fail(method, "method has no renderer input contract");
}
