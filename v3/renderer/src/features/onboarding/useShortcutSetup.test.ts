import { describe, expect, it } from "vitest";
import { SUGGESTED_SHORTCUT } from "./setup-types";
import { parseShortcutStatus } from "./useShortcutSetup";
import { ShortcutTestGate } from "./shortcut-test-gate";

describe("global shortcut setup parsing", () => {
  it("defaults to the suggested disabled shortcut", () => {
    expect(parseShortcutStatus({})).toEqual({
      enabled: false,
      registered: false,
      accelerator: SUGGESTED_SHORTCUT,
      conflict: false,
      message: "",
    });
  });

  it("surfaces conflicts without naming another application", () => {
    expect(parseShortcutStatus({
      enabled: true,
      registered: false,
      accelerator: "CommandOrControl+Shift+Space",
      conflict: true,
      message: "The shortcut is unavailable.",
    })).toEqual({
      enabled: true,
      registered: false,
      accelerator: "CommandOrControl+Shift+Space",
      conflict: true,
      message: "The shortcut is unavailable.",
    });
  });

  it("accepts a shortcut test result only while explicitly armed", async () => {
    const gate = new ShortcutTestGate();
    expect(gate.consumeTrigger()).toBe(false);
    expect(gate.shouldSuppressRecorderOpen()).toBe(false);

    gate.arm();
    expect(gate.shouldSuppressRecorderOpen()).toBe(true);
    expect(gate.consumeTrigger()).toBe(true);
    expect(gate.consumeTrigger()).toBe(false);
    expect(gate.shouldSuppressRecorderOpen()).toBe(true);

    await Promise.resolve();
    expect(gate.shouldSuppressRecorderOpen()).toBe(false);
  });
});
