import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const files = [
  "electron/main.ts",
  "electron/core/json.ts",
  "electron/core/core-client.ts",
  "electron/core/core-errors.ts",
  "electron/core/protocol.ts",
  "electron/core/renderer-boundary.ts",
  "electron/core/request-registry.ts",
  "electron/export/local-report.ts",
  "electron/ipc/core-ipc.ts",
  "electron/ipc/export-ipc.ts",
  "electron/ipc/import-ipc.ts",
  "electron/ipc/ipc-types.ts",
  "electron/ipc/licensing-ipc.ts",
  "electron/ipc/models-ipc.ts",
  "electron/ipc/register-ipc.ts",
  "electron/security/input-limits.ts",
  "electron/security/validate-core-input.ts",
  "electron/security/validate-sender.ts",
  "electron/smoke/m0-smoke.ts",
  "electron/security/network-policy.ts",
  "electron/window/create-main-window.ts",
  "electron/window/navigation-policy.ts",
  "electron/preload.cts",
  "v3/renderer/index.html",
  "vite.v3.config.ts",
  "scripts/m0-packaged-smoke.mjs",
  "electron-builder.v3.yml",
];

const requiredMainPatterns = [
  "contextIsolation: true",
  "sandbox: true",
  "nodeIntegration: false",
  "setPermissionRequestHandler",
  "setPermissionCheckHandler",
  "setWindowOpenHandler",
  "will-navigate",
  "rendererFileUrl",
  "fileNavigation",
  "MAX_CORE_STDERR_BYTES",
  "diagnostic output suppressed in packaged build",
  "rendererPathAudit",
  "randomUUID",
  "MAX_CORE_RESPONSE_LINE_BYTES",
  "duplicate core request id",
  "CORE_PROTOCOL_MISMATCH",
  "CORE_CAPTURE_ACTIVE",
  "validateIpcSender",
  "validateRendererCoreParams",
  "rendererSafeCoreError",
  "rendererSnapshot",
  "senderMatchesMainFrame",
  "realpath",
  "disable-background-networking",
  "disable-component-update",
  "networkBlockProbe",
  "rendererIsolationProbe",
  "licenseFixture",
  "licenseFrozen",
  "forbiddenLicenseKeysPresent",
  "CANDOR_M0_SMOKE_SCREENSHOT",
  "CANDOR_M0_SMOKE_WIDTH",
  "CANDOR_M0_SMOKE_HEIGHT",
  "capturePage",
  "captureSettledSmokePage",
  "forcedWindowRepaint",
  "warmupCapture",
  "rendererOnboardingScreenshots",
  "rendererScreenshot",
  "runRendererIsolationProbe",
  "forbiddenGlobalsPresent",
  "forbiddenCoreKeysPresent",
  "deniedWindowOpenRequests",
  "updates.status",
  "capture.startSystem",
  "capture.startMicAndSystem",
  "ai.instructStatus",
  "ai.instructAssetsStatus",
  "ai.instructAssetsImportFromPath",
  "ai.askInstruct",
  "ai.recapInstruct",
  "stdio-json-lines",
  "core.version",
  "restartCount",
  "candor-shell:supervisorStatus",
  "rendererCoreOperations",
  "rendererCoreMethods",
  "privateCoreMethods",
  "candor-models:importFromFile",
  "candor-instruct-assets:importFromFile",
  "candor-import:v2FromFolder",
  "candor-export:saveLocal",
  "dialog.showOpenDialog",
  "dialog.showSaveDialog",
  "createReadStream",
  "decodeLocalExportResult",
  "documentExportFixture",
  "models.importStart",
  "models.importChunk",
  "models.importFinish",
  "models.importAbort",
  "import.v2.fromFolder",
  "recording.notes.read",
  "recording.notes.save",
  "retention.status",
  "LicenseService",
  "candor-license:status",
  "candor-license:activate",
  "candor-license:startTrial",
  "candor-license:deactivateDevice",
  "candor-license:portalInfo",
  "sourceFolderName: path.basename(selectedPath)",
  "path.basename(selectedPath)",
];

