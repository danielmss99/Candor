import { describe, expect, it } from "vitest";
import { parseModels, type BundledAiStatus } from "../../core/contracts";
import { speechModelForBundledDefault } from "./useLocalAiWorkspace";

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
});

