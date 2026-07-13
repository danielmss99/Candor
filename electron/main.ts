import { app, BrowserWindow, dialog } from "electron";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { CoreClient } from "./core/core-client.js";
import { errorMessage } from "./core/core-errors.js";
import { privateCoreMethods } from "./core/protocol.js";
import { registerIpcHandlers } from "./ipc/register-ipc.js";
import { LicenseService } from "./license-service.js";
import { applyChromiumNetworkPolicy, installSessionHardening, NetworkGuard } from "./security/network-policy.js";
import { runM0Smoke } from "./smoke/m0-smoke.js";
import { createMainWindow } from "./window/create-main-window.js";
import { installCaptureCloseGuard } from "./window/capture-close-guard.js";
import { createRendererNavigationPolicy } from "./window/navigation-policy.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isDev = !app.isPackaged;
const smokeOutputPath = process.env.CANDOR_M0_SMOKE_OUT ?? "";
const smokeScreenshotPath = process.env.CANDOR_M0_SMOKE_SCREENSHOT ?? "";
const isSmokeMode = smokeOutputPath.length > 0;
const smokeWindowWidth = Math.max(960, Number.parseInt(process.env.CANDOR_M0_SMOKE_WIDTH ?? "1440", 10) || 1440);
const smokeWindowHeight = Math.max(700, Number.parseInt(process.env.CANDOR_M0_SMOKE_HEIGHT ?? "900", 10) || 900);
const requestedSmokeScaleFactor = Number.parseFloat(process.env.CANDOR_M0_SMOKE_SCALE_FACTOR ?? "1");
const smokeScaleFactor = Number.isFinite(requestedSmokeScaleFactor)
  ? Math.min(2, Math.max(1, requestedSmokeScaleFactor))
  : 1;

if (isSmokeMode && smokeScaleFactor !== 1) {
  app.commandLine.appendSwitch("force-device-scale-factor", smokeScaleFactor.toString());
}
if (isSmokeMode && process.env.CANDOR_V3_DATA_DIR) {
  app.setPath("userData", path.join(process.env.CANDOR_V3_DATA_DIR, "electron-smoke"));
}

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

const coreClient = new CoreClient({ executablePath: corePath, allowedMethods: privateCoreMethods, isDev });
let mainWindow: BrowserWindow | null = null;
let licenseService: LicenseService | null = null;

function getLicenseService(): LicenseService {
  licenseService ??= new LicenseService({ isDev });
  return licenseService;
}

function createWindow(smoke = false): BrowserWindow {
  mainWindow = createMainWindow({
    preloadPath: path.join(__dirname, "preload.cjs"),
    navigation: rendererNavigation,
    networkGuard,
    smoke,
    smokeWidth: smokeWindowWidth,
    smokeHeight: smokeWindowHeight,
  });
  if (!smoke) {
    installCaptureCloseGuard(mainWindow, {
      phase: () => coreClient.captureGuardPhase(),
      confirmStopAndQuit: async (window, phase) => {
        const detail = phase === "recording"
          ? "Candor is recording. Stop and save the recording before quitting?"
          : "Candor is changing recording state. Wait for a durable save before quitting?";
        const result = await dialog.showMessageBox(window, {
          type: "warning",
          title: "Recording in progress",
          message: "Keep Candor open until the recording is safe.",
          detail,
          buttons: ["Keep recording", "Stop, save, and quit"],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        return result.response === 1;
      },
      finalizeCapture: () => coreClient.finalizeCaptureForClose(),
      shutdownCore: () => coreClient.shutdown(),
      reportFailure: async (window, message) => {
        await dialog.showMessageBox(window, {
          type: "error",
          title: "Recording not yet safe to close",
          message,
          buttons: ["Keep Candor open"],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
      },
    });
  }
  return mainWindow;
}

function hardenSession(): void {
  installSessionHardening(networkGuard, (value) => rendererNavigation.isDevRequest(value));
}

registerIpcHandlers({ core: coreClient, getMainWindow: () => mainWindow, getLicenseService });

app.on("web-contents-created", (_event, contents) => {
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
});

app.whenReady().then(async () => {
  app.setAppUserModelId("com.candor.v3");
  if (isSmokeMode) {
    void runM0Smoke({
      core: coreClient,
      networkGuard,
      createSmokeWindow: () => createWindow(true),
      getLicenseService,
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
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("will-quit", () => {
  void coreClient.shutdown().catch(() => undefined);
});
