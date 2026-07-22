import { app, BrowserWindow, globalShortcut } from "electron";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { CoreClient } from "./core/core-client.js";
import { CaptureRecoveryStore } from "./core/capture-recovery-store.js";
import { errorMessage } from "./core/core-errors.js";
import { LiveTranscriptEventBridge } from "./core/live-transcript-event-bridge.js";
import { privateCoreMethods } from "./core/protocol.js";
import { createDesktopSetupShortcutServices, showAndFocusDesktopWindow } from "./desktop-setup-shortcuts.js";
import { registerIpcHandlers } from "./ipc/register-ipc.js";
import { LicenseService } from "./license-service.js";
import { applyChromiumNetworkPolicy, installSessionHardening, NetworkGuard } from "./security/network-policy.js";
import { runM0Smoke } from "./smoke/m0-smoke.js";
import { createMainWindow } from "./window/create-main-window.js";
import { installDesktopCloseGuard } from "./window/install-desktop-close-guard.js";
import { DesktopQuitLifecycle } from "./window/desktop-quit-lifecycle.js";
import { createRendererNavigationPolicy } from "./window/navigation-policy.js";
import { SETUP_STEPS } from "./preferences/desktop-preferences.js";
import { ModelAcquisitionService } from "./models/model-acquisition-service.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isDev = !app.isPackaged;
const smokeOutputPath = process.env.CANDOR_M0_SMOKE_OUT ?? "";
const smokeScreenshotPath = process.env.CANDOR_M0_SMOKE_SCREENSHOT ?? "";
const isSmokeMode = smokeOutputPath.length > 0;
const isE2EMode = isDev && process.env.CANDOR_E2E === "1";
const smokeWindowWidth = Math.max(960, Number.parseInt(process.env.CANDOR_M0_SMOKE_WIDTH ?? "1440", 10) || 1440);
const smokeWindowHeight = Math.max(700, Number.parseInt(process.env.CANDOR_M0_SMOKE_HEIGHT ?? "900", 10) || 900);
const requestedSmokeScaleFactor = Number.parseFloat(process.env.CANDOR_M0_SMOKE_SCALE_FACTOR ?? "1");
const smokeScaleFactor = Number.isFinite(requestedSmokeScaleFactor)
  ? Math.min(2, Math.max(1, requestedSmokeScaleFactor))
  : 1;
const requestedE2EScaleFactor = Number.parseFloat(process.env.CANDOR_E2E_SCALE_FACTOR ?? "1");
const e2eScaleFactor = Number.isFinite(requestedE2EScaleFactor)
  ? Math.min(2, Math.max(1, requestedE2EScaleFactor))
  : 1;
const testScaleFactor = isSmokeMode ? smokeScaleFactor : isE2EMode ? e2eScaleFactor : 1;

if ((isSmokeMode || isE2EMode) && testScaleFactor !== 1) {
  app.commandLine.appendSwitch("force-device-scale-factor", testScaleFactor.toString());
}
if ((isSmokeMode || isE2EMode) && process.env.CANDOR_V3_DATA_DIR) {
  app.setPath(
    "userData",
    path.join(process.env.CANDOR_V3_DATA_DIR, isSmokeMode ? "electron-smoke" : "electron-e2e"),
  );
}
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) app.quit();

const rendererNavigation = createRendererNavigationPolicy({
  isDev,
  electronOutputDir: __dirname,
  configuredDevUrl: process.env.CANDOR_V3_RENDERER_URL,
});
const networkGuard = new NetworkGuard();
applyChromiumNetworkPolicy(app.commandLine, isSmokeMode);

function coreExecutableName(): string {
  return process.platform === "win32" ? "candor-core.exe" : "candor-core";
}

function corePath(): string {
  if (isDev) {
    if (rendererNavigation.useDevRenderer) {
      return path.resolve(__dirname, "..", "..", "crates", "candor-core", "target", "debug", coreExecutableName());
    }
    return path.resolve(__dirname, "..", "..", "build", "core-bin", coreExecutableName());
  }
  return path.join(process.resourcesPath, "bin", coreExecutableName());
}

function aiBundleRoot(): string {
  if (isDev) {
    const localBundle = path.resolve(__dirname, "..", "..", "build", "ai-bundle-local");
    if (existsSync(path.join(localBundle, "manifest.json"))) return localBundle;
    return path.resolve(__dirname, "..", "..", "build", "ai-bundle");
  }
  return path.join(process.resourcesPath, "ai");
}

const captureRecoveryStore = new CaptureRecoveryStore(() => app.getPath("userData"));
const coreClient = new CoreClient({
  executablePath: corePath,
  allowedMethods: privateCoreMethods,
  isDev,
  environment: () => ({
    CANDOR_AI_BUNDLE_ROOT: aiBundleRoot(),
    CANDOR_AUTOMATION_MODE: "0",
  }),
  onCaptureConnectionDegraded: (metadata) => captureRecoveryStore.persist(metadata),
  onCaptureRecoveryResolved: () => captureRecoveryStore.clear(),
});
let mainWindow: BrowserWindow | null = null;
let licenseService: LicenseService | null = null;
const quitLifecycle = new DesktopQuitLifecycle();

