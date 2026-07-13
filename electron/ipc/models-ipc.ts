import { dialog, ipcMain } from "electron";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { objectValue, stringField, type JsonValue } from "../core/json.js";
import { validModelId } from "../security/input-limits.js";
import { validateIpcSender } from "../security/validate-sender.js";
import type { IpcDependencies } from "./ipc-types.js";

async function requireResult(dependencies: IpcDependencies, method: string, params: JsonValue) {
  const response = await dependencies.core.call(method, params);
  if (!response.ok) throw new Error(response.error?.message ?? `${method} failed`);
  return response.result ?? null;
}

export function registerModelsIpc(dependencies: IpcDependencies): void {
  ipcMain.handle("candor-models:importFromFile", async (event, params?: JsonValue) => {
    validateIpcSender(event, dependencies.getMainWindow);
    const input = objectValue(params ?? null);
    if (!validModelId(input.modelId)) throw new Error("A valid model id is required for model import.");
    const modelId = input.modelId;
    const replace = input.replace === true;
    const options: Electron.OpenDialogOptions = {
      title: "Import local Whisper model",
      buttonLabel: "Import",
      properties: ["openFile"],
      filters: [{ name: "Whisper GGML model", extensions: ["bin"] }],
    };
    const window = dependencies.getMainWindow();
    const selection = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    const selected = selection.filePaths[0];
    if (selection.canceled || !selected) {
      return { canceled: true, imported: false, rawPathExposed: false, keyMaterialExposedToRenderer: false };
    }
    const selectedPath = await realpath(selected);
    const selectedStat = await stat(selectedPath);
    if (!selectedStat.isFile() || path.extname(selectedPath).toLowerCase() !== ".bin") {
      throw new Error("Selected Whisper model must be a .bin file.");
    }

    const start = await requireResult(
      dependencies,
      "models.importStart",
      { modelId, expectedBytes: selectedStat.size, replace },
    );
    const importId = stringField(start, "importId");
    if (!importId) throw new Error("candor-core did not return a model import id.");

    let bytesRead = 0;
    try {
      for await (const chunk of createReadStream(selectedPath, { highWaterMark: 512 * 1024 })) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytesRead += buffer.length;
        await requireResult(
          dependencies,
          "models.importChunk",
          { importId, dataBase64: buffer.toString("base64") },
        );
      }
      const finish = await requireResult(dependencies, "models.importFinish", { importId });
      return {
        ...objectValue(finish),
        canceled: false,
        sourceFileName: path.basename(selectedPath),
        bytesRead,
        rawPathExposed: false,
        keyMaterialExposedToRenderer: false,
      };
    } catch (error) {
      await dependencies.core.call("models.importAbort", { importId }).catch(() => undefined);
      throw error;
    }
  });

  ipcMain.handle("candor-instruct-assets:importFromFile", async (event, params?: JsonValue) => {
    validateIpcSender(event, dependencies.getMainWindow);
    const input = objectValue(params ?? null);
    const assetKind = input.assetKind === "runner" || input.assetKind === "model" ? input.assetKind : "";
    const expectedSha256 = typeof input.expectedSha256 === "string" ? input.expectedSha256.trim().toLowerCase() : "";
    if (!assetKind) throw new Error("Local AI asset kind must be runner or model.");
    if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
      throw new Error("Expected SHA-256 must contain exactly 64 hexadecimal characters.");
    }
    const filters: Electron.FileFilter[] | undefined = assetKind === "model"
      ? [{ name: "GGUF model", extensions: ["gguf"] }]
      : process.platform === "win32"
        ? [{ name: "llama.cpp runner", extensions: ["exe"] }]
        : undefined;
    const options: Electron.OpenDialogOptions = {
      title: assetKind === "model" ? "Import local GGUF model" : "Import local llama.cpp runner",
      buttonLabel: "Verify and import",
      properties: ["openFile"],
      ...(filters ? { filters } : {}),
    };
    const window = dependencies.getMainWindow();
    const selection = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    const selected = selection.filePaths[0];
    if (selection.canceled || !selected) {
      return {
        canceled: true,
        imported: false,
        sourcePathExposed: false,
        managedPathExposed: false,
        rawPathExposed: false,
        keyMaterialExposedToRenderer: false,
      };
    }
    const selectedPath = await realpath(selected);
    const selectedStat = await stat(selectedPath);
    if (!selectedStat.isFile()) throw new Error("Selected local AI asset is not a file.");
    if (assetKind === "model" && path.extname(selectedPath).toLowerCase() !== ".gguf") {
      throw new Error("Selected local AI model must be a .gguf file.");
    }
    if (assetKind === "runner" && process.platform === "win32" && path.extname(selectedPath).toLowerCase() !== ".exe") {
      throw new Error("Selected local AI runner must be a Windows executable.");
    }

    const result = await requireResult(
      dependencies,
      "ai.instructAssetsImportFromPath",
      { assetKind, sourcePath: selectedPath, expectedSha256, replace: input.replace === true },
    );
    return {
      ...objectValue(result),
      canceled: false,
      sourceFileName: path.basename(selectedPath),
      selectedBytes: selectedStat.size,
      sourcePathExposed: false,
      managedPathExposed: false,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
  });
}
