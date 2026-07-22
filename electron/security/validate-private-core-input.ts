import type { JsonValue } from "../core/json.js";
import { INPUT_LIMITS, validModelId, validRecordingId } from "./input-limits.js";
import { validateRendererCoreParams } from "./validate-core-input.js";

const IMPORT_ID = /^[A-Za-z0-9_-]{1,96}$/;
const JOB_ID = /^[a-f0-9]{32}$/;
const SHA256 = /^[a-fA-F0-9]{64}$/;
const LOWERCASE_SHA256 = /^[a-f0-9]{64}$/;
const MAX_PATH_CHARACTERS = 32_768;
const MAX_BASE64_CHUNK_CHARACTERS = 6_000_000;
const MAX_DICTIONARY_PACKAGE_BASE64_CHARACTERS = 3_333_352;
const MAX_RECAP_TEMPLATE_BYTES = 4_096;

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

function boundedJson(method: string, value: unknown, field: string): JsonValue {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return fail(method, `${field} must be JSON serializable`);
  }
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > INPUT_LIMITS.eventPayloadBytes) {
    return fail(method, `${field} exceeds the local payload limit`);
  }
  return JSON.parse(serialized) as JsonValue;
}

function recordingOnly(method: string, value: unknown): JsonValue {
  const input = objectInput(method, value);
  exactFields(method, input, ["recordingId"]);
  return { recordingId: requiredRecordingId(method, input.recordingId) };
}

