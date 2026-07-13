import { app, BrowserWindow } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "..", "..");
const width = Math.max(960, Number.parseInt(process.env.CANDOR_VISUAL_WIDTH ?? "1440", 10) || 1440);
const height = Math.max(600, Number.parseInt(process.env.CANDOR_VISUAL_HEIGHT ?? "900", 10) || 900);
const requestedScale = Number.parseFloat(process.env.CANDOR_VISUAL_SCALE_FACTOR ?? "1");
const scaleFactor = Number.isFinite(requestedScale) ? Math.min(2, Math.max(1, requestedScale)) : 1;

if (scaleFactor !== 1) app.commandLine.appendSwitch("force-device-scale-factor", String(scaleFactor));
app.commandLine.appendSwitch("disable-background-networking");

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width,
    height,
    useContentSize: true,
    minWidth: 960,
    minHeight: 600,
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  await window.loadFile(path.join(repoRoot, "release-v3", "visual-fixtures", "index.html"));
  window.show();
});

app.on("window-all-closed", () => app.quit());
