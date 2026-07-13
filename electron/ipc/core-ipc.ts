import { ipcMain } from "electron";
import type { JsonValue } from "../core/json.js";
import { rendererCoreMethods, rendererCoreTimeoutMs } from "../core/protocol.js";
import { validateIpcSender } from "../security/validate-sender.js";
import type { IpcDependencies } from "./ipc-types.js";

export function registerCoreIpc(dependencies: IpcDependencies): void {
  ipcMain.handle("candor-core:call", async (event, method: string, params?: JsonValue) => {
    validateIpcSender(event, dependencies.getMainWindow);
    if (!rendererCoreMethods.has(method)) {
      throw new Error(`Renderer method is not allowed: ${method}`);
    }
    const response = await dependencies.core.call(
      method,
      params ?? null,
      rendererCoreTimeoutMs.get(method) ?? 5000,
    );
    if (!response.ok) throw new Error(response.error?.message ?? "candor-core request failed");
    return response.result ?? null;
  });

  ipcMain.handle("candor-shell:openExternal", async (event) => {
    validateIpcSender(event, dependencies.getMainWindow);
    throw new Error("External navigation is disabled.");
  });

  ipcMain.handle("candor-shell:supervisorStatus", async (event) => {
    validateIpcSender(event, dependencies.getMainWindow);
    return dependencies.core.snapshot();
  });
}
