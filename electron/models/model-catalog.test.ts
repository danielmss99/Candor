import { describe, expect, it } from "vitest";
import { publicModelEntry, trustedModel, TRUSTED_MODEL_CATALOG } from "./model-catalog.js";

describe("trusted local model catalog", () => {
  it("keeps every renderer entry pathless and hides download URLs", () => {
    for (const entry of TRUSTED_MODEL_CATALOG) {
      const publicEntry = publicModelEntry(entry);
      expect(publicEntry).toMatchObject({
        modelId: entry.modelId,
        urlExposed: false,
        rawPathExposed: false,
        keyMaterialExposedToRenderer: false,
      });
      expect(publicEntry).not.toHaveProperty("url");
      expect(JSON.stringify(publicEntry)).not.toContain("https://");
    }
  });

  it("makes Parakeet a pinned downloadable and default-eligible local model", () => {
    const parakeet = trustedModel("parakeet-tdt-0.6b-v3-int8");
    expect(parakeet).toMatchObject({
      publisher: "NVIDIA",
      releaseState: "ready",
      defaultEligible: true,
      expectedSha256: "5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf",
      bytes: 487_170_055,
    });
    expect(parakeet?.download?.url).toContain("sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2");
    expect(publicModelEntry(parakeet!)).toMatchObject({
      downloadAvailable: true,
      urlExposed: false,
    });
  });

  it("pins downloadable models to immutable revisions, sizes, and SHA-256 values", () => {
    const downloadable = TRUSTED_MODEL_CATALOG.filter((entry) => entry.releaseState === "ready");
    expect(downloadable.length).toBeGreaterThan(0);
    for (const entry of downloadable) {
      expect(entry.revision).not.toContain("pending");
      expect(entry.expectedSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(entry.bytes).toBeGreaterThan(0);
      const url = new URL(entry.download!.url);
      expect(entry.download?.allowedHosts).toContain(url.hostname);
    }
  });
});
