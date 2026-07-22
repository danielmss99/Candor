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
  "media.importStatus",
  "consent.status",
  "capture.status",
  "capture.devices",
  "capture.preferences",
  "capture.micTestStatus",
  "capture.micTestSample",
  "capture.micTestStop",
  "capture.stop",
  "models.status",
  "models.listLocal",
  "ai.status",
  "ai.bundledAssetsStatus",
  "ai.instructAssetsStatus",
  "ai.instructStatus",
  "ai.fallbackPreference.status",
  "ai.schedulerStatus",
  "transcription.status",
  "transcription.quality.status",
  "liveTranscript.eventsDrain",
  "diarization.status",
  "profiles.list",
  "replacements.list",
  "recording.durable.status",
  "retention.status",
]);

const recordingIdMethods = new Set([
  "ai.recapHeuristic",
  "recording.durable.read",
  "recording.durable.replayManifest",
  "recording.trustHistory",
  "recording.privacyReceipt",
  "recording.notes.read",
  "liveTranscript.enable",
  "liveTranscript.start",
  "liveTranscript.snapshot",
  "liveTranscript.clear",
  "liveTranscript.stop",
  "diarization.speakerNames",
  "transcription.protectedTermReview",
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

function requiredSafeId(method: string, value: unknown, field: string): string {
  if (
    typeof value !== "string"
    || Buffer.byteLength(value, "utf8") > 64
    || !/^[a-z](?:(?:[a-z0-9]|-(?!-))*[a-z0-9])?$/.test(value)
  ) {
    return fail(method, `${field} must be a bounded lowercase identifier`);
  }
  return value;
}

function optionalSafeId(method: string, value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredSafeId(method, value, field);
}

function boundedText(
  method: string,
  value: unknown,
  field: string,
  maximumBytes: number,
  allowEmpty: boolean,
): string {
  if (typeof value !== "string" || value.includes("\0")) {
    return fail(method, `${field} must be safe text`);
  }
  const byteLength = Buffer.byteLength(value, "utf8");
  if ((!allowEmpty && value.trim().length === 0) || byteLength > maximumBytes) {
    return fail(method, `${field} exceeds its bounded text limit`);
  }
  return value;
}

function profileInput(method: string, input: unknown): JsonValue {
  const value = objectInput(method, input);
  exactFields(method, value, [
    "id",
    "expectedVersion",
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
  ]);
  if (
    value.captureSource !== "microphone"
    && value.captureSource !== "system-audio"
    && value.captureSource !== "combined"
  ) {
    return fail(method, "captureSource is invalid");
  }
  if (
    value.localModelTier !== "fast"
    && value.localModelTier !== "balanced"
    && value.localModelTier !== "maximum"
  ) {
    return fail(method, "localModelTier is invalid");
  }
  if (typeof value.liveTranscription !== "boolean") {
    return fail(method, "liveTranscription must be a boolean");
  }
  const language = boundedText(method, value.language, "language", 35, false);
  if (
    language !== "auto"
    && !/^[A-Za-z](?:(?:[A-Za-z0-9]|-(?!-))*[A-Za-z0-9])?$/.test(language)
  ) {
    return fail(method, "language must be auto or a bounded language tag");
  }
  if (!Array.isArray(value.dictionaryIds) || value.dictionaryIds.length > 16) {
    return fail(method, "dictionaryIds must contain at most 16 identifiers");
  }
  const dictionaryIds = value.dictionaryIds.map((item) => requiredSafeId(method, item, "dictionaryId"));
  if (new Set(dictionaryIds).size !== dictionaryIds.length) {
    return fail(method, "dictionaryIds must not contain duplicates");
  }
  const id = optionalSafeId(method, value.id, "id");
  const expectedVersion = optionalInteger(
    method,
    value.expectedVersion,
    "expectedVersion",
    1,
    0xffff_ffff,
  );
  const replacementRuleSetId = optionalSafeId(
    method,
    value.replacementRuleSetId,
    "replacementRuleSetId",
  );
  const speechModelId = value.speechModelId;
  if (speechModelId !== undefined && (
    typeof speechModelId !== "string"
    || !new Set(["small.en", "small", "large-v3-turbo", "large-v3", "parakeet-tdt-0.6b-v3-int8"]).has(speechModelId)
  )) {
    return fail(method, "speechModelId is not in the bounded local catalog");
  }
  for (const field of ["cleanupModelId", "summaryModelId"] as const) {
    if (value[field] !== undefined && value[field] !== "qwen3-4b-official-q4_k_m") {
      return fail(method, `${field} is not in the bounded local catalog`);
    }
  }
  const result: Record<string, JsonValue> = {
    name: boundedText(method, value.name, "name", 80, false).trim(),
    captureSource: value.captureSource,
    language,
    localModelTier: value.localModelTier,
    dictionaryIds,
    replacementRuleSetId: replacementRuleSetId ?? null,
    recapTemplate: boundedText(method, value.recapTemplate, "recapTemplate", 4 * 1024, true),
    liveTranscription: value.liveTranscription,
  };
  if (id !== undefined) result.id = id;
  if (expectedVersion !== undefined) result.expectedVersion = expectedVersion;
  if (typeof speechModelId === "string") result.speechModelId = speechModelId;
  if (typeof value.cleanupModelId === "string") result.cleanupModelId = value.cleanupModelId;
  if (typeof value.summaryModelId === "string") result.summaryModelId = value.summaryModelId;
  return boundedJson(method, result, "profile payload");
}

function replacementRuleSetInput(method: string, input: unknown): JsonValue {
  const value = objectInput(method, input);
  exactFields(method, value, ["id", "expectedVersion", "name", "rules"]);
  if (!Array.isArray(value.rules) || value.rules.length > 64) {
    return fail(method, "rules must contain at most 64 entries");
  }
  const ruleIds = new Set<string>();
  const orders = new Set<number>();
  const rules = value.rules.map((candidate, index) => {
    const rule = objectInput(method, candidate);
    exactFields(method, rule, [
      "id",
      "order",
      "matchMode",
      "literal",
      "replacement",
      "protectedTermReview",
      "enabled",
    ]);
    const id = requiredSafeId(method, rule.id, `rules[${index}].id`);
    const order = optionalInteger(method, rule.order, `rules[${index}].order`, 0, 10_000)
      ?? fail(method, `rules[${index}].order is required`);
    if (ruleIds.has(id) || orders.has(order)) {
      return fail(method, "rule IDs and order values must be unique");
    }
    ruleIds.add(id);
    orders.add(order);
    if (rule.matchMode !== "exact" && rule.matchMode !== "whole-word") {
      return fail(method, `rules[${index}].matchMode is invalid`);
    }
    if (typeof rule.protectedTermReview !== "boolean" || typeof rule.enabled !== "boolean") {
      return fail(method, `rules[${index}] flags must be booleans`);
    }
    return {
      id,
      order,
      matchMode: rule.matchMode,
      literal: boundedText(method, rule.literal, `rules[${index}].literal`, 128, false),
      replacement: boundedText(method, rule.replacement, `rules[${index}].replacement`, 512, true),
      protectedTermReview: rule.protectedTermReview,
      enabled: rule.enabled,
    };
  });
  const id = optionalSafeId(method, value.id, "id");
  const expectedVersion = optionalInteger(
    method,
    value.expectedVersion,
    "expectedVersion",
    1,
    0xffff_ffff,
  );
  const result: Record<string, JsonValue> = {
    name: boundedText(method, value.name, "name", 80, false).trim(),
    rules,
  };
  if (id !== undefined) result.id = id;
  if (expectedVersion !== undefined) result.expectedVersion = expectedVersion;
  return boundedJson(method, result, "replacement rule set payload");
}

function captureParams(method: string, input: unknown, deviceFields: readonly string[]): JsonValue {
  const value = objectInput(method, input);
  exactFields(method, value, ["label", ...deviceFields, "chunkMs", "profileId", "profileVersion"]);
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
  const profileId = optionalSafeId(method, value.profileId, "profileId");
  const profileVersion = optionalInteger(method, value.profileVersion, "profileVersion", 1, 0xffff_ffff);
  if ((profileId === undefined) !== (profileVersion === undefined)) {
    return fail(method, "profileId and profileVersion must be provided together");
  }
  if (profileId !== undefined && profileVersion !== undefined) {
    result.profileId = profileId;
    result.profileVersion = profileVersion;
  }
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
  if (method === "capture.startMic") return captureParams(method, input, []);
  if (method === "capture.startSystem") return captureParams(method, input, ["deviceId"]);
  if (method === "capture.startMicAndSystem") {
    return captureParams(method, input, ["systemDeviceId"]);
  }
  if (method === "capture.setPreferredMicrophone") {
    const value = objectInput(method, input);
    exactFields(method, value, ["deviceId", "fingerprint", "ordinal"]);
    const deviceId = requiredString(method, value.deviceId, "deviceId", INPUT_LIMITS.deviceId);
    const fingerprint = optionalString(method, value.fingerprint, "fingerprint", 64);
    if (fingerprint !== undefined && !/^[a-f0-9]{64}$/.test(fingerprint)) {
      return fail(method, "fingerprint must be 64 lowercase hexadecimal characters");
    }
    const ordinal = optionalInteger(method, value.ordinal, "ordinal", 0, 4_096);
    return {
      deviceId,
      ...(fingerprint === undefined ? {} : { fingerprint }),
      ...(ordinal === undefined ? {} : { ordinal }),
    };
  }
  if (method === "capture.micTestStart") {
    const value = objectInput(method, input);
    exactFields(method, value, []);
    return {};
  }
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
  if (method === "diarization.updatePreference") {
    const value = objectInput(method, input);
    exactFields(method, value, ["enabled"]);
    if (typeof value.enabled !== "boolean") {
      return fail(method, "enabled must be a boolean");
    }
    return { enabled: value.enabled };
  }
  if (
    method === "diarization.assignSpeakerName"
    || method === "diarization.removeSpeakerName"
  ) {
    const value = objectInput(method, input);
    exactFields(
      method,
      value,
      method === "diarization.assignSpeakerName"
        ? ["recordingId", "anonymousSpeakerId", "displayName"]
        : ["recordingId", "anonymousSpeakerId"],
    );
    if (
      typeof value.anonymousSpeakerId !== "string"
      || !/^speaker-[1-9][0-9]{0,3}$/.test(value.anonymousSpeakerId)
    ) {
      return fail(method, "anonymousSpeakerId must use the speaker-N format");
    }
    const result: Record<string, JsonValue> = {
      recordingId: requiredRecordingId(method, value.recordingId),
      anonymousSpeakerId: value.anonymousSpeakerId,
    };
    if (method === "diarization.assignSpeakerName") {
      if (
        typeof value.displayName !== "string"
        || value.displayName.trim() !== value.displayName
        || Buffer.byteLength(value.displayName, "utf8") < 1
        || Buffer.byteLength(value.displayName, "utf8") > 80
        || /[\u0000-\u001f\u007f]/.test(value.displayName)
      ) {
        return fail(method, "displayName must be 1 to 80 safe UTF-8 bytes without surrounding whitespace");
      }
      result.displayName = value.displayName;
    }
    return result;
  }
  if (
    method === "profiles.get"
    || method === "profiles.select"
    || method === "replacements.get"
  ) {
    const value = objectInput(method, input);
    exactFields(method, value, ["id"]);
    return { id: requiredSafeId(method, value.id, "id") };
  }
  if (method === "profiles.upsert") return profileInput(method, input);
  if (method === "replacements.upsert") return replacementRuleSetInput(method, input);
  if (method === "profiles.delete" || method === "replacements.delete") {
    const value = objectInput(method, input);
    exactFields(method, value, ["id", "expectedVersion"]);
    return {
      id: requiredSafeId(method, value.id, "id"),
      expectedVersion: optionalInteger(
        method,
        value.expectedVersion,
        "expectedVersion",
        1,
        0xffff_ffff,
      ) ?? fail(method, "expectedVersion is required"),
    };
  }
  if (method === "replacements.preview" || method === "replacements.apply") {
    const value = objectInput(method, input);
    exactFields(
      method,
      value,
      method === "replacements.apply"
        ? ["setId", "input", "previewToken", "approveProtectedTerms"]
        : ["setId", "input"],
    );
    const result: Record<string, JsonValue> = {
      setId: requiredSafeId(method, value.setId, "setId"),
      input: boundedText(method, value.input, "input", 256 * 1024, true),
    };
    if (method === "replacements.apply") {
      if (typeof value.previewToken !== "string" || !/^[a-f0-9]{64}$/.test(value.previewToken)) {
        return fail(method, "previewToken must be 64 lowercase hexadecimal characters");
      }
      if (
        value.approveProtectedTerms !== undefined
        && typeof value.approveProtectedTerms !== "boolean"
      ) {
        return fail(method, "approveProtectedTerms must be a boolean");
      }
      result.previewToken = value.previewToken;
      result.approveProtectedTerms = value.approveProtectedTerms ?? false;
    }
    return boundedJson(method, result, "replacement payload");
  }
  if (
    method === "recording.transcriptRevision"
    || method === "recording.selectTranscriptRevision"
  ) {
    const value = objectInput(method, input);
    exactFields(method, value, ["recordingId", "revisionId"]);
    return {
      recordingId: requiredRecordingId(method, value.recordingId),
      revisionId: requiredLocalId(method, value.revisionId, "revisionId"),
    };
  }
  if (method === "transcription.prepareReprocess") {
    const value = objectInput(method, input);
    exactFields(method, value, ["recordingId", "channel"]);
    const channel = optionalString(method, value.channel, "channel", INPUT_LIMITS.channel);
    return {
      recordingId: requiredRecordingId(method, value.recordingId),
      ...(channel === undefined ? {} : { channel }),
    };
  }
  if (method === "transcription.applyProtectedTermReview") {
    const value = objectInput(method, input);
    exactFields(method, value, ["recordingId", "revisionId", "previewToken"]);
    if (typeof value.previewToken !== "string" || !/^[a-f0-9]{64}$/.test(value.previewToken)) {
      return fail(method, "previewToken must be 64 lowercase hexadecimal characters");
    }
    return {
      recordingId: requiredRecordingId(method, value.recordingId),
      revisionId: requiredLocalId(method, value.revisionId, "revisionId"),
      previewToken: value.previewToken,
    };
  }
  if (method === "ai.fallbackPreference.update") {
    const value = objectInput(method, input);
    exactFields(method, value, ["preference"]);
    if (
      value.preference !== "ask-first"
      && value.preference !== "automatic"
      && value.preference !== "never"
    ) {
      return fail(method, "preference must be ask-first, automatic, or never");
    }
    return { preference: value.preference };
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
