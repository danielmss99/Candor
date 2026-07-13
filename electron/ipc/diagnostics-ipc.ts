import { app, dialog, ipcMain } from "electron";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { buildDiagnosticReport, diagnosticReportBytes, diagnosticReportSha256 } from "../diagnostics/diagnostic-report.js";
import { validateIpcSender } from "../security/validate-sender.js";
import type { IpcDependencies } from "./ipc-types.js";

async function resultValue(dependencies: IpcDependencies, method: string) {
  const response = await dependencies.core.call(method);
  return response.ok ? response.result ?? null : null;
}

async function createReport(dependencies: IpcDependencies) {
  const [coreStatus, coreVersion, vaultStatus, recordingStatus, captureStatus, privacyAudit, updateStatus] = await Promise.all([
    resultValue(dependencies, "core.status"),
    resultValue(dependencies, "core.version"),
    resultValue(dependencies, "vault.status"),
    resultValue(dependencies, "recording.durable.status"),
    resultValue(dependencies, "capture.status"),
    resultValue(dependencies, "privacy.auditSnapshot"),
    resultValue(dependencies, "updates.status"),
  ]);
  return buildDiagnosticReport({
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
    supervisor: dependencies.core.rendererSnapshot(),
    coreStatus,
    coreVersion,
    vaultStatus,
    recordingStatus,
    captureStatus,
    privacyAudit,
    updateStatus,
  });
}

export function registerDiagnosticsIpc(dependencies: IpcDependencies): void {
  ipcMain.handle("candor-diagnostics:preview", async (event) => {
    validateIpcSender(event, dependencies.getMainWindow);
    return createReport(dependencies);
  });
  ipcMain.handle("candor-diagnostics:saveLocal", async (event) => {
    validateIpcSender(event, dependencies.getMainWindow);
    const owner = dependencies.getMainWindow();
    const selection = owner
      ? await dialog.showSaveDialog(owner, {
        title: "Save Candor diagnostics",
        defaultPath: "candor-diagnostics.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      })
      : await dialog.showSaveDialog({
        title: "Save Candor diagnostics",
        defaultPath: "candor-diagnostics.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
    if (selection.canceled || !selection.filePath) {
      return { canceled: true, saved: false, rawPathExposed: false, userContentIncluded: false };
    }
    const report = await createReport(dependencies);
    const bytes = diagnosticReportBytes(report);
    await writeFile(selection.filePath, bytes, { flag: "wx" });
    return {
      canceled: false,
      saved: true,
      fileName: path.basename(selection.filePath),
      bytes: bytes.length,
      sha256: diagnosticReportSha256(bytes),
      rawPathExposed: false,
      userContentIncluded: false,
    };
  });
}
