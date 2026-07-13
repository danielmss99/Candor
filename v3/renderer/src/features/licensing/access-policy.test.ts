import { describe, expect, it } from "vitest";
import { canAccessExistingData, shouldShowActivationPrompt } from "./access-policy";

describe("license access policy", () => {
  it("never locks existing data behind activation", () => {
    expect(canAccessExistingData(false)).toBe(true);
    expect(shouldShowActivationPrompt({
      licenseAvailable: true,
      licenseActive: false,
      promptDismissed: false,
      existingRecordingCount: 3,
    })).toBe(false);
  });

  it("keeps activation optional on an empty first run", () => {
    expect(shouldShowActivationPrompt({
      licenseAvailable: true,
      licenseActive: false,
      promptDismissed: false,
      existingRecordingCount: 0,
    })).toBe(true);
    expect(shouldShowActivationPrompt({
      licenseAvailable: true,
      licenseActive: false,
      promptDismissed: true,
      existingRecordingCount: 0,
    })).toBe(false);
  });
});

