import { ipcMain } from "electron";
import type { JsonValue } from "../core/json.js";
import { rendererCoreOperations } from "../core/protocol.js";
import { rendererSafeCoreError, sanitizeCoreResultForRenderer } from "../core/renderer-boundary.js";
import { CoreClientError } from "../core/core-errors.js";
import { validateRendererCoreParams } from "../security/validate-core-input.js";
import { validateIpcSender } from "../security/validate-sender.js";
import type { IpcDependencies } from "./ipc-types.js";

export function registerCoreIpc(dependencies: IpcDependencies): void {
  for (const operation of rendererCoreOperations) {
    ipcMain.handle(operation.channel, async (event, params?: unknown) => {
      validateIpcSender(event, dependencies.getMainWindow);
      let validatedParams: JsonValue;
      try {
        validatedParams = validateRendererCoreParams(operation.method, params ?? null);
      } catch {
        throw rendererSafeCoreError("INVALID_RENDERER_INPUT");
      }
      try {
        const response = await dependencies.core.call(
          operation.method,
          validatedParams,
        );
        if (!response.ok) throw rendererSafeCoreError(response.error?.code);
        return sanitizeCoreResultForRenderer(operation.method, response.result ?? null);
      } catch (error) {
        if (error instanceof CoreClientError) throw rendererSafeCoreError(error.code);
        if (error instanceof Error && error.message.startsWith("CANDOR_CORE_ERROR:")) throw error;
        throw rendererSafeCoreError("CORE_REQUEST_FAILED");
      }
    });
  }

  ipcMain.handle("candor-shell:openExternal", async (event) => {
    validateIpcSender(event, dependencies.getMainWindow);
    throw new Error("External navigation is disabled.");
  });

  ipcMain.handle("candor-shell:supervisorStatus", async (event) => {
    validateIpcSender(event, dependencies.getMainWindow);
    return dependencies.core.rendererSnapshot();
  });
}