const { preferences: desktopPreferences, shortcuts: shortcutService } = createDesktopSetupShortcutServices({
  userDataPath: () => app.getPath("userData"),
  // Test harnesses create their override root before Electron starts. In
  // those modes only a known Candor child is evidence of an existing install.
  coreRootExistenceIsEvidence: !isSmokeMode && !isE2EMode,
  shortcutAdapter: {
    register: (accelerator, callback) => globalShortcut.register(accelerator, callback),
    unregister: (accelerator) => globalShortcut.unregister(accelerator),
  },
  shortcutTarget: { showAndFocusRecorder: () => showAndFocusWindow(true) },
  onShortcutActivationError: () => console.error("[candor-shortcut] recorder focus failed"),
});

function showAndFocusWindow(sendRecorderEvent: boolean): void {
  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createWindow();
  showAndFocusDesktopWindow(window, sendRecorderEvent);
}

const liveTranscriptEvents = new LiveTranscriptEventBridge({
  core: coreClient,
  getMainWindow: () => mainWindow,
});
const modelAcquisition = new ModelAcquisitionService(coreClient, () => mainWindow);

function getLicenseService(): LicenseService {
  licenseService ??= new LicenseService({ isDev });
  return licenseService;
}

function createWindow(smoke = false): BrowserWindow {
  const createdWindow = createMainWindow({
    preloadPath: path.join(__dirname, "preload.cjs"),
    navigation: rendererNavigation,
    networkGuard,
    smoke,
    smokeWidth: smokeWindowWidth,
    smokeHeight: smokeWindowHeight,
  });
  mainWindow = createdWindow;
  createdWindow.once("closed", () => {
    if (mainWindow === createdWindow) mainWindow = null;
  });
  if (!smoke) installDesktopCloseGuard(createdWindow, {
    core: coreClient,
    shortcuts: shortcutService,
    e2eMode: isE2EMode,
    shouldShutdownServicesOnClose: () => quitLifecycle.shouldShutdownServicesOnClose(process.platform),
    onCloseAborted: () => quitLifecycle.cancelQuit(),
  });
  return createdWindow;
}

function hardenSession(): void {
  installSessionHardening(networkGuard, (value) => rendererNavigation.isDevRequest(value));
}

registerIpcHandlers({
  core: coreClient,
  preferences: desktopPreferences,
  shortcuts: shortcutService,
  modelAcquisition,
  liveTranscriptEvents,
  getMainWindow: () => mainWindow,
  getLicenseService,
});

app.on("web-contents-created", (_event, contents) => {
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
});

if (hasSingleInstanceLock) app.whenReady().then(async () => {
  app.setAppUserModelId("com.candor.v3");
  // This must precede the core handshake. A genuine first launch can create
  // the Candor core root during handshake and must remain classified as new.
  await desktopPreferences.initialize().catch((error) => {
    console.error(`[candor-setup] upgrade migration snapshot failed: ${errorMessage(error)}`);
  });
  const pendingCaptureRecovery = await captureRecoveryStore.read();
  if (pendingCaptureRecovery) {
    coreClient.restoreCaptureRecovery({
      at: pendingCaptureRecovery.recordedAt,
      method: pendingCaptureRecovery.method,
      recordingId: pendingCaptureRecovery.recordingId,
    });
  }
  if (isSmokeMode) {
    void runM0Smoke({
      core: coreClient,
      networkGuard,
      createSmokeWindow: () => createWindow(true),
      getLicenseService,
      prepareRendererSetup: async () => {
        for (const step of SETUP_STEPS) await desktopPreferences.deferStep(step);
        await desktopPreferences.completeSetup();
      },
      installSessionHardening: hardenSession,
      corePath,
      outputPath: smokeOutputPath,
      screenshotPath: smokeScreenshotPath,
      windowWidth: smokeWindowWidth,
      windowHeight: smokeWindowHeight,
      scaleFactor: smokeScaleFactor,
    });
    return;
  }

  hardenSession();
  try {
    await coreClient.ensureHandshake();
  } catch (error) {
    console.error(`[candor-core] startup handshake failed: ${errorMessage(error)}`);
  }
  createWindow();
  try {
    await shortcutService.initialize();
  } catch (error) {
    console.error(`[candor-shortcut] initialization failed: ${errorMessage(error)}`);
  }
});

app.on("before-quit", () => {
  quitLifecycle.markBeforeQuit();
});

app.on("second-instance", () => {
  if (hasSingleInstanceLock && app.isReady() && !isSmokeMode) showAndFocusWindow(false);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("will-quit", (event) => {
  modelAcquisition.cancel();
  void quitLifecycle.holdFinalQuit({
    liveTranscriptEvents,
    shortcuts: shortcutService,
    core: coreClient,
  }, {
    preventQuit: () => event.preventDefault(),
    requestQuit: () => app.quit(),
  });
});
