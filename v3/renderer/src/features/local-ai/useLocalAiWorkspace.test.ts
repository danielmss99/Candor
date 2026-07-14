import { describe, expect, it } from "vitest";
import {
  parseModels,
  parseTranscriptionQualityStatus,
  type BundledAiStatus,
} from "../../core/contracts";
import {
  benchmarkRetryRequired,
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
    const oldFailure = { type: "local-ai-benchmark", state: "failed", terminal: true };
    expect(benchmarkRetryRequired(measured, oldFailure)).toBe(false);
    expect(benchmarkRetryRequired({ ...measured, benchmarkState: "not-run" }, oldFailure)).toBe(true);
  });
});

