import { ipcMain } from "electron";
import type { JsonValue } from "../core/json.js";
import { rendererCoreOperations } from "../core/protocol.js";
import { validateRendererCoreParams } from "../security/validate-core-input.js";
import { validateIpcSender } from "../security/validate-sender.js";
import type { IpcDependencies } from "./ipc-types.js";

export function registerCoreIpc(dependencies: IpcDependencies): void {
  for (const operation of rendererCoreOperations) {
    ipcMain.handle(operation.channel, async (event, params?: unknown) => {
      validateIpcSender(event, dependencies.getMainWindow);
      const validatedParams: JsonValue = validateRendererCoreParams(operation.method, params ?? null);
      const response = await dependencies.core.call(
        operation.method,
        validatedParams,
        operation.timeoutMs,
      );
      if (!response.ok) throw new Error(response.error?.message ?? "candor-core request failed");
      return response.result ?? null;
    });
  }

  ipcMain.handle("candor-shell:openExternal", async (event) => {
    validateIpcSender(event, dependencies.getMainWindow);
    throw new Error("External navigation is disabled.");
  });

  ipcMain.handle("candor-shell:supervisorStatus", async (event) => {
    validateIpcSender(event, dependencies.getMainWindow);
    return dependencies.core.snapshot();
  });
}
