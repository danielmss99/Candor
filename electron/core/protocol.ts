import { randomUUID } from "node:crypto";
import { objectValue, type JsonValue } from "./json.js";
import { CoreClientError } from "./core-errors.js";

export const CORE_PROTOCOL_VERSION = "m0-jsonrpc-stdio-1";
export const MAX_CORE_REQUEST_LINE_BYTES = 4_000_000;
export const MAX_CORE_RESPONSE_LINE_BYTES = 24 * 1024 * 1024;

export interface CoreRequest {
  protocolVersion: typeof CORE_PROTOCOL_VERSION;
  requestId: string;
  id: string;
  method: string;
  params: JsonValue;
  sentAt: string;
}

export interface CoreResponse {
  requestId: string;
  id: string;
  protocolVersion: string;
  ok: boolean;
  result?: JsonValue;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
    details?: Record<string, JsonValue>;
  };
}

export interface CoreHandshake {
  protocolVersion: typeof CORE_PROTOCOL_VERSION;
  coreVersion: string;
  schemaVersion: number;
  capabilities: string[];
  build: {
    commit?: string;
    target: string;
    features: string[];
  };
}

export interface RendererCoreOperation {
  channel: `candor-core:${string}`;
  method: string;
  timeoutMs: number;
}

const operation = (
  channel: RendererCoreOperation["channel"],
  method: string,
  timeoutMs = 5000,
): RendererCoreOperation => ({ channel, method, timeoutMs });

export const rendererCoreOperations = Object.freeze([
  operation("candor-core:core-ping", "core.ping"),
  operation("candor-core:core-version", "core.version"),
  operation("candor-core:core-capabilities", "core.capabilities"),
  operation("candor-core:core-status", "core.status"),
  operation("candor-core:vault-open-local", "vault.openLocal"),
  operation("candor-core:vault-status", "vault.status"),
  operation("candor-core:privacy-audit-snapshot", "privacy.auditSnapshot"),
  operation("candor-core:privacy-capabilities", "privacy.capabilities"),
  operation("candor-core:updates-status", "updates.status"),
  operation("candor-core:v2-import-status", "import.v2.status"),
  operation("candor-core:consent-status", "consent.status"),
  operation("candor-core:consent-acknowledge", "consent.acknowledge"),
  operation("candor-core:capture-status", "capture.status"),
  operation("candor-core:capture-devices", "capture.devices"),
  operation("candor-core:capture-start-mic", "capture.startMic"),
  operation("candor-core:capture-start-system", "capture.startSystem"),
  operation("candor-core:capture-start-mic-and-system", "capture.startMicAndSystem"),
  operation("candor-core:capture-stop", "capture.stop"),
  operation("candor-core:models-status", "models.status"),
  operation("candor-core:models-list-local", "models.listLocal"),
  operation("candor-core:models-verify-local", "models.verifyLocal", 120_000),
  operation("candor-core:ai-status", "ai.status"),
  operation("candor-core:ai-ask-heuristic", "ai.askHeuristic"),
  operation("candor-core:ai-recap-heuristic", "ai.recapHeuristic"),
  operation("candor-core:ai-instruct-assets-status", "ai.instructAssetsStatus"),
  operation("candor-core:ai-instruct-status", "ai.instructStatus"),
  operation("candor-core:ai-ask-instruct", "ai.askInstruct", 60_000),
  operation("candor-core:ai-recap-instruct", "ai.recapInstruct", 60_000),
  operation("candor-core:ai-scheduler-status", "ai.schedulerStatus"),
  operation("candor-core:transcription-status", "transcription.status"),
  operation("candor-core:transcription-run-local", "transcription.runLocal", 120_000),
  operation("candor-core:recording-durable-status", "recording.durable.status"),
  operation("candor-core:recording-durable-list-page", "recording.durable.listPage"),
  operation("candor-core:recording-durable-read", "recording.durable.read"),
  operation("candor-core:recording-durable-replay-manifest", "recording.durable.replayManifest"),
  operation("candor-core:recording-durable-transcript-page", "recording.durable.transcriptPage"),
  operation("candor-core:recording-privacy-receipt", "recording.privacyReceipt"),
  operation("candor-core:recording-durable-read-audio-chunk", "recording.durable.readAudioChunk"),
  operation("candor-core:recording-durable-search", "recording.durable.search"),
  operation("candor-core:recording-notes-read", "recording.notes.read"),
  operation("candor-core:recording-notes-save", "recording.notes.save"),
  operation("candor-core:retention-status", "retention.status"),
  operation("candor-core:export-create", "export.create"),
]);

