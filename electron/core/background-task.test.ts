import { describe, expect, it } from "vitest";
import {
  parseBackgroundTask,
  parseBackgroundTaskCollection,
  type BackgroundTaskState,
} from "./background-task.js";

const jobId = "a".repeat(32);

function task(state: BackgroundTaskState): Record<string, unknown> {
  const terminal = state === "completed" || state === "failed" || state === "cancelled";
  const completedResult = {
    format: "pdf",
    fileName: "report.pdf",
    bytes: 10,
    rawPathExposed: false,
  };
  return {
    jobId,
    type: state === "completed" ? "export" : "recap",
    state,
    createdAt: "2026-07-14T12:00:00Z",
    updatedAt: "2026-07-14T12:00:01Z",
    stage: state,
    progress: state === "running" ? { completed: 25, total: 100, unit: "percent" } : null,
    estimatedRemainingMs: state === "running" ? 5_000 : null,
    recordingId: "recording-1",
    parentJobId: null,
    result: state === "completed" ? completedResult : null,
    error: state === "failed" ? {
      code: "LOCAL_AI_FAILED",
      title: "Local work failed",
      message: "The local task could not be completed.",
      retryable: true,
      severity: "error",
      correlationId: jobId,
      rawPathExposed: false,
    } : null,
    provenance: null,
    engine: null,
    fallbackUsed: null,
    resultAvailableAfterRestart: false,
    cancelRequested: state === "cancelling" || state === "cancelled",
    retryCount: 0,
    retryable: state === "failed" || state === "paused",
    terminal,
    sourceDataPreserved: true,
    rawPathExposed: false,
    keyMaterialExposedToRenderer: false,
  };
}

