import { dialog, ipcMain } from "electron";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { objectValue } from "../core/json.js";
import { INPUT_LIMITS } from "../security/input-limits.js";
import { validateIpcSender } from "../security/validate-sender.js";
import type { IpcDependencies } from "./ipc-types.js";

const MAX_DICTIONARY_PACKAGE_BYTES = 2_500_000;

const SUPPORTED_FORMATS = new Map([
  [".txt", "txt"],
  [".csv", "csv"],
  [".json", "json"],
] as const);
async function queueDictionaryPackage(
  dependencies: IpcDependencies,
  sourceFileName: string,
  bytes: Uint8Array,
) {
  const response = await dependencies.core.call("terminology.package.start", {
    sourceFileName,
    archiveBase64: Buffer.from(bytes).toString("base64"),
  });
  if (!response.ok) {
    throw new Error(response.error?.message ?? "The Candor dictionary could not be queued.");
  }
  return {
    ...objectValue(response.result ?? null),
    canceled: false,
    sourceFileName,
    packageFormat: "candordict",
    rawPathExposed: false,
    keyMaterialExposedToRenderer: false,
  };
}

export function registerTerminologyIpc(dependencies: IpcDependencies): void {
  ipcMain.handle("candor-terminology:importFromFile", async (event) => {
    validateIpcSender(event, dependencies.getMainWindow);
    const options: Electron.OpenDialogOptions = {
      title: "Import terminology dictionary",
      buttonLabel: "Import dictionary",
      properties: ["openFile"],
      filters: [
        { name: "Candor dictionaries", extensions: ["candordict"] },
        { name: "Plain terminology files", extensions: ["txt", "csv", "json"] },
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
    const extension = path.extname(selectedPath).toLowerCase();
    const sizeLimit = extension === ".candordict"
      ? MAX_DICTIONARY_PACKAGE_BYTES
      : INPUT_LIMITS.terminologyFileBytes;
    if (!selectedStat.isFile() || selectedStat.size > sizeLimit) {
      throw new Error("The selected terminology file is missing or exceeds the local size limit.");
    }
    const bytes = await readFile(selectedPath);
    if (bytes.length > sizeLimit) {
      throw new Error("The selected terminology file exceeds the local size limit.");
    }
    if (extension === ".candordict") {
      return queueDictionaryPackage(dependencies, path.basename(selectedPath), bytes);
    }
    const format = SUPPORTED_FORMATS.get(extension as ".txt" | ".csv" | ".json");
    if (!format) throw new Error("Terminology files must use CANDORDICT, TXT, CSV, or JSON.");
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
