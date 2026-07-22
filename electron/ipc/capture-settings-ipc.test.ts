import { describe, expect, it, vi } from "vitest";
import {
  CAPTURE_SETTINGS_IPC_CHANNEL,
  microphoneSettingsUri,
  registerCaptureSettingsIpc,
} from "./capture-settings-ipc.js";

describe("capture settings IPC", () => {
  it("uses only fixed platform destinations", () => {
    expect(microphoneSettingsUri("win32")).toBe("ms-settings:privacy-microphone");
    expect(microphoneSettingsUri("darwin")).toContain("Privacy_Microphone");
    expect(microphoneSettingsUri("linux")).toBeNull();
  });

  it("validates the sender and rejects renderer supplied destinations", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const openExternal = vi.fn(async () => undefined);
    const validateSender = vi.fn();
    registerCaptureSettingsIpc({
      getMainWindow: () => null,
      platform: "win32",
      openExternal,
      validateSender,
      ipc: {
        handle: (channel, listener) => handlers.set(channel, listener),
        removeHandler: (channel) => handlers.delete(channel),
      },
    });
    const handler = handlers.get(CAPTURE_SETTINGS_IPC_CHANNEL);
    const event = {};
    await expect(handler?.(event, { uri: "https://example.com" })).rejects.toThrow("do not accept");
    expect(validateSender).toHaveBeenCalledWith(event, expect.any(Function));
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("opens the fixed Windows privacy page and returns pathless custody flags", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const openExternal = vi.fn(async () => undefined);
    registerCaptureSettingsIpc({
      getMainWindow: () => null,
      platform: "win32",
      openExternal,
      validateSender: vi.fn(),
      ipc: {
        handle: (channel, listener) => handlers.set(channel, listener),
        removeHandler: (channel) => handlers.delete(channel),
      },
    });
    await expect(handlers.get(CAPTURE_SETTINGS_IPC_CHANNEL)?.({}, null)).resolves.toEqual({
      opened: true,
      supported: true,
      platform: "win32",
      fixedDestination: true,
      localOnly: true,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    });
    expect(openExternal).toHaveBeenCalledWith("ms-settings:privacy-microphone");
  });
});
