import { dialog, ipcMain } from "electron";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { objectValue } from "../core/json.js";
import { INPUT_LIMITS } from "../security/input-limits.js";
import { validateIpcSender } from "../security/validate-sender.js";
import type { IpcDependencies } from "./ipc-types.js";

const SUPPORTED_FORMATS = new Map([
  [".txt", "txt"],
  [".csv", "csv"],
  [".json", "json"],
] as const);

export function registerTerminologyIpc(dependencies: IpcDependencies): void {
  ipcMain.handle("candor-terminology:importFromFile", async (event) => {
    validateIpcSender(event, dependencies.getMainWindow);
    const options: Electron.OpenDialogOptions = {
      title: "Import terminology dictionary",
      buttonLabel: "Import dictionary",
      properties: ["openFile"],
      filters: [
        { name: "Terminology dictionaries", extensions: ["txt", "csv", "json"] },
      ],
    };
    const window = dependencies.getMainWindow();
    const selection = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    const selected = selection.filePaths[0];
    if (selection.canceled || !selected) {
      return {
        canceled: true,
        imported: false,
        rawPathExposed: false,
        keyMaterialExposedToRenderer: false,
      };
    }

    const selectedLink = await lstat(selected);
    if (selectedLink.isSymbolicLink()) {
      throw new Error("Symbolic links cannot be imported as terminology dictionaries.");
    }
    const selectedPath = await realpath(selected);
    const selectedStat = await stat(selectedPath);
    if (!selectedStat.isFile() || selectedStat.size > INPUT_LIMITS.terminologyFileBytes) {
      throw new Error("The selected terminology file is missing or exceeds the local size limit.");
    }
    const extension = path.extname(selectedPath).toLowerCase();
    const format = SUPPORTED_FORMATS.get(extension as ".txt" | ".csv" | ".json");
    if (!format) throw new Error("Terminology files must use TXT, CSV, or JSON.");
    const bytes = await readFile(selectedPath);
    if (bytes.length > INPUT_LIMITS.terminologyFileBytes) {
      throw new Error("The selected terminology file exceeds the local size limit.");
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("The selected terminology file must use UTF-8 text.");
    }
    const name = path.basename(selectedPath, extension).trim();
    const response = await dependencies.core.call("terminology.import", {
      name,
      format,
      content,
    });
    if (!response.ok) {
      throw new Error(response.error?.message ?? "The terminology dictionary could not be imported.");
    }
    return {
      ...objectValue(response.result ?? null),
      canceled: false,
      sourceFileName: path.basename(selectedPath),
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
  });
}
