import { describe, expect, it } from "vitest";
import { isLicenseActive } from "./useLicenseState";

describe("license state", () => {
  it("treats only local trial and activated states as active", () => {
    expect(isLicenseActive({ state: "activated" })).toBe(true);
    expect(isLicenseActive({ state: "trial" })).toBe(true);
    expect(isLicenseActive({ state: "inactive" })).toBe(false);
    expect(isLicenseActive({})).toBe(false);
  });
});

