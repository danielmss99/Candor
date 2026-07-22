import { DesktopPreferencesService } from "./preferences/desktop-preferences.js";
import { createLegacyInstallationEvidenceDetector } from "./preferences/legacy-installation-evidence.js";
import {
  GlobalShortcutService,
  type GlobalShortcutAdapter,
  type RecorderShortcutActivationTarget,
} from "./shortcuts/global-shortcut-service.js";
import { ShortcutStore } from "./shortcuts/shortcut-store.js";

export const RECORDER_SHORTCUT_TRIGGERED_EVENT = "candor-events:shortcut-triggered";

export interface DesktopSetupShortcutOptions {
  userDataPath: () => string;
  coreDataPath?: () => string;
  coreRootExistenceIsEvidence: boolean;
  shortcutAdapter: GlobalShortcutAdapter;
  shortcutTarget: RecorderShortcutActivationTarget;
  onShortcutActivationError: () => void;
}

export interface FocusableDesktopWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  webContents: {
    isDestroyed(): boolean;
    isLoadingMainFrame(): boolean;
    send(channel: string, payload: RecorderShortcutPayload): void;
    once(event: "did-finish-load", listener: () => void): unknown;
  };
}

export interface RecorderShortcutPayload {
  action: "show-and-focus-recorder";
  recordsAudio: false;
  localOnly: true;
  rawPathExposed: false;
  keyMaterialExposedToRenderer: false;
}

export function createDesktopSetupShortcutServices(options: DesktopSetupShortcutOptions) {
  const preferences = new DesktopPreferencesService({
    userDataPath: options.userDataPath,
    legacyInstallationEvidence: createLegacyInstallationEvidenceDetector({
      userDataPath: options.userDataPath,
      coreDataPath: options.coreDataPath,
      coreRootExistenceIsEvidence: options.coreRootExistenceIsEvidence,
    }),
  });
  const shortcuts = new GlobalShortcutService({
    adapter: options.shortcutAdapter,
    store: new ShortcutStore({ userDataPath: options.userDataPath }),
    target: options.shortcutTarget,
    onActivationError: options.onShortcutActivationError,
  });
  return { preferences, shortcuts };
}

export function showAndFocusDesktopWindow(window: FocusableDesktopWindow, sendRecorderEvent: boolean): void {
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  if (!sendRecorderEvent) return;

  const notifyRenderer = () => {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send(RECORDER_SHORTCUT_TRIGGERED_EVENT, recorderShortcutPayload());
    }
  };
  if (window.webContents.isLoadingMainFrame()) window.webContents.once("did-finish-load", notifyRenderer);
  else notifyRenderer();
}

function recorderShortcutPayload(): RecorderShortcutPayload {
  return {
    action: "show-and-focus-recorder",
    recordsAudio: false,
    localOnly: true,
    rawPathExposed: false,
    keyMaterialExposedToRenderer: false,
  };
}