export const rendererCoreMethods = new Set(rendererCoreOperations.map(({ method }) => method));

export const privateCoreMethods = new Set([
  ...rendererCoreMethods,
  "core.shutdown",
  "models.importStart",
  "models.importChunk",
  "models.importFinish",
  "models.importAbort",
  "ai.instructAssetsImportFromPath",
  "recording.durable.start",
  "recording.durable.writeTranscriptSegment",
  "recording.durable.finish",
  "recording.durable.delete",
  "import.v2.fromFolder",
  "import.v2.proofSynthetic",
]);

export function createCoreRequest(method: string, params: JsonValue): CoreRequest {
  const requestId = randomUUID();
  return {
    protocolVersion: CORE_PROTOCOL_VERSION,
    requestId,
    id: requestId,
    method,
    params,
    sentAt: new Date().toISOString(),
  };
}

export function parseCoreResponseLine(line: string): CoreResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new CoreClientError("CORE_PROTOCOL_FAULT", "candor-core returned malformed JSON", false, {
      cause: error,
    });
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CoreClientError("CORE_PROTOCOL_FAULT", "candor-core returned a non-object response", false);
  }
  const value = parsed as Record<string, unknown>;
  if (typeof value.id !== "string" || !value.id) {
    throw new CoreClientError("CORE_PROTOCOL_FAULT", "candor-core response omitted its request id", false);
  }
  if (typeof value.requestId !== "string" || value.requestId !== value.id) {
    throw new CoreClientError("CORE_PROTOCOL_FAULT", "candor-core response returned mismatched request ids", false);
  }
  if (value.protocolVersion !== CORE_PROTOCOL_VERSION) {
    throw new CoreClientError(
      "CORE_PROTOCOL_MISMATCH",
      "candor-core uses an incompatible protocol version",
      false,
    );
  }
  if (typeof value.ok !== "boolean") {
    throw new CoreClientError("CORE_PROTOCOL_FAULT", "candor-core returned an invalid response envelope", false);
  }

  const response: CoreResponse = {
    requestId: value.id,
    id: value.id,
    protocolVersion: value.protocolVersion,
    ok: value.ok,
  };
  if ("result" in value) response.result = value.result as JsonValue;
  if (!value.ok) {
    const rawError = objectValue((value.error ?? null) as JsonValue);
    if (
      typeof rawError.code !== "string" ||
      typeof rawError.message !== "string" ||
      typeof rawError.retryable !== "boolean"
    ) {
      throw new CoreClientError("CORE_PROTOCOL_FAULT", "candor-core returned an invalid error envelope", false);
    }
    response.error = {
      code: rawError.code,
      message: rawError.message,
      retryable: rawError.retryable,
      ...(rawError.details && typeof rawError.details === "object" && !Array.isArray(rawError.details)
        ? { details: rawError.details }
        : {}),
    };
  }
  return response;
}

function stringArray(value: JsonValue, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.length > 0)) {
    throw new CoreClientError("CORE_PROTOCOL_MISMATCH", `candor-core handshake has invalid ${field}`, false);
  }
  return value.map((item) => String(item));
}

export function parseCoreHandshake(value: JsonValue): CoreHandshake {
  const handshake = objectValue(value);
  const build = objectValue(handshake.build ?? null);
  if (
    handshake.protocolVersion !== CORE_PROTOCOL_VERSION ||
    typeof handshake.version !== "string" ||
    !handshake.version ||
    typeof handshake.schemaVersion !== "number" ||
    !Number.isSafeInteger(handshake.schemaVersion) ||
    handshake.schemaVersion < 1 ||
    typeof build.target !== "string" ||
    !build.target
  ) {
    throw new CoreClientError("CORE_PROTOCOL_MISMATCH", "candor-core returned an incompatible handshake", false);
  }
  if (build.commit !== null && build.commit !== undefined && typeof build.commit !== "string") {
    throw new CoreClientError("CORE_PROTOCOL_MISMATCH", "candor-core handshake has an invalid build commit", false);
  }
  return {
    protocolVersion: CORE_PROTOCOL_VERSION,
    coreVersion: handshake.version,
    schemaVersion: handshake.schemaVersion,
    capabilities: stringArray(handshake.capabilities ?? null, "capabilities"),
    build: {
      ...(typeof build.commit === "string" && build.commit ? { commit: build.commit } : {}),
      target: build.target,
      features: stringArray(build.features ?? null, "build features"),
    },
  };
}
