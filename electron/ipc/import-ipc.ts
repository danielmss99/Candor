import { dialog, ipcMain } from "electron";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { objectValue } from "../core/json.js";
import { validateIpcSender } from "../security/validate-sender.js";
import type { IpcDependencies } from "./ipc-types.js";

export function registerImportIpc(dependencies: IpcDependencies): void {
  ipcMain.handle("candor-import:v2FromFolder", async (event) => {
    validateIpcSender(event, dependencies.getMainWindow);
    const options: Electron.OpenDialogOptions = {
      title: "Import Candor v2 folder",
      buttonLabel: "Import",
      properties: ["openDirectory"],
    };
    const window = dependencies.getMainWindow();
    const selection = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    const selected = selection.filePaths[0];
    if (selection.canceled || !selected) {
      return { canceled: true, importedCount: 0, rawPathExposed: false, keyMaterialExposedToRenderer: false };
    }
    const selectedPath = await realpath(selected);
    const selectedStat = await stat(selectedPath);
    if (!selectedStat.isDirectory()) throw new Error("Selected v2 import target is not a folder.");
    const response = await dependencies.core.call("import.v2.startFromFolder", { sourcePath: selectedPath });
    if (!response.ok) throw new Error(response.error?.message ?? "import.v2.fromFolder failed");
    return {
      ...objectValue(response.result ?? null),
      canceled: false,
      sourceFolderName: path.basename(selectedPath),
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
  });
}
