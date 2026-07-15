import { CoreClientError } from "./core-errors.js";
import type { JsonValue } from "./json.js";
import { validateCompletedJobResult } from "./operation-registry.js";

export const BACKGROUND_TASK_KINDS = [
  "transcription",
  "recap",
  "ask",
  "export",
  "legacy-import",
  "local-ai-benchmark",
  "local-ai-component-import",
  "speech-model-import",
  "speech-model-verification",
  "dictionary-import",
  "dictionary-index",
] as const;

export const BACKGROUND_TASK_STATES = [
  "queued",
  "running",
  "paused",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
] as const;

export const BACKGROUND_PROGRESS_UNITS = ["percent", "seconds", "chunks", "bytes"] as const;

export type BackgroundTaskKind = typeof BACKGROUND_TASK_KINDS[number];
export type BackgroundTaskState = typeof BACKGROUND_TASK_STATES[number];
export type BackgroundProgressUnit = typeof BACKGROUND_PROGRESS_UNITS[number];

export interface BackgroundTaskProgress {
  completed: number;
  total?: number | null;
  unit: BackgroundProgressUnit;
}

export interface BackgroundTaskError {
  code: string;
  title: string;
  message: string;
  retryable: boolean;
  severity: "error";
  correlationId: string;
  rawPathExposed: false;
}

export interface AiProvenance {
  engine: "local-llm" | "heuristic";
  modelId?: string | null;
  fallbackUsed: boolean;
  fallbackReason?: "llm-unavailable" | "runtime-failed" | "model-corrupt" | "resource-policy" | "user-requested" | null;
  promptVersion: string;
  generatedAt: string;
}

export interface BackgroundTask {
  jobId: string;
  type: BackgroundTaskKind;
  state: BackgroundTaskState;
  createdAt: string;
  updatedAt: string;
  stage?: string | null;
  progress?: BackgroundTaskProgress | null;
  estimatedRemainingMs?: number | null;
  recordingId?: string | null;
  parentJobId?: string | null;
  result?: JsonValue;
  resultAvailableAfterRestart?: boolean;
  error?: BackgroundTaskError | null;
  provenance?: AiProvenance | null;
  cancelRequested: boolean;
  retryCount: number;
  retryable: boolean;
  terminal: boolean;
  sourceDataPreserved: true;
  rawPathExposed: false;
  keyMaterialExposedToRenderer: false;
}

