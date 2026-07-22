import type { IpcDependencies } from "./ipc-types.js";
import { registerCoreIpc } from "./core-ipc.js";
import { registerExportIpc } from "./export-ipc.js";
import { registerImportIpc } from "./import-ipc.js";
import { registerLicensingIpc } from "./licensing-ipc.js";
import { registerModelsIpc } from "./models-ipc.js";
import { registerDiagnosticsIpc } from "./diagnostics-ipc.js";
import { registerRecordingsIpc } from "./recordings-ipc.js";
import { registerJobsIpc } from "./jobs-ipc.js";
import { registerTerminologyIpc } from "./terminology-ipc.js";
import { registerCaptureSettingsIpc } from "./capture-settings-ipc.js";
import { registerSetupIpc } from "./setup-ipc.js";
import { registerShortcutsIpc } from "./shortcuts-ipc.js";
import { registerMediaImportIpc } from "./media-import-ipc.js";

export function registerIpcHandlers(dependencies: IpcDependencies): void {
  registerCoreIpc(dependencies);
  registerExportIpc(dependencies);
  registerModelsIpc(dependencies);
  registerImportIpc(dependencies);
  registerMediaImportIpc(dependencies);
  registerLicensingIpc(dependencies);
  registerDiagnosticsIpc(dependencies);
  registerRecordingsIpc(dependencies);
  registerJobsIpc(dependencies);
  registerTerminologyIpc(dependencies);
  registerCaptureSettingsIpc(dependencies);
  registerSetupIpc({
    preferences: dependencies.preferences,
    getMainWindow: dependencies.getMainWindow,
  });
  registerShortcutsIpc({
    shortcuts: dependencies.shortcuts,
    getMainWindow: dependencies.getMainWindow,
  });
}
