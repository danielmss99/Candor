import { ipcMain } from "electron";
import { CoreClientError } from "../core/core-errors.js";
import { objectValue, type JsonValue } from "../core/json.js";
import { rendererSafeCoreError, sanitizeCoreResultForRenderer } from "../core/renderer-boundary.js";
import { validateIpcSender } from "../security/validate-sender.js";
import type { IpcDependencies } from "./ipc-types.js";

async function callCore(dependencies: IpcDependencies, method: string, params: JsonValue = null): Promise<JsonValue> {
  try {
    const response = await dependencies.core.call(method, params);
    if (!response.ok) throw rendererSafeCoreError(response.error?.code);
    return sanitizeCoreResultForRenderer(method, response.result ?? null);
  } catch (error) {
    if (error instanceof CoreClientError) throw rendererSafeCoreError(error.code);
    if (error instanceof Error && error.message.startsWith("CANDOR_CORE_ERROR:")) throw error;
    throw rendererSafeCoreError("CORE_REQUEST_FAILED");
  }
}

export function registerJobsIpc(dependencies: IpcDependencies): void {
  const register = (channel: string, method: string) => {
    ipcMain.handle(channel, async (event, params?: JsonValue) => {
      validateIpcSender(event, dependencies.getMainWindow);
      return callCore(dependencies, method, params ?? null);
    });
  };

  register("candor-jobs:list", "jobs.list");
  register("candor-jobs:get", "jobs.get");
  register("candor-jobs:cancel", "jobs.cancel");
  register("candor-jobs:acknowledge", "jobs.acknowledge");
  register("candor-transcript:start", "transcription.start");
  register("candor-ai:ask", "ai.ask.start");
  register("candor-ai:recap", "ai.recap.start");
  register("candor-export:start", "export.start");
  register("candor-models:verify", "models.verify.start");

  ipcMain.handle("candor-app:getStatus", async (event) => {
    validateIpcSender(event, dependencies.getMainWindow);
    const runtime = objectValue(await callCore(dependencies, "core.status"));
    return { ...runtime, connection: dependencies.core.rendererSnapshot() };
  });

  ipcMain.handle("candor-app:retryCore", async (event) => {
    validateIpcSender(event, dependencies.getMainWindow);
    return dependencies.core.retryConnection();
  });

  ipcMain.handle("candor-capture:recover", async (event) => {
    validateIpcSender(event, dependencies.getMainWindow);
    const result = await callCore(dependencies, "recording.durable.recover");
    dependencies.core.completeCaptureRecovery();
    await dependencies.core.waitForRecoveryPersistence();
    return result;
  });

  dependencies.core.subscribe((coreEvent) => {
    const window = dependencies.getMainWindow();
    if (!window || window.isDestroyed()) return;
    window.webContents.send("candor-events:jobs-changed", coreEvent.payload);
  });
}
