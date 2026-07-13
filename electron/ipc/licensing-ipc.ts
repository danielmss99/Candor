import { ipcMain } from "electron";
import { objectValue, type JsonValue } from "../core/json.js";
import { boundedString, INPUT_LIMITS } from "../security/input-limits.js";
import { validateIpcSender } from "../security/validate-sender.js";
import type { IpcDependencies } from "./ipc-types.js";

export function registerLicensingIpc(dependencies: IpcDependencies): void {
  ipcMain.handle("candor-license:status", async (event) => {
    validateIpcSender(event, dependencies.getMainWindow);
    return dependencies.getLicenseService().status();
  });
  ipcMain.handle("candor-license:activate", async (event, params?: JsonValue) => {
    validateIpcSender(event, dependencies.getMainWindow);
    const input = objectValue(params ?? null);
    const licenseKey = boundedString(input.licenseKey, INPUT_LIMITS.licenseKey);
    const purchaserEmail = boundedString(input.purchaserEmail, INPUT_LIMITS.email);
    if (!licenseKey) throw new Error("A valid license key is required.");
    return dependencies.getLicenseService().activate(licenseKey, purchaserEmail);
  });
  ipcMain.handle("candor-license:startTrial", async (event) => {
    validateIpcSender(event, dependencies.getMainWindow);
    return dependencies.getLicenseService().startTrial();
  });
  ipcMain.handle("candor-license:deactivateDevice", async (event) => {
    validateIpcSender(event, dependencies.getMainWindow);
    return dependencies.getLicenseService().deactivateDevice();
  });
  ipcMain.handle("candor-license:portalInfo", async (event) => {
    validateIpcSender(event, dependencies.getMainWindow);
    return dependencies.getLicenseService().portalInfo();
  });
}