describe("background task boundary", () => {
  it("accepts every supported state with exact terminal semantics", () => {
    const states: BackgroundTaskState[] = [
      "queued",
      "running",
      "paused",
      "cancelling",
      "completed",
      "failed",
      "cancelled",
    ];
    expect(states.map((state) => parseBackgroundTask(task(state)).state)).toEqual(states);
    expect(parseBackgroundTask({ ...task("completed"), result: null }).state).toBe("completed");
  });

  it("allows an ETA only for a running task", () => {
    expect(parseBackgroundTask(task("running")).estimatedRemainingMs).toBe(5_000);
    expect(() => parseBackgroundTask({ ...task("queued"), estimatedRemainingMs: 5_000 }))
      .toThrow("invalid background task");
  });

  it("distinguishes recording preemption from a user cancellation request", () => {
    const preempting = {
      ...task("cancelling"),
      stage: "yielding-to-recording",
      cancelRequested: false,
    };
    expect(parseBackgroundTask(preempting)).toMatchObject({
      state: "cancelling",
      stage: "yielding-to-recording",
      cancelRequested: false,
    });
    expect(() => parseBackgroundTask({
      ...preempting,
      stage: "stopping",
    })).toThrow("invalid background task");
  });

  it("rejects malformed states, units, failures, and terminal flags", () => {
    expect(() => parseBackgroundTask({ ...task("queued"), state: "almost-done" }))
      .toThrow("invalid background task");
    expect(() => parseBackgroundTask({
      ...task("running"),
      progress: { completed: 1, total: 2, unit: "stage" },
    })).toThrow("invalid background task");
    expect(() => parseBackgroundTask({
      ...task("running"),
      progress: { completed: 101, total: 101, unit: "percent" },
    })).toThrow("invalid background task");
    expect(() => parseBackgroundTask({
      ...task("running"),
      progress: { completed: 25, total: 50, unit: "percent" },
    })).toThrow("invalid background task");
    expect(() => parseBackgroundTask({ ...task("failed"), error: null }))
      .toThrow("invalid background task");
    const failed = task("failed");
    expect(() => parseBackgroundTask({
      ...failed,
      error: { ...(failed.error as object), retryable: false },
    })).toThrow("invalid background task");
    expect(() => parseBackgroundTask({ ...task("completed"), terminal: false }))
      .toThrow("invalid background task");
    expect(() => parseBackgroundTask({ ...task("queued"), cancelRequested: true }))
      .toThrow("invalid background task");
    expect(() => parseBackgroundTask({ ...task("cancelled"), cancelRequested: false }))
      .toThrow("invalid background task");
    expect(() => parseBackgroundTask({ ...task("running"), retryable: true }))
      .toThrow("invalid background task");
    expect(() => parseBackgroundTask({ ...task("paused"), retryable: false }))
      .toThrow("invalid background task");
    expect(() => parseBackgroundTask({
      ...task("completed"),
      result: { format: "pdf", fileName: "report.pdf", bytes: "ten", rawPathExposed: false },
    })).toThrow("invalid background task");
    expect(() => parseBackgroundTask({ ...task("running"), result: { content: "unexpected" } }))
      .toThrow("invalid background task");
    expect(() => parseBackgroundTask({ ...task("queued"), stage: "C:\\private\\task" }))
      .toThrow("invalid background task");
    expect(() => parseBackgroundTask({ ...task("queued"), recordingId: "../recording" }))
      .toThrow("invalid background task");
  });

  it("requires and canonicalizes AI provenance", () => {
    const provenance = {
      engine: "local-llm",
      modelId: "qwen3-4b-official-q4_k_m",
      fallbackUsed: false,
      fallbackReason: null,
      promptVersion: "candor-grounded-v1",
      generatedAt: "2026-07-14T12:00:01Z",
    };
    const parsed = parseBackgroundTask({
      ...task("running"),
      engine: "local-llm",
      fallbackUsed: false,
      provenance,
    });
    expect(parsed.provenance).toEqual({
      engine: "local-llm",
      modelId: "qwen3-4b-official-q4_k_m",
      fallbackUsed: false,
      fallbackReason: null,
      promptVersion: "candor-grounded-v1",
      generatedAt: "2026-07-14T12:00:01Z",
    });
    const heuristic = {
      ...provenance,
      engine: "heuristic",
      modelId: null,
      fallbackUsed: true,
      fallbackReason: "user-requested",
    };
    expect(parseBackgroundTask({
      ...task("running"),
      engine: "heuristic",
      fallbackUsed: true,
      provenance: heuristic,
    }).provenance).toEqual(heuristic);
    expect(() => parseBackgroundTask({
      ...task("running"),
      engine: "local-llm",
      fallbackUsed: false,
      provenance: { ...provenance, promptVersion: undefined },
    })).toThrow("invalid background task");
    expect(() => parseBackgroundTask({
      ...task("running"),
      engine: "local-llm",
      fallbackUsed: false,
      provenance: { ...provenance, transcript: "must not cross" },
    })).toThrow("invalid background task");
    expect(() => parseBackgroundTask({
      ...task("running"),
      engine: "local-llm",
      fallbackUsed: true,
      provenance: {
        ...provenance,
        fallbackUsed: true,
        fallbackReason: "runtime-failed",
      },
    })).toThrow("invalid background task");
    expect(() => parseBackgroundTask({
      ...task("running"),
      engine: "heuristic",
      fallbackUsed: true,
      provenance: {
        ...provenance,
        engine: "heuristic",
        fallbackUsed: true,
        fallbackReason: "user-requested",
      },
    })).toThrow("invalid background task");
  });

  it("rejects undeclared error fields and unsafe error codes", () => {
    const failed = task("failed");
    expect(() => parseBackgroundTask({
      ...failed,
      error: { ...(failed.error as object), transcript: "must not cross" },
    })).toThrow("invalid background task");
    expect(() => parseBackgroundTask({
      ...failed,
      error: { ...(failed.error as object), code: "../PRIVATE" },
    })).toThrow("invalid background task");
  });

  it("rejects undeclared task and progress fields", () => {
    expect(() => parseBackgroundTask({ ...task("queued"), transcript: "must not cross" }))
      .toThrow("invalid background task");
    expect(() => parseBackgroundTask({
      ...task("running"),
      progress: { completed: 1, total: 2, unit: "chunks", prompt: "must not cross" },
    })).toThrow("invalid background task");
  });

  it("rejects undeclared collection fields and inconsistent active counts", () => {
    expect(() => parseBackgroundTaskCollection({
      jobs: [task("running"), { ...task("completed"), jobId: "b".repeat(32) }],
      activeCount: 1,
      jobCount: 2,
      persistenceState: "encrypted",
      persistenceFailureCode: null,
      encryptedAtRest: true,
      recordingPriorityActive: false,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
      transcript: "must not cross",
    })).toThrow("invalid background task");
    expect(() => parseBackgroundTaskCollection({
      jobs: [task("running")],
      activeCount: 0,
      rawPathExposed: false,
    })).toThrow("invalid background task");
  });
});
