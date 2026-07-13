import { describe, expect, it } from "vitest";
import { inactiveLicenseStep } from "./useOnboardingSettings";

describe("onboarding data access", () => {
  it("skips activation whenever local recordings already exist", () => {
    expect(inactiveLicenseStep(1, false)).toBe("app");
    expect(inactiveLicenseStep(0, true)).toBe("app");
    expect(inactiveLicenseStep(0, false)).toBe("activate");
  });
});