const kindSet = new Set<string>(BACKGROUND_TASK_KINDS);
const stateSet = new Set<string>(BACKGROUND_TASK_STATES);
const unitSet = new Set<string>(BACKGROUND_PROGRESS_UNITS);
const terminalStateSet = new Set<BackgroundTaskState>(["completed", "failed", "cancelled"]);
const fallbackReasonSet = new Set([
  "llm-unavailable",
  "runtime-failed",
  "model-corrupt",
  "resource-policy",
  "user-requested",
]);
const safeIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const safeStagePattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const safePromptVersionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const safeErrorCodePattern = /^[A-Z][A-Z0-9_]{0,127}$/;
const taskFieldSet = new Set([
  "jobId", "type", "state", "createdAt", "updatedAt", "stage", "progress",
  "estimatedRemainingMs", "recordingId", "parentJobId", "result",
  "resultAvailableAfterRestart", "error", "engine", "fallbackUsed", "provenance",
  "cancelRequested", "retryCount", "retryable", "terminal", "sourceDataPreserved",
  "rawPathExposed", "keyMaterialExposedToRenderer",
]);
const progressFieldSet = new Set(["completed", "total", "unit"]);
const errorFieldSet = new Set([
  "code", "title", "message", "retryable", "severity", "correlationId", "rawPathExposed",
]);
const provenanceFieldSet = new Set([
  "engine", "modelId", "fallbackUsed", "fallbackReason", "promptVersion", "generatedAt",
]);
const collectionFieldSet = new Set([
  "jobs", "jobCount", "activeCount", "persistenceState", "persistenceFailureCode",
  "encryptedAtRest", "recordingPriorityActive", "rawPathExposed", "keyMaterialExposedToRenderer",
]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasOnlyFields(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((field) => allowed.has(field));
}

function validOptionalIdentifier(value: unknown): boolean {
  return value === undefined || value === null
    || (typeof value === "string" && safeIdentifierPattern.test(value));
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && !Number.isNaN(Date.parse(value));
}

function parseProgress(value: unknown): BackgroundTaskProgress | null {
  if (value === undefined || value === null) return null;
  const progress = record(value);
  if (
    !progress
    || !hasOnlyFields(progress, progressFieldSet)
    || !Number.isSafeInteger(progress.completed)
    || Number(progress.completed) < 0
    || typeof progress.unit !== "string"
    || !unitSet.has(progress.unit)
  ) {
    throw invalidTask();
  }
  if (progress.total !== undefined && progress.total !== null) {
    if (!Number.isSafeInteger(progress.total) || Number(progress.total) < Number(progress.completed)) {
      throw invalidTask();
    }
  }
  if (
    progress.unit === "percent"
    && (Number(progress.completed) > 100
      || (progress.total !== undefined && progress.total !== null && Number(progress.total) !== 100))
  ) {
    throw invalidTask();
  }
  return {
    completed: Number(progress.completed),
    total: progress.total === undefined || progress.total === null ? null : Number(progress.total),
    unit: progress.unit as BackgroundProgressUnit,
  };
}

function parseError(value: unknown, state: BackgroundTaskState, jobId: string): BackgroundTaskError | null {
  if (state !== "failed") {
    if (value !== undefined && value !== null) throw invalidTask();
    return null;
  }
  const error = record(value);
  if (
    !error
    || !hasOnlyFields(error, errorFieldSet)
    || typeof error.code !== "string"
    || !safeErrorCodePattern.test(error.code)
    || typeof error.title !== "string"
    || error.title.length < 1
    || error.title.length > 160
    || typeof error.message !== "string"
    || error.message.length < 1
    || error.message.length > 1_000
    || typeof error.retryable !== "boolean"
    || error.severity !== "error"
    || error.correlationId !== jobId
    || error.rawPathExposed !== false
  ) {
    throw invalidTask();
  }
  return {
    code: error.code,
    title: error.title,
    message: error.message,
    retryable: error.retryable,
    severity: "error",
    correlationId: jobId,
    rawPathExposed: false,
  };
}

function parseProvenance(value: unknown): AiProvenance | null {
  if (value === undefined || value === null) return null;
  const provenance = record(value);
  if (
    !provenance
    || !hasOnlyFields(provenance, provenanceFieldSet)
    || (provenance.engine !== "local-llm" && provenance.engine !== "heuristic")
    || typeof provenance.fallbackUsed !== "boolean"
    || !validOptionalIdentifier(provenance.modelId)
    || typeof provenance.promptVersion !== "string"
    || !safePromptVersionPattern.test(provenance.promptVersion)
    || !validTimestamp(provenance.generatedAt)
    || (provenance.fallbackReason !== undefined
      && provenance.fallbackReason !== null
      && (typeof provenance.fallbackReason !== "string" || !fallbackReasonSet.has(provenance.fallbackReason)))
    || (provenance.fallbackUsed && typeof provenance.fallbackReason !== "string")
    || (!provenance.fallbackUsed && provenance.fallbackReason !== undefined && provenance.fallbackReason !== null)
    || (provenance.engine === "local-llm" && typeof provenance.modelId !== "string")
    || (provenance.engine === "local-llm" && provenance.fallbackUsed)
    || (provenance.engine === "heuristic" && provenance.modelId !== undefined && provenance.modelId !== null)
    || (provenance.engine === "heuristic" && !provenance.fallbackUsed)
  ) {
    throw invalidTask();
  }
  return {
    engine: provenance.engine,
    modelId: provenance.modelId === undefined || provenance.modelId === null
      ? null
      : provenance.modelId as string,
    fallbackUsed: provenance.fallbackUsed,
    fallbackReason: provenance.fallbackReason === undefined || provenance.fallbackReason === null
      ? null
      : provenance.fallbackReason as AiProvenance["fallbackReason"],
    promptVersion: provenance.promptVersion,
    generatedAt: provenance.generatedAt as string,
  };
}

function invalidTask(): CoreClientError {
  return new CoreClientError(
    "CORE_PROTOCOL_FAULT",
    "candor-core returned an invalid background task",
    false,
  );
}

export function parseBackgroundTask(value: unknown): BackgroundTask {
  const task = record(value);
  if (!task || !hasOnlyFields(task, taskFieldSet)) throw invalidTask();
  const jobId = typeof task.jobId === "string" ? task.jobId : "";
  const kind = typeof task.type === "string" ? task.type : "";
  const state = typeof task.state === "string" ? task.state : "";
  if (
    !/^[a-f0-9]{32}$/.test(jobId)
    || !kindSet.has(kind)
    || !stateSet.has(state)
    || !validTimestamp(task.createdAt)
    || !validTimestamp(task.updatedAt)
    || (task.stage !== undefined
      && task.stage !== null
      && (typeof task.stage !== "string" || !safeStagePattern.test(task.stage)))
    || !validOptionalIdentifier(task.recordingId)
    || (task.parentJobId !== undefined
      && task.parentJobId !== null
      && (typeof task.parentJobId !== "string" || !/^[a-f0-9]{32}$/.test(task.parentJobId)))
    || (task.resultAvailableAfterRestart !== undefined
      && typeof task.resultAvailableAfterRestart !== "boolean")
    || typeof task.cancelRequested !== "boolean"
    || !Number.isSafeInteger(task.retryCount)
    || Number(task.retryCount) < 0
    || typeof task.retryable !== "boolean"
    || typeof task.terminal !== "boolean"
    || task.terminal !== terminalStateSet.has(state as BackgroundTaskState)
    || task.sourceDataPreserved !== true
    || task.rawPathExposed !== false
    || task.keyMaterialExposedToRenderer !== false
  ) {
    throw invalidTask();
  }
  if (task.estimatedRemainingMs !== undefined && task.estimatedRemainingMs !== null) {
    if (
      state !== "running"
      || !Number.isSafeInteger(task.estimatedRemainingMs)
      || Number(task.estimatedRemainingMs) < 0
    ) {
      throw invalidTask();
    }
  }
  const parsedState = state as BackgroundTaskState;
  const cancellationState = parsedState === "cancelling" || parsedState === "cancelled";
  const recordingPreemption = parsedState === "cancelling"
    && task.stage === "yielding-to-recording"
    && task.cancelRequested === false;
  const retryableState = parsedState === "paused"
    || parsedState === "failed"
    || parsedState === "cancelled";
  if (
    (task.cancelRequested !== cancellationState && !recordingPreemption)
    || (task.retryable && !retryableState)
    || (parsedState === "paused" && !task.retryable)
  ) {
    throw invalidTask();
  }
  if (parsedState !== "completed" && task.result !== undefined && task.result !== null) {
    throw invalidTask();
  }
  let result = task.result as JsonValue;
  if (parsedState === "completed" && task.result !== undefined && task.result !== null) {
    try {
      const validated = validateCompletedJobResult(task as unknown as JsonValue);
      result = record(validated)?.result as JsonValue;
    } catch {
      throw invalidTask();
    }
  }
  const progress = parseProgress(task.progress);
  const error = parseError(task.error, parsedState, jobId);
  const provenance = parseProvenance(task.provenance);
  if (
    (task.engine !== undefined
      && task.engine !== null
      && task.engine !== "local-llm"
      && task.engine !== "heuristic")
    || (task.fallbackUsed !== undefined
      && task.fallbackUsed !== null
      && typeof task.fallbackUsed !== "boolean")
    || (provenance !== null
      && task.engine !== undefined
      && task.engine !== provenance.engine)
    || (provenance !== null
      && task.fallbackUsed !== undefined
      && task.fallbackUsed !== provenance.fallbackUsed)
    || (provenance === null && task.engine !== undefined && task.engine !== null)
    || (provenance === null && task.fallbackUsed !== undefined && task.fallbackUsed !== null)
    || (parsedState === "failed" && error?.retryable !== task.retryable)
  ) {
    throw invalidTask();
  }
  return {
    jobId,
    type: kind as BackgroundTaskKind,
    state: parsedState,
    createdAt: String(task.createdAt),
    updatedAt: String(task.updatedAt),
    stage: task.stage === undefined || task.stage === null ? null : String(task.stage),
    progress,
    estimatedRemainingMs: task.estimatedRemainingMs === undefined || task.estimatedRemainingMs === null
      ? null
      : Number(task.estimatedRemainingMs),
    recordingId: task.recordingId === undefined || task.recordingId === null
      ? null
      : String(task.recordingId),
    parentJobId: task.parentJobId === undefined || task.parentJobId === null
      ? null
      : String(task.parentJobId),
    result,
    resultAvailableAfterRestart: task.resultAvailableAfterRestart === true,
    error,
    provenance,
    cancelRequested: Boolean(task.cancelRequested),
    retryCount: Number(task.retryCount),
    retryable: Boolean(task.retryable),
    terminal: Boolean(task.terminal),
    sourceDataPreserved: true,
    rawPathExposed: false,
    keyMaterialExposedToRenderer: false,
  };
}

export function parseBackgroundTaskCollection(value: unknown): JsonValue {
  const collection = record(value);
  if (
    !collection
    || !hasOnlyFields(collection, collectionFieldSet)
    || !Array.isArray(collection.jobs)
    || collection.jobs.length > 256
  ) {
    throw invalidTask();
  }
  const jobs = collection.jobs.map(parseBackgroundTask);
  if (new Set(jobs.map((task) => task.jobId)).size !== jobs.length) throw invalidTask();
  if (!Number.isSafeInteger(collection.activeCount) || Number(collection.activeCount) < 0) {
    throw invalidTask();
  }
  const activeCount = Number(collection.activeCount);
  if (activeCount !== jobs.filter((task) => !task.terminal).length) throw invalidTask();
  if (
    (collection.jobCount !== undefined
      && (!Number.isSafeInteger(collection.jobCount) || Number(collection.jobCount) !== jobs.length))
    || (collection.persistenceState !== undefined
      && collection.persistenceState !== "memory-only"
      && collection.persistenceState !== "unavailable"
      && collection.persistenceState !== "encrypted")
    || (collection.persistenceFailureCode !== undefined
      && collection.persistenceFailureCode !== null
      && (typeof collection.persistenceFailureCode !== "string"
        || !safeErrorCodePattern.test(collection.persistenceFailureCode)))
    || (collection.encryptedAtRest !== undefined && typeof collection.encryptedAtRest !== "boolean")
    || (collection.recordingPriorityActive !== undefined
      && typeof collection.recordingPriorityActive !== "boolean")
    || collection.rawPathExposed !== false
    || (collection.keyMaterialExposedToRenderer !== undefined
      && collection.keyMaterialExposedToRenderer !== false)
  ) {
    throw invalidTask();
  }
  return {
    jobs: jobs as unknown as JsonValue[],
    activeCount,
    ...(collection.jobCount === undefined ? {} : { jobCount: Number(collection.jobCount) }),
    ...(collection.persistenceState === undefined
      ? {}
      : { persistenceState: String(collection.persistenceState) }),
    ...(collection.persistenceFailureCode === undefined
      ? {}
      : { persistenceFailureCode: collection.persistenceFailureCode as JsonValue }),
    ...(collection.encryptedAtRest === undefined
      ? {}
      : { encryptedAtRest: Boolean(collection.encryptedAtRest) }),
    ...(collection.recordingPriorityActive === undefined
      ? {}
      : { recordingPriorityActive: Boolean(collection.recordingPriorityActive) }),
    rawPathExposed: false,
    ...(collection.keyMaterialExposedToRenderer === undefined
      ? {}
      : { keyMaterialExposedToRenderer: false }),
  };
}

export function validateBackgroundTaskCollection(value: unknown): void {
  parseBackgroundTaskCollection(value);
}
