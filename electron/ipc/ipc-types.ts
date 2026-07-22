import type { CoreClient } from "../core/core-client.js";
import type { LicenseService } from "../license-service.js";
import type { DesktopPreferencesService } from "../preferences/desktop-preferences.js";
import type { MainWindowProvider } from "../security/validate-sender.js";
import type { GlobalShortcutService } from "../shortcuts/global-shortcut-service.js";
import type { LiveTranscriptEventBridge } from "../core/live-transcript-event-bridge.js";
import type { ModelAcquisitionService } from "../models/model-acquisition-service.js";

export interface IpcDependencies {
  core: CoreClient;
  preferences: DesktopPreferencesService;
  shortcuts: GlobalShortcutService;
  modelAcquisition: ModelAcquisitionService;
  liveTranscriptEvents?: Pick<LiveTranscriptEventBridge, "observeCoreOperation">;
  getMainWindow: MainWindowProvider;
  getLicenseService(): LicenseService;
}
