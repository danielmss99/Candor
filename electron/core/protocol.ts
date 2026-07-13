import { randomUUID } from "node:crypto";
import { objectValue, type JsonValue } from "./json.js";
import { CoreClientError } from "./core-errors.js";

export const CORE_PROTOCOL_VERSION = "m0-jsonrpc-stdio-1";
export const MAX_CORE_REQUEST_LINE_BYTES = 1024 * 1024;
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

export const rendererCoreMethods = new Set([
  "core.ping",
  "core.version",
  "core.capabilities",
  "core.status",
  "vault.openLocal",
  "vault.status",
  "privacy.auditSnapshot",
  "privacy.capabilities",
  "updates.status",
  "import.v2.status",
  "consent.status",
  "consent.acknowledge",
  "capture.status",
  "capture.devices",
  "capture.startMic",
  "capture.startSystem",
  "capture.startMicAndSystem",
  "capture.stop",
  "models.status",
  "models.listLocal",
  "models.verifyLocal",
  "ai.status",
  "ai.askHeuristic",
  "ai.recapHeuristic",
  "ai.instructAssetsStatus",
  "ai.instructStatus",
  "ai.askInstruct",
  "ai.recapInstruct",
  "ai.schedulerStatus",
  "transcription.status",
  "transcription.runLocal",
  "recording.durable.status",
  "recording.durable.listPage",
  "recording.durable.read",
  "recording.durable.replayManifest",
  "recording.durable.transcriptPage",
  "recording.privacyReceipt",
  "recording.durable.readAudioChunk",
  "recording.durable.search",
  "recording.notes.read",
  "recording.notes.save",
  "retention.status",
  "export.create",
]);

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
  "import.v2.fromFolder",
  "import.v2.proofSynthetic",
]);

export const rendererCoreTimeoutMs = new Map<string, number>([
  ["ai.askInstruct", 60_000],
  ["ai.recapInstruct", 60_000],
  ["models.verifyLocal", 120_000],
  ["transcription.runLocal", 120_000],
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
    if (typeof rawError.code !== "string" || typeof rawError.message !== "string") {
      throw new CoreClientError("CORE_PROTOCOL_FAULT", "candor-core returned an invalid error envelope", false);
    }
    response.error = {
      code: rawError.code,
      message: rawError.message,
      retryable: rawError.retryable === true,
      ...(rawError.details && typeof rawError.details === "object" && !Array.isArray(rawError.details)
        ? { details: rawError.details }
        : {}),
    };
  }
  return response;
}
