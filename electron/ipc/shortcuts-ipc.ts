import { ipcMain, type IpcMainInvokeEvent } from "electron";
import type { GlobalShortcutService } from "../shortcuts/global-shortcut-service.js";
import { validateIpcSender, type MainWindowProvider } from "../security/validate-sender.js";
import type { IpcHandlerRegistrar } from "./setup-ipc.js";

export const SHORTCUTS_IPC_CHANNELS = Object.freeze({
  getStatus: "candor-shortcuts:getStatus",
  update: "candor-shortcuts:update",
  reset: "candor-shortcuts:reset",
});

export interface ShortcutsIpcDependencies {
  shortcuts: Pick<GlobalShortcutService, "initialize" | "configure" | "reset">;
  getMainWindow: MainWindowProvider;
  ipc?: IpcHandlerRegistrar;
  validateSender?: typeof validateIpcSender;
}

function configurationInput(value: unknown): { enabled: boolean; accelerator?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Shortcut request must be an object.");
  }
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((field) => field !== "enabled" && field !== "accelerator")) {
    throw new Error("Shortcut request contains an unsupported field.");
  }
  if (typeof object.enabled !== "boolean") throw new Error("Shortcut enabled state is invalid.");
  if (object.accelerator !== undefined) {
    if (typeof object.accelerator !== "string" || object.accelerator.length > 64) {
      throw new Error("Shortcut accelerator is invalid.");
    }
    return { enabled: object.enabled, accelerator: object.accelerator };
  }
  return { enabled: object.enabled };
}

export function registerShortcutsIpc(dependencies: ShortcutsIpcDependencies): () => void {
  const registrar = dependencies.ipc ?? ipcMain as unknown as IpcHandlerRegistrar;
  const validateSender = dependencies.validateSender ?? validateIpcSender;

  registrar.handle(SHORTCUTS_IPC_CHANNELS.getStatus, async (event: IpcMainInvokeEvent) => {
    validateSender(event, dependencies.getMainWindow);
    return dependencies.shortcuts.initialize();
  });
  registrar.handle(SHORTCUTS_IPC_CHANNELS.update, async (event: IpcMainInvokeEvent, value) => {
    validateSender(event, dependencies.getMainWindow);
    return dependencies.shortcuts.configure(configurationInput(value));
  });
  registrar.handle(SHORTCUTS_IPC_CHANNELS.reset, async (event: IpcMainInvokeEvent) => {
    validateSender(event, dependencies.getMainWindow);
    return dependencies.shortcuts.reset();
  });

  return () => {
    Object.values(SHORTCUTS_IPC_CHANNELS).forEach((channel) => registrar.removeHandler(channel));
  };
}
