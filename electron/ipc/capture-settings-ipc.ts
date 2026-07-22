import { ipcMain, shell, type IpcMainInvokeEvent } from "electron";
import { validateIpcSender, type MainWindowProvider } from "../security/validate-sender.js";
import type { IpcHandlerRegistrar } from "./setup-ipc.js";

export const CAPTURE_SETTINGS_IPC_CHANNEL = "candor-capture:openMicrophoneSettings";

export interface CaptureSettingsIpcDependencies {
  getMainWindow: MainWindowProvider;
  platform?: NodeJS.Platform;
  openExternal?: (uri: string) => Promise<void>;
  ipc?: IpcHandlerRegistrar;
  validateSender?: typeof validateIpcSender;
}

export function microphoneSettingsUri(platform: NodeJS.Platform): string | null {
  if (platform === "win32") return "ms-settings:privacy-microphone";
  if (platform === "darwin") {
    return "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";
  }
  return null;
}

function result(opened: boolean, supported: boolean, platform: NodeJS.Platform) {
  return {
    opened,
    supported,
    platform,
    fixedDestination: true,
    localOnly: true,
    rawPathExposed: false,
    keyMaterialExposedToRenderer: false,
  } as const;
}

export function registerCaptureSettingsIpc(dependencies: CaptureSettingsIpcDependencies): () => void {
  const registrar = dependencies.ipc ?? ipcMain as unknown as IpcHandlerRegistrar;
  const validateSender = dependencies.validateSender ?? validateIpcSender;
  const platform = dependencies.platform ?? process.platform;
  const openExternal = dependencies.openExternal ?? ((uri: string) => shell.openExternal(uri));

  registrar.handle(CAPTURE_SETTINGS_IPC_CHANNEL, async (event: IpcMainInvokeEvent, value?: unknown) => {
    validateSender(event, dependencies.getMainWindow);
    if (value !== undefined && value !== null) {
      throw new Error("Microphone settings do not accept a destination or other parameters.");
    }
    const uri = microphoneSettingsUri(platform);
    if (!uri) return result(false, false, platform);
    await openExternal(uri);
    return result(true, true, platform);
  });

  return () => registrar.removeHandler(CAPTURE_SETTINGS_IPC_CHANNEL);
}
