import { describe, expect, it } from "vitest";
import {
  AcceleratorPolicyError,
  SUGGESTED_RECORDER_ACCELERATOR,
  isAllowedAccelerator,
  normalizeAccelerator,
} from "./accelerator-policy.js";

describe("accelerator policy", () => {
  it("accepts and canonicalizes bounded cross-platform accelerators", () => {
    expect(normalizeAccelerator(" shift + cmdorctrl + space ")).toBe(SUGGESTED_RECORDER_ACCELERATOR);
    expect(normalizeAccelerator("control+alt+f12")).toBe("Control+Alt+F12");
    expect(normalizeAccelerator("shift+super+7")).toBe("Shift+Super+7");
    expect(isAllowedAccelerator("CommandOrControl+Shift+R")).toBe(true);
  });

  it.each([
    ["", "ACCELERATOR_REQUIRED"],
    ["Shift+Space", "ACCELERATOR_SYSTEM_MODIFIER_REQUIRED"],
    ["Control+R", "ACCELERATOR_TWO_MODIFIERS_REQUIRED"],
    ["Control+Control+R", "ACCELERATOR_DUPLICATE_MODIFIER"],
    ["CommandOrControl+Control+R", "ACCELERATOR_MODIFIER_CONFLICT"],
    ["Control+R+T", "ACCELERATOR_MULTIPLE_PRIMARY_KEYS"],
    ["Control+VolumeUp", "ACCELERATOR_INVALID_TOKEN"],
    ["Control+", "ACCELERATOR_INVALID_TOKEN"],
    ["Alt+F4", "ACCELERATOR_RESERVED"],
    ["CommandOrControl+Q", "ACCELERATOR_RESERVED"],
    ["CommandOrControl+Alt+Delete", "ACCELERATOR_RESERVED"],
    ["Control+Alt+Delete", "ACCELERATOR_RESERVED"],
    ["Control+Shift+Escape", "ACCELERATOR_RESERVED"],
    ["CommandOrControl+Shift+Escape", "ACCELERATOR_RESERVED"],
    ["Command+Option+Escape", "ACCELERATOR_RESERVED"],
    ["Command+Control+Q", "ACCELERATOR_RESERVED"],
    ["Control+Alt+Tab", "ACCELERATOR_RESERVED"],
    ["Alt+Shift+Tab", "ACCELERATOR_RESERVED"],
    ["Super+Shift+S", "ACCELERATOR_RESERVED"],
  ])("rejects unsafe accelerator %s", (accelerator, code) => {
    try {
      normalizeAccelerator(accelerator);
      throw new Error("expected accelerator validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AcceleratorPolicyError);
      expect(error).toMatchObject({ code });
    }
  });

  it("rejects control characters and oversized values", () => {
    expect(() => normalizeAccelerator("Control+R\nAlt+T")).toThrow("unsupported characters");
    expect(() => normalizeAccelerator(`Control+${"R".repeat(80)}`)).toThrow("too long");
  });
});
