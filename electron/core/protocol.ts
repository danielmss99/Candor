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

export interface CoreEvent {
  protocolVersion: typeof CORE_PROTOCOL_VERSION;
  event: "jobs.changed";
  payload: JsonValue;
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

export {
  CORE_OPERATIONS,
  privateCoreMethods,
  rendererCoreMethods,
  rendererCoreOperations,
  type CoreOperationDefinition,
  type RendererCoreOperation,
} from "./operation-registry.js";

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

const CORE_JOB_TYPES = new Set([
  "ask",
  "export",
  "legacy-import",
  "local-ai-benchmark",
  "local-ai-component-import",
  "recap",
  "speech-model-import",
  "speech-model-verification",
  "transcription",
]);
const CORE_JOB_STATES = new Set(["queued", "running", "completed", "failed", "cancelled"]);
const TERMINAL_JOB_STATES = new Set(["completed", "failed", "cancelled"]);

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function validJobProgress(value: unknown): boolean {
  const progress = recordValue(value);
  if (!progress || !Number.isSafeInteger(progress.completed) || Number(progress.completed) < 0) {
    return false;
  }
  if (progress.total !== undefined && progress.total !== null) {
    if (!Number.isSafeInteger(progress.total) || Number(progress.total) < Number(progress.completed)) {
      return false;
    }
  }
  return progress.unit === undefined
    || (typeof progress.unit === "string" && progress.unit.length > 0 && progress.unit.length <= 32);
}

function validJobError(value: unknown, state: string, jobId: string): boolean {
  if (state !== "failed") return value === null;
  const error = recordValue(value);
  return Boolean(
    error
    && typeof error.code === "string"
    && error.code.length > 0
    && typeof error.title === "string"
    && typeof error.message === "string"
    && typeof error.retryable === "boolean"
    && error.severity === "error"
    && error.correlationId === jobId
    && error.rawPathExposed === false,
  );
}

export function parseCoreEventLine(line: string): CoreEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !("event" in parsed)) {
    return null;
  }
  const value = parsed as Record<string, unknown>;
  if (value.protocolVersion !== CORE_PROTOCOL_VERSION) {
    throw new CoreClientError("CORE_PROTOCOL_MISMATCH", "candor-core event uses an incompatible protocol version", false);
  }
  if (value.event !== "jobs.changed") {
    throw new CoreClientError("CORE_PROTOCOL_FAULT", "candor-core emitted an unknown event", false);
  }
  if (!value.payload || typeof value.payload !== "object" || Array.isArray(value.payload)) {
    throw new CoreClientError("CORE_PROTOCOL_FAULT", "candor-core emitted an invalid job event", false);
  }
  const payload = value.payload as Record<string, unknown>;
  const state = typeof payload.state === "string" ? payload.state : "";
  const terminal = typeof payload.terminal === "boolean" ? payload.terminal : false;
  if (
    typeof payload.jobId !== "string" ||
    !/^[a-f0-9]{32}$/.test(payload.jobId) ||
    typeof payload.type !== "string" ||
    !CORE_JOB_TYPES.has(payload.type) ||
    !CORE_JOB_STATES.has(state) ||
    typeof payload.terminal !== "boolean" ||
    terminal !== TERMINAL_JOB_STATES.has(state) ||
    typeof payload.cancelRequested !== "boolean" ||
    typeof payload.createdAt !== "string" ||
    Number.isNaN(Date.parse(payload.createdAt)) ||
    typeof payload.updatedAt !== "string" ||
    Number.isNaN(Date.parse(payload.updatedAt)) ||
    (payload.stage !== null && (typeof payload.stage !== "string" || payload.stage.length < 1 || payload.stage.length > 64)) ||
    !validJobProgress(payload.progress) ||
    !validJobError(payload.error, state, payload.jobId) ||
    payload.rawPathExposed !== false ||
    payload.keyMaterialExposedToRenderer !== false
  ) {
    throw new CoreClientError("CORE_PROTOCOL_FAULT", "candor-core emitted an invalid job event payload", false);
  }
  return {
    protocolVersion: CORE_PROTOCOL_VERSION,
    event: "jobs.changed",
    payload: value.payload as JsonValue,
  };
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
