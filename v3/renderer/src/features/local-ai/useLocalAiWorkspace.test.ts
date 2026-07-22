import { describe, expect, it, vi } from "vitest";
import {
  parseModels,
  parseTranscriptionQualityStatus,
  type BundledAiStatus,
} from "../../core/contracts";
import {
  benchmarkRetryRequired,
  prepareTranscriptHandoff,
  recordingScopedRecapRequest,
  shouldStartAutomaticBenchmark,
  speechModelForBundledDefault,
} from "./useLocalAiWorkspace";

function bundledStatus(modelId: string, ready = true): BundledAiStatus {
  return {
    releaseReady: ready,
    fixture: false,
    selectionStatus: ready ? "release-selected" : "no-default-selected",
    state: ready ? "ready" : "no-default-selected",
    ready,
    repairRequired: false,
    repairPolicy: "signed-installer-only",
    repairAction: "none",
    speech: {
      state: ready ? "ready" : "no-default-selected",
      ready,
      available: ready,
      requiredAssets: ready ? 1 : 0,
      verifiedAssets: ready ? 1 : 0,
      modelId: ready ? modelId : null,
      failureCode: null,
    },
    language: {
      state: ready ? "ready" : "no-default-selected",
      ready,
      available: ready,
      requiredAssets: ready ? 2 : 0,
      verifiedAssets: ready ? 2 : 0,
      modelId: ready ? "local-language" : null,
      failureCode: null,
    },
  };
}

describe("local AI model state", () => {
  it("waits for the cleanup handoff and discloses original-transcript fallback", async () => {
    const cleanupTranscript = vi.fn().mockResolvedValue({
      jobId: "a".repeat(32),
    });
    const getJob = vi.fn().mockResolvedValue({
      jobId: "a".repeat(32),
      type: "transcript-cleanup",
      state: "completed",
      terminal: true,
      result: { fallbackApplied: true },
    });
    const api = {
      ai: { cleanupTranscript },
      app: { getJob, acknowledgeJob: vi.fn().mockResolvedValue(undefined) },
      events: { subscribe: vi.fn().mockReturnValue(() => undefined) },
    } as unknown as NonNullable<Window["candor"]>;

    await expect(prepareTranscriptHandoff(api, "recording-a")).resolves.toBe("original");
    expect(cleanupTranscript).toHaveBeenCalledWith("recording-a");
    expect(getJob).toHaveBeenCalledWith("a".repeat(32));
  });

  it("rejects malformed model metadata instead of inventing readiness", () => {
    expect(() => parseModels({ models: [{ modelId: "base.en", installed: true }] }))
      .toThrow(/protocol error/i);
  });

  it("follows a verified packaged speech default without replacing an explicit choice", () => {
    const packaged = bundledStatus("small.en");
    expect(speechModelForBundledDefault("base.en", packaged)).toBe("small.en");
    expect(speechModelForBundledDefault("tiny.en", packaged, true)).toBe("tiny.en");
    expect(speechModelForBundledDefault("base.en", bundledStatus("small.en", false))).toBe("base.en");
  });

  it("leaves recap template selection bound to the recording in core", () => {
    expect(recordingScopedRecapRequest("recording-a", "default")).toEqual({
      recordingId: "recording-a",
      intent: "default",
    });
    expect(recordingScopedRecapRequest("recording-a", "default")).not.toHaveProperty("recapTemplate");
  });

  it("starts the automatic benchmark only for ready idle installs without prior work", () => {
    const ready = {
      bundledReady: true,
      benchmarkState: "not-run" as const,
      activeCapture: false,
      benchmarkJobActive: false,
      benchmarkNeedsRetry: false,
      completedJobAwaitingRefresh: false,
      balancedNeedsFreshBenchmark: false,
    };
    expect(shouldStartAutomaticBenchmark(ready)).toBe(true);
    expect(shouldStartAutomaticBenchmark({ ...ready, bundledReady: false })).toBe(false);
    expect(shouldStartAutomaticBenchmark({ ...ready, activeCapture: true })).toBe(false);
    expect(shouldStartAutomaticBenchmark({ ...ready, benchmarkJobActive: true })).toBe(false);
    expect(shouldStartAutomaticBenchmark({ ...ready, benchmarkNeedsRetry: true })).toBe(false);
    expect(shouldStartAutomaticBenchmark({ ...ready, completedJobAwaitingRefresh: true })).toBe(false);
    expect(shouldStartAutomaticBenchmark({ ...ready, benchmarkState: "failed" })).toBe(false);
    expect(shouldStartAutomaticBenchmark({ ...ready, benchmarkState: "measured" })).toBe(false);
    expect(shouldStartAutomaticBenchmark({
      ...ready,
      benchmarkState: "measured",
      balancedNeedsFreshBenchmark: true,
    })).toBe(true);
  });

  it("does not let an acknowledged older failure shadow a measured retry", () => {
    const measured = parseTranscriptionQualityStatus({
      implemented: true,
      state: "ready",
      tier: "balanced",
      languagePreference: "english",
      recommendedTier: "balanced",
      benchmarkState: "measured",
      benchmarkFailureTier: null,
      estimatedRealTimeFactor: null,
      estimatedMinutesPerHour: 15,
      estimatedCompletionAvailable: true,
      fallbackApplied: false,
      guardReason: null,
      hardware: {
        totalMemoryBytes: 16 * 1024 * 1024 * 1024,
        logicalCpuCount: 8,
        operatingSystem: "windows",
        architecture: "x64",
        accelerationState: "not-measured",
      },
      tiers: [
        { id: "fast", label: "Fast", available: true, recommended: false, guardReason: null },
        { id: "balanced", label: "Balanced", available: true, recommended: true, guardReason: null },
        { id: "maximum", label: "Maximum accuracy", available: false, recommended: false, guardReason: "maximum-requires-passing-local-benchmark" },
      ],
      localOnly: true,
      cloudAi: false,
      rawModelNamesExposed: false,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    });
    const oldFailure: BackgroundTask = {
      jobId: "a".repeat(32),
      type: "local-ai-benchmark",
      state: "failed",
      createdAt: "2026-07-14T05:00:00Z",
      updatedAt: "2026-07-14T05:00:01Z",
      error: {
        code: "BENCHMARK_FAILED",
        title: "Performance check failed",
        message: "The local performance check failed.",
        retryable: true,
        severity: "error",
        correlationId: "a".repeat(32),
        rawPathExposed: false,
      },
      cancelRequested: false,
      retryCount: 0,
      retryable: true,
      terminal: true,
      sourceDataPreserved: true,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
    expect(benchmarkRetryRequired(measured, oldFailure)).toBe(false);
    expect(benchmarkRetryRequired({ ...measured, benchmarkState: "not-run" }, oldFailure)).toBe(true);
  });
});

