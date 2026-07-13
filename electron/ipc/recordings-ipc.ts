import { dialog, ipcMain } from "electron";
import { objectValue, type JsonValue } from "../core/json.js";
import { deleteRecordingConfirmationOptions } from "../recordings/delete-policy.js";
import { validRecordingId } from "../security/input-limits.js";
import { validateIpcSender } from "../security/validate-sender.js";
import type { IpcDependencies } from "./ipc-types.js";

type RecordingIpcDependencies = Pick<IpcDependencies, "core" | "getMainWindow">;

export function registerRecordingsIpc(dependencies: RecordingIpcDependencies): void {
  ipcMain.handle("candor-recording:delete", async (event, params?: JsonValue) => {
    validateIpcSender(event, dependencies.getMainWindow);
    const input = objectValue(params ?? null);
    if (!validRecordingId(input.recordingId)) {
      throw new Error("A valid local recording id is required for permanent deletion.");
    }

    const window = dependencies.getMainWindow();
    const options = deleteRecordingConfirmationOptions();
    const confirmation = window
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options);
    if (confirmation.response !== 1) {
      return {
        canceled: true,
        deleted: false,
        permanent: true,
        rawPathExposed: false,
      };
    }

    const response = await dependencies.core.call(
      "recording.durable.delete",
      { recordingId: input.recordingId },
      30_000,
    );
    if (!response.ok) {
      throw new Error(response.error?.message ?? "The local meeting could not be deleted.");
    }
    return {
      ...objectValue(response.result ?? null),
      canceled: false,
      rawPathExposed: false,
    };
  });
}