const requiredPreloadPatterns = [
  "consentStatus",
  "consentAcknowledge",
  "captureStartSystem",
  "captureStartMicAndSystem",
  "aiSchedulerStatus",
  "aiInstructStatus",
  "aiInstructAssetsStatus",
  "aiInstructAssetImportFromFile",
  "aiAskInstruct",
  "aiRecapInstruct",
  "modelsStatus",
  "modelsListLocal",
  "modelsVerifyLocal",
  "modelsImportFromFile",
  "updateStatus",
  "v2ImportStatus",
  "v2ImportFromFolder",
  "recordingNotesRead",
  "recordingNotesSave",
  "retentionStatus",
  "candor-license:status",
  "candor-license:activate",
  "candor-license:startTrial",
  "candor-license:deactivateDevice",
  "candor-license:portalInfo",
  "candor-models:importFromFile",
  "candor-instruct-assets:importFromFile",
  "candor-import:v2FromFolder",
  "exportSaveLocal",
  "candor-export:saveLocal",
];

const bannedPatterns = [
  /autoUpdater/,
  /crashReporter\.start/,
  /nodeIntegration:\s*true/,
  /contextIsolation:\s*false/,
  /sandbox:\s*false/,
  /enableRemoteModule:\s*true/,
  /http:\/\/127\.0\.0\.1:\d+\/v1\/chat\/completions/,
  /candor-core:call/,
];

const bannedPreloadPatterns = [
  /\bcallCore\b/,
  /\ballowedMethods\b/,
  /models\.importStart/,
  /models\.importChunk/,
  /models\.importFinish/,
  /models\.importAbort/,
  /ai\.instructAssetsImportFromPath/,
  /import\.v2\.fromFolder/,
  /dialog\.showOpenDialog/,
  /dialog\.showSaveDialog/,
  /createReadStream/,
  /writeFile/,
  /selectedPath/,
  /destinationPath/,
];

const requiredPackagedSmokePatterns = [
  "pngVisualEvidence",
  "rendererVisualState",
  "rendererScreenshotVisualEvidence",
  "documentExportFixture",
  "exportSaveAction",
  "nonBlank",
];

const contents = Object.fromEntries(
  files.map((file) => [file, readFileSync(path.join(repoRoot, file), "utf8")]),
);
const electronRuntimeSource = Object.entries(contents)
  .filter(([file]) => file.startsWith("electron/") && file !== "electron/preload.cts")
  .map(([, content]) => content)
  .join("\n");

for (const pattern of requiredMainPatterns) {
  if (!electronRuntimeSource.includes(pattern)) {
    throw new Error(`Electron hardening pattern missing: ${pattern}`);
  }
}

for (const pattern of requiredPreloadPatterns) {
  if (!contents["electron/preload.cts"].includes(pattern)) {
    throw new Error(`Preload model import pattern missing: ${pattern}`);
  }
}

for (const pattern of bannedPreloadPatterns) {
  if (pattern.test(contents["electron/preload.cts"])) {
    throw new Error(`Unsafe model import pattern found in preload: ${pattern}`);
  }
}

for (const pattern of requiredPackagedSmokePatterns) {
  if (!contents["scripts/m0-packaged-smoke.mjs"].includes(pattern)) {
    throw new Error(`Packaged visual proof pattern missing: ${pattern}`);
  }
}

if (!contents["v3/renderer/index.html"].includes("connect-src 'none'")) {
  throw new Error("Renderer CSP must block network connections in packaged M0.");
}

if (!contents["vite.v3.config.ts"].includes('base: "./"')) {
  throw new Error("V3 renderer assets must use relative paths for packaged file loading.");
}

const joined = Object.values(contents).join("\n");
for (const pattern of bannedPatterns) {
  if (pattern.test(joined)) {
    throw new Error(`Banned Electron/M0 pattern found: ${pattern}`);
  }
}

console.log("M0 Electron hardening audit passed.");
