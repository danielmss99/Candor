import { dialog, ipcMain } from "electron";
import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { objectValue, stringField, type JsonValue } from "../core/json.js";
import {
  decodeLocalExportResult,
  localExportSpecifications,
  localReportFormat,
  sha256Bytes,
} from "../export/local-report.js";
import { validateIpcSender } from "../security/validate-sender.js";
import type { IpcDependencies } from "./ipc-types.js";

function numberField(value: JsonValue, field: string): number {
  const child = objectValue(value)[field];
  return typeof child === "number" && Number.isSafeInteger(child) ? child : -1;
}

export function registerExportIpc(dependencies: IpcDependencies): void {
  ipcMain.handle("candor-export:saveCompleted", async (event, params?: JsonValue) => {
    validateIpcSender(event, dependencies.getMainWindow);
    const input = objectValue(params ?? null);
    const jobId = typeof input.jobId === "string" ? input.jobId : "";
    if (!/^[a-f0-9]{32}$/.test(jobId)) throw new Error("A valid local export job is required.");
    const response = await dependencies.core.call("jobs.get", { jobId });
    if (!response.ok) throw new Error(response.error?.message ?? "The local export result is unavailable.");
    const job = objectValue(response.result ?? null);
    if (job.type !== "export" || job.state !== "completed") {
      throw new Error("The local export is not ready to save.");
    }
    const result = job.result ?? null;
    const format = localReportFormat(objectValue(result).format);
    if (!format) throw new Error("The local export format is invalid.");
    const decoded = decodeLocalExportResult(format, result);
    const specification = localExportSpecifications[format];
    const options: Electron.SaveDialogOptions = {
      title: `Save local ${format === "docx" ? "Word" : format === "pdf" ? "PDF" : "Markdown"} report`,
      buttonLabel: "Save",
      defaultPath: decoded.fileName,
      filters: [{ name: specification.filterName, extensions: [specification.extension] }],
    };
    const window = dependencies.getMainWindow();
    const selection = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
    if (selection.canceled || !selection.filePath) {
      return { canceled: true, saved: false, format, fileName: decoded.fileName, rawPathExposed: false };
    }
    const destinationPath = selection.filePath.toLowerCase().endsWith(`.${specification.extension}`)
      ? selection.filePath
      : `${selection.filePath}.${specification.extension}`;
    await writeFile(destinationPath, decoded.bytes, { flag: "w", mode: 0o600 });
    const savedStat = await stat(destinationPath);
    if (!savedStat.isFile() || savedStat.size !== decoded.bytes.length) {
      throw new Error("The local report could not be verified after saving.");
    }
    await dependencies.core.call("jobs.acknowledge", { jobId });
    const resultObject = objectValue(result);
    return {
      canceled: false,
      saved: true,
      format,
      fileName: path.basename(destinationPath),
      mimeType: decoded.mimeType,
      bytes: decoded.bytes.length,
      sha256: sha256Bytes(decoded.bytes),
      pageCount: Math.max(0, numberField(result, "pageCount")),
      warningCount: Math.max(0, numberField(result, "warningCount")),
      editable: resultObject.editable === true,
      searchableText: resultObject.searchableText === true,
      bookmarks: resultObject.bookmarks === true,
      ...(format === "markdown" ? { markdown: stringField(result, "markdown") } : {}),
      savedLocally: true,
      generatedLocally: true,
      networkAttempted: false,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
  });

}
