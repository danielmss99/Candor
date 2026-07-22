import type { IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";
import { SETUP_IPC_CHANNELS, registerSetupIpc, type IpcHandlerRegistrar } from "./setup-ipc.js";

class FakeRegistrar implements IpcHandlerRegistrar {
  readonly handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  readonly removed: string[] = [];

  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void {
    this.handlers.set(channel, listener);
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel);
    this.removed.push(channel);
  }

  invoke(channel: string, value?: unknown): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`missing handler ${channel}`);
    return Promise.resolve(handler({} as IpcMainInvokeEvent, value));
  }
}

const status = {
  schemaVersion: 4 as const,
  setup: {
    progress: "not-started" as const,
    completed: [],
    deferred: [],
    lastStep: null,
    existingUserPromptShown: false,
    nonBlockingUpgrade: false,
  },
  localOnly: true as const,
  rawPathExposed: false as const,
  keyMaterialExposedToRenderer: false as const,
};

describe("setup IPC", () => {
  it("validates the sender and exposes narrow setup operations", async () => {
    const ipc = new FakeRegistrar();
    const validateSender = vi.fn();
    const preferences = {
      status: vi.fn().mockResolvedValue(status),
      visitStep: vi.fn().mockResolvedValue(status),
      updateStep: vi.fn().mockResolvedValue(status),
      deferStep: vi.fn().mockResolvedValue(status),
      completeSetup: vi.fn().mockResolvedValue(status),
      markExistingUserPromptShown: vi.fn().mockResolvedValue(status),
    };
    const cleanup = registerSetupIpc({
      ipc,
      preferences,
      getMainWindow: () => null,
      validateSender,
    });

    await expect(ipc.invoke(SETUP_IPC_CHANNELS.getStatus)).resolves.toEqual(status);
    await ipc.invoke(SETUP_IPC_CHANNELS.visit, { step: "microphone" });
    await ipc.invoke(SETUP_IPC_CHANNELS.updateStep, { step: "license", visit: "microphone" });
    await ipc.invoke(SETUP_IPC_CHANNELS.defer, { step: "shortcut" });
    await ipc.invoke(SETUP_IPC_CHANNELS.complete);
    await ipc.invoke(SETUP_IPC_CHANNELS.markExistingUserPromptShown);
    expect(validateSender).toHaveBeenCalledTimes(6);
    expect(preferences.visitStep).toHaveBeenCalledWith("microphone");
    expect(preferences.updateStep).toHaveBeenCalledWith("license", "microphone");
    expect(preferences.deferStep).toHaveBeenCalledWith("shortcut");
    expect(preferences.completeSetup).toHaveBeenCalledTimes(1);
    expect(preferences.markExistingUserPromptShown).toHaveBeenCalledTimes(1);

    cleanup();
    expect(ipc.removed).toEqual(Object.values(SETUP_IPC_CHANNELS));
  });

  it("rejects unknown fields, steps, and dispositions", async () => {
    const ipc = new FakeRegistrar();
    const preferences = {
      status: vi.fn().mockResolvedValue(status),
      visitStep: vi.fn().mockResolvedValue(status),
      updateStep: vi.fn().mockResolvedValue(status),
      deferStep: vi.fn().mockResolvedValue(status),
      completeSetup: vi.fn().mockResolvedValue(status),
      markExistingUserPromptShown: vi.fn().mockResolvedValue(status),
    };
    registerSetupIpc({ ipc, preferences, getMainWindow: () => null, validateSender: vi.fn() });
    await expect(ipc.invoke(SETUP_IPC_CHANNELS.visit, { step: "unknown" })).rejects.toThrow("step is invalid");
    await expect(ipc.invoke(SETUP_IPC_CHANNELS.visit, { step: "microphone", privatePath: "x" }))
      .rejects.toThrow("unsupported field");
    await expect(ipc.invoke(SETUP_IPC_CHANNELS.updateStep, { step: "unknown" })).rejects.toThrow("step is invalid");
    await expect(ipc.invoke(SETUP_IPC_CHANNELS.updateStep, { step: "license", privatePath: "x" }))
      .rejects.toThrow("unsupported field");
    await expect(ipc.invoke(SETUP_IPC_CHANNELS.updateStep, { step: "license", visit: "unknown" }))
      .rejects.toThrow("step is invalid");
    expect(preferences.updateStep).not.toHaveBeenCalled();
    expect(preferences.visitStep).not.toHaveBeenCalled();
  });

  it("does not call the preferences service when sender validation fails", async () => {
    const ipc = new FakeRegistrar();
    const preferences = {
      status: vi.fn().mockResolvedValue(status),
      visitStep: vi.fn().mockResolvedValue(status),
      updateStep: vi.fn().mockResolvedValue(status),
      deferStep: vi.fn().mockResolvedValue(status),
      completeSetup: vi.fn().mockResolvedValue(status),
      markExistingUserPromptShown: vi.fn().mockResolvedValue(status),
    };
    registerSetupIpc({
      ipc,
      preferences,
      getMainWindow: () => null,
      validateSender: () => { throw new Error("untrusted sender"); },
    });
    await expect(ipc.invoke(SETUP_IPC_CHANNELS.getStatus)).rejects.toThrow("untrusted sender");
    expect(preferences.status).not.toHaveBeenCalled();
  });
});
