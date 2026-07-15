import { BrowserWindow } from "electron";
import type { NetworkGuard } from "../security/network-policy.js";
import type { RendererNavigationPolicy } from "./navigation-policy.js";

interface CreateMainWindowOptions {
  preloadPath: string;
  navigation: RendererNavigationPolicy;
  networkGuard: NetworkGuard;
  smoke?: boolean;
  smokeWidth: number;
  smokeHeight: number;
}

export function createMainWindow(options: CreateMainWindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    width: options.smoke ? options.smokeWidth : 1180,
    height: options.smoke ? options.smokeHeight : 760,
    minWidth: 920,
    minHeight: 620,
    title: "Candor",
    show: false,
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: options.navigation.useDevRenderer,
    },
  });

  window.webContents.setWindowOpenHandler((details) => {
    options.networkGuard.recordWindowOpen(details.url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, targetUrl) => {
    if (!options.navigation.isNavigationAllowed(targetUrl)) {
      options.networkGuard.recordNavigation(targetUrl);
      event.preventDefault();
    }
  });
  window.webContents.on("before-input-event", (event, input) => {
    if (
      !options.navigation.useDevRenderer &&
      input.control &&
      input.shift &&
      input.key.toLowerCase() === "i"
    ) {
      event.preventDefault();
    }
  });

  const reveal = () => {
    if (!options.smoke && !window.isDestroyed()) window.show();
  };
  window.once("ready-to-show", reveal);
  const load = options.navigation.useDevRenderer
    ? window.loadURL(options.navigation.rendererDevUrl)
    : window.loadFile(options.navigation.rendererFilePath);
  void load.then(reveal);
  return window;
}
