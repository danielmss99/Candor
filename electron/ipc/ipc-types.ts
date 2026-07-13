import type { CoreClient } from "../core/core-client.js";
import type { LicenseService } from "../license-service.js";
import type { MainWindowProvider } from "../security/validate-sender.js";

export interface IpcDependencies {
  core: CoreClient;
  getMainWindow: MainWindowProvider;
  getLicenseService(): LicenseService;
}
