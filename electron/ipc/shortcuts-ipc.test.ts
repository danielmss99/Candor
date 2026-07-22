import type { IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";
import { SHORTCUTS_IPC_CHANNELS, registerShortcutsIpc } from "./shortcuts-ipc.js";
import type { IpcHandlerRegistrar } from "./setup-ipc.js";

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
  schemaVersion: 1 as const,
  enabled: false,
  accelerator: "CommandOrControl+Shift+Space",
  suggestedAccelerator: "CommandOrControl+Shift+Space" as const,
  registered: false,
  state: "disabled" as const,
  activationBehavior: "show-and-focus-recorder" as const,
  recordsAudio: false as const,
  localOnly: true as const,
  rawPathExposed: false as const,
  keyMaterialExposedToRenderer: false as const,
};

describe("shortcuts IPC", () => {
  it("validates senders and exposes status and configuration only", async () => {
    const ipc = new FakeRegistrar();
    const validateSender = vi.fn();
    const shortcuts = {
      initialize: vi.fn().mockResolvedValue(status),
      configure: vi.fn().mockResolvedValue({ ...status, enabled: true, registered: true, state: "registered" }),
      reset: vi.fn().mockResolvedValue(status),
    };
    const cleanup = registerShortcutsIpc({ ipc, shortcuts, getMainWindow: () => null, validateSender });
    await expect(ipc.invoke(SHORTCUTS_IPC_CHANNELS.getStatus)).resolves.toEqual(status);
    await ipc.invoke(SHORTCUTS_IPC_CHANNELS.update, {
      enabled: true,
      accelerator: "CommandOrControl+Shift+R",
    });
    await ipc.invoke(SHORTCUTS_IPC_CHANNELS.reset);
    expect(validateSender).toHaveBeenCalledTimes(3);
    expect(shortcuts.configure).toHaveBeenCalledWith({
      enabled: true,
      accelerator: "CommandOrControl+Shift+R",
    });
    expect(shortcuts.reset).toHaveBeenCalledTimes(1);
    cleanup();
    expect(ipc.removed).toEqual(Object.values(SHORTCUTS_IPC_CHANNELS));
  });

  it("rejects malformed and expansive configuration payloads", async () => {
    const ipc = new FakeRegistrar();
    const shortcuts = { initialize: vi.fn().mockResolvedValue(status), configure: vi.fn(), reset: vi.fn() };
    registerShortcutsIpc({ ipc, shortcuts, getMainWindow: () => null, validateSender: vi.fn() });
    await expect(ipc.invoke(SHORTCUTS_IPC_CHANNELS.update, { enabled: "yes" }))
      .rejects.toThrow("enabled state is invalid");
    await expect(ipc.invoke(SHORTCUTS_IPC_CHANNELS.update, { enabled: true, command: "record" }))
      .rejects.toThrow("unsupported field");
    await expect(ipc.invoke(SHORTCUTS_IPC_CHANNELS.update, {
      enabled: true,
      accelerator: "R".repeat(65),
    })).rejects.toThrow("accelerator is invalid");
    expect(shortcuts.configure).not.toHaveBeenCalled();
  });

  it("does not initialize shortcuts for an untrusted sender", async () => {
    const ipc = new FakeRegistrar();
    const shortcuts = { initialize: vi.fn().mockResolvedValue(status), configure: vi.fn(), reset: vi.fn() };
    registerShortcutsIpc({
      ipc,
      shortcuts,
      getMainWindow: () => null,
      validateSender: () => { throw new Error("untrusted sender"); },
    });
    await expect(ipc.invoke(SHORTCUTS_IPC_CHANNELS.getStatus)).rejects.toThrow("untrusted sender");
    expect(shortcuts.initialize).not.toHaveBeenCalled();
  });
});