export function validatePrivateCoreParams(method: string, input: unknown): JsonValue {
  if (
    method === "ai.askHeuristic"
    || method === "ai.recapHeuristic"
    || method === "ai.askInstruct"
    || method === "ai.recapInstruct"
    || method === "transcription.runLocal"
    || method === "export.create"
  ) {
    return validateRendererCoreParams(method, input);
  }
  if (
    method === "core.shutdown"
    || method === "jobs.list"
    || method === "jobs.activeSummary"
    || method === "jobs.cancelAll"
    || method === "jobs.pauseAll"
    || method === "recording.durable.recover"
  ) {
    if (input !== null && input !== undefined) fail(method, "parameters are not accepted");
    return null;
  }
  if (
    method === "jobs.get"
    || method === "jobs.cancel"
    || method === "jobs.retry"
    || method === "jobs.acknowledge"
  ) {
    const value = objectInput(method, input);
    exactFields(method, value, ["jobId"]);
    if (typeof value.jobId !== "string" || !JOB_ID.test(value.jobId)) fail(method, "jobId is invalid");
    return { jobId: value.jobId };
  }
  if (method === "transcription.quality.benchmark.start") {
    const value = objectInput(method, input);
    exactFields(method, value, ["tier"]);
    if (value.tier !== "balanced" && value.tier !== "maximum") {
      fail(method, "tier must be balanced or maximum");
    }
    return { tier: value.tier };
  }
  if (method === "transcription.start") {
    return validateRendererCoreParamsAlias("transcription.runLocal", input);
  }
  if (method === "terminology.import") {
    const value = objectInput(method, input);
    exactFields(method, value, ["name", "format", "content"]);
    const name = requiredString(
      method,
      value.name,
      "name",
      INPUT_LIMITS.terminologyDictionaryName,
    ).trim();
    if (!name) fail(method, "name must not be blank");
    if (value.format !== "txt" && value.format !== "csv" && value.format !== "json") {
      fail(method, "format must be txt, csv, or json");
    }
    const content = requiredString(method, value.content, "content", INPUT_LIMITS.terminologyFileBytes);
    if (Buffer.byteLength(content, "utf8") > INPUT_LIMITS.terminologyFileBytes) {
      fail(method, "content exceeds the local terminology file limit");
    }
    return { name, format: value.format, content };
  }
  if (method === "terminology.package.start") {
    const value = objectInput(method, input);
    exactFields(method, value, ["sourceFileName", "archiveBase64"]);
    const sourceFileName = requiredString(method, value.sourceFileName, "sourceFileName", 180);
    if (!sourceFileName.toLowerCase().endsWith(".candordict") || sourceFileName.includes("/") || sourceFileName.includes("\\")) {
      fail(method, "sourceFileName must be a local .candordict file name");
    }
    return {
      sourceFileName,
      archiveBase64: requiredString(
        method,
        value.archiveBase64,
        "archiveBase64",
        MAX_DICTIONARY_PACKAGE_BASE64_CHARACTERS,
      ),
    };
  }
  if (method === "models.verify.start") {
    const value = objectInput(method, input);
    exactFields(method, value, ["modelId"]);
    if (value.modelId === undefined) return {};
    if (!validModelId(value.modelId)) fail(method, "modelId is invalid");
    return { modelId: value.modelId };
  }
  if (method === "export.start") return validateRendererCoreParamsAlias("export.create", input);
  if (method === "ai.recap.start" || method === "ai.ask.start") {
    const value = objectInput(method, input);
    exactFields(
      method,
      value,
      method === "ai.ask.start"
        ? ["recordingId", "question", "intent"]
        : ["recordingId", "recapTemplate", "intent"],
    );
    const result: Record<string, JsonValue> = {
      recordingId: requiredRecordingId(method, value.recordingId),
    };
    if (method === "ai.ask.start") {
      result.question = requiredString(method, value.question, "question", INPUT_LIMITS.question);
    } else if (value.recapTemplate !== undefined) {
      const recapTemplate = requiredString(
        method,
        value.recapTemplate,
        "recapTemplate",
        MAX_RECAP_TEMPLATE_BYTES,
      ).trim();
      if (
        !recapTemplate
        || Buffer.byteLength(recapTemplate, "utf8") > MAX_RECAP_TEMPLATE_BYTES
        || [...recapTemplate].some((character) => {
          const code = character.codePointAt(0) ?? 0;
          return code === 0 || (code < 32 && character !== "\n" && character !== "\r" && character !== "\t");
        })
      ) {
        fail(method, "recapTemplate must contain bounded safe text");
      }
      result.recapTemplate = recapTemplate;
    }
    const intent = value.intent ?? "default";
    if (intent !== "default" && intent !== "strict-retry" && intent !== "explicit-heuristic") {
      fail(method, "intent must be default, strict-retry, or explicit-heuristic");
    }
    result.intent = intent;
    return result;
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
  if (method === "models.importFinish" || method === "models.importFinish.start" || method === "models.importAbort") {
    const value = objectInput(method, input);
    exactFields(method, value, ["importId"]);
    return { importId: requiredImportId(method, value.importId) };
  }
  if (method === "ai.instructAssetsImportFromPath" || method === "ai.instructAssetsImport.start") {
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
  if (method === "import.v2.fromFolder" || method === "import.v2.startFromFolder") {
    const value = objectInput(method, input);
    exactFields(method, value, ["sourcePath"]);
    return { sourcePath: requiredString(method, value.sourcePath, "sourcePath", MAX_PATH_CHARACTERS) };
  }
  if (method === "media.validateLocalSourcePath") {
    const value = objectInput(method, input);
    exactFields(method, value, ["sourcePath"]);
    const sourcePath = requiredString(
      method,
      value.sourcePath,
      "sourcePath",
      MAX_PATH_CHARACTERS,
    );
    if (sourcePath.includes("\0")) fail(method, "sourcePath contains a null character");
    return { sourcePath };
  }
  if (method === "media.importFromPath") {
    const value = objectInput(method, input);
    exactFields(method, value, ["sourcePath", "expectedSourceSha256"]);
    const sourcePath = requiredString(
      method,
      value.sourcePath,
      "sourcePath",
      MAX_PATH_CHARACTERS,
    );
    if (sourcePath.includes("\0")) fail(method, "sourcePath contains a null character");
    if (typeof value.expectedSourceSha256 !== "string" || !LOWERCASE_SHA256.test(value.expectedSourceSha256)) {
      fail(method, "expectedSourceSha256 must be a lowercase SHA-256 value");
    }
    return { sourcePath, expectedSourceSha256: value.expectedSourceSha256 };
  }
  if (method === "import.v2.proofSynthetic") {
    const value = objectInput(method, input);
    exactFields(method, value, ["label"]);
    const label = optionalString(method, value.label, "label", INPUT_LIMITS.meetingTitle);
    return label === undefined ? {} : { label };
  }
  return fail(method, "method has no private input contract");
}

function validateRendererCoreParamsAlias(method: string, input: unknown): JsonValue {
  if (method === "transcription.runLocal") {
    const value = objectInput(method, input);
    exactFields(method, value, ["recordingId", "channel", "modelId"]);
    const result: Record<string, JsonValue> = {
      recordingId: requiredRecordingId(method, value.recordingId),
    };
    const channel = optionalString(method, value.channel, "channel", INPUT_LIMITS.channel);
    if (value.modelId !== undefined) {
      if (!validModelId(value.modelId)) fail(method, "modelId is invalid");
      result.modelId = value.modelId;
    }
    if (channel !== undefined) result.channel = channel;
    return result;
  }
  const value = objectInput(method, input);
  exactFields(method, value, ["recordingId", "format", "channel", "report", "options"]);
  const format = value.format ?? "markdown";
  if (format !== "markdown" && format !== "docx" && format !== "pdf" && format !== "wav") {
    fail(method, "format is not supported");
  }
  const result: Record<string, JsonValue> = {
    recordingId: requiredRecordingId(method, value.recordingId),
    format,
  };
  const channel = optionalString(method, value.channel, "channel", INPUT_LIMITS.channel);
  if (channel !== undefined) result.channel = channel;
  if (value.report !== undefined) result.report = boundedJson(method, value.report, "report");
  if (value.options !== undefined) result.options = boundedJson(method, value.options, "options");
  return result;
}
