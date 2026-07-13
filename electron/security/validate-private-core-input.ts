import type { JsonValue } from "../core/json.js";
import { INPUT_LIMITS, validModelId, validRecordingId } from "./input-limits.js";

const IMPORT_ID = /^[A-Za-z0-9_-]{1,96}$/;
const SHA256 = /^[a-fA-F0-9]{64}$/;
const MAX_PATH_CHARACTERS = 32_768;
const MAX_BASE64_CHUNK_CHARACTERS = 6_000_000;

function fail(method: string, detail: string): never {
  throw new Error(`Invalid ${method} request: ${detail}`);
}

function objectInput(method: string, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail(method, "expected an object payload");
  return value as Record<string, unknown>;
}

function exactFields(method: string, value: Record<string, unknown>, fields: readonly string[]): void {
  const allowed = new Set(fields);
  const unknown = Object.keys(value).find((field) => !allowed.has(field));
  if (unknown) fail(method, `field ${unknown} is not allowed`);
}

function requiredString(method: string, value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    return fail(method, `${field} must contain 1 to ${maximum} characters`);
  }
  return value;
}

function optionalString(method: string, value: unknown, field: string, maximum: number): string | undefined {
  return value === undefined ? undefined : requiredString(method, value, field, maximum);
}

function requiredRecordingId(method: string, value: unknown): string {
  if (!validRecordingId(value)) return fail(method, "recordingId is invalid");
  return value;
}

function requiredImportId(method: string, value: unknown): string {
  if (typeof value !== "string" || !IMPORT_ID.test(value)) return fail(method, "importId is invalid");
  return value;
}

function integer(method: string, value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    return fail(method, `${field} must be an integer from ${minimum} to ${maximum}`);
  }
  return Number(value);
}

function recordingOnly(method: string, value: unknown): JsonValue {
  const input = objectInput(method, value);
  exactFields(method, input, ["recordingId"]);
  return { recordingId: requiredRecordingId(method, input.recordingId) };
}

export function validatePrivateCoreParams(method: string, input: unknown): JsonValue {
  if (method === "core.shutdown") {
    if (input !== null && input !== undefined) fail(method, "parameters are not accepted");
    return null;
  }
  if (method === "models.importStart") {
    const value = objectInput(method, input);
    exactFields(method, value, ["modelId", "expectedBytes", "replace"]);
    const result: Record<string, JsonValue> = {};
    if (value.modelId !== undefined) {
      if (!validModelId(value.modelId)) fail(method, "modelId is invalid");
      result.modelId = value.modelId;
    }
    if (value.expectedBytes !== undefined) {
      result.expectedBytes = integer(method, value.expectedBytes, "expectedBytes", 1, Number.MAX_SAFE_INTEGER);
    }
    if (value.replace !== undefined) {
      if (typeof value.replace !== "boolean") fail(method, "replace must be a boolean");
      result.replace = value.replace;
    }
    return result;
  }
  if (method === "models.importChunk") {
    const value = objectInput(method, input);
    exactFields(method, value, ["importId", "dataBase64"]);
    return {
      importId: requiredImportId(method, value.importId),
      dataBase64: requiredString(method, value.dataBase64, "dataBase64", MAX_BASE64_CHUNK_CHARACTERS),
    };
  }
  if (method === "models.importFinish" || method === "models.importAbort") {
    const value = objectInput(method, input);
    exactFields(method, value, ["importId"]);
    return { importId: requiredImportId(method, value.importId) };
  }
  if (method === "ai.instructAssetsImportFromPath") {
    const value = objectInput(method, input);
    exactFields(method, value, ["assetKind", "sourcePath", "expectedSha256", "replace"]);
    if (value.assetKind !== "runner" && value.assetKind !== "model") fail(method, "assetKind is invalid");
    if (typeof value.expectedSha256 !== "string" || !SHA256.test(value.expectedSha256)) {
      fail(method, "expectedSha256 is invalid");
    }
    if (value.replace !== undefined && typeof value.replace !== "boolean") fail(method, "replace must be a boolean");
    return {
      assetKind: value.assetKind,
      sourcePath: requiredString(method, value.sourcePath, "sourcePath", MAX_PATH_CHARACTERS),
      expectedSha256: value.expectedSha256.toLowerCase(),
      replace: value.replace === true,
    };
  }
  if (method === "recording.durable.start") {
    const value = objectInput(method, input);
    exactFields(method, value, ["label"]);
    const label = optionalString(method, value.label, "label", INPUT_LIMITS.meetingTitle);
    return label === undefined ? {} : { label };
  }
  if (method === "recording.durable.writeTranscriptSegment") {
    const value = objectInput(method, input);
    exactFields(method, value, ["recordingId", "channel", "speaker", "text", "startMs", "durationMs", "endMs", "confidence"]);
    const result: Record<string, JsonValue> = {
      recordingId: requiredRecordingId(method, value.recordingId),
      channel: optionalString(method, value.channel, "channel", INPUT_LIMITS.channel) ?? "default",
      text: requiredString(method, value.text, "text", INPUT_LIMITS.notesCharacters),
      startMs: integer(method, value.startMs, "startMs", 0, Number.MAX_SAFE_INTEGER),
    };
    const speaker = optionalString(method, value.speaker, "speaker", INPUT_LIMITS.meetingTitle);
    if (speaker !== undefined) result.speaker = speaker;
    for (const field of ["durationMs", "endMs"] as const) {
      if (value[field] !== undefined) result[field] = integer(method, value[field], field, 0, Number.MAX_SAFE_INTEGER);
    }
    if (value.confidence !== undefined) {
      if (typeof value.confidence !== "number" || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) {
        fail(method, "confidence must be a number from 0 to 1");
      }
      result.confidence = value.confidence;
    }
    return result;
  }
  if (method === "recording.durable.finish" || method === "recording.durable.delete") {
    return recordingOnly(method, input);
  }
  if (method === "import.v2.fromFolder") {
    const value = objectInput(method, input);
    exactFields(method, value, ["sourcePath"]);
    return { sourcePath: requiredString(method, value.sourcePath, "sourcePath", MAX_PATH_CHARACTERS) };
  }
  if (method === "import.v2.proofSynthetic") {
    const value = objectInput(method, input);
    exactFields(method, value, ["label"]);
    const label = optionalString(method, value.label, "label", INPUT_LIMITS.meetingTitle);
    return label === undefined ? {} : { label };
  }
  return fail(method, "method has no private input contract");
}
