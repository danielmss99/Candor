import { app, BrowserWindow, dialog, ipcMain, session, shell } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { LicenseService } from "./license-service.js";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

interface CoreResponse {
  id: number;
  protocolVersion: string;
  ok: boolean;
  result?: JsonValue;
  error?: {
    code: string;
    message: string;
  };
}

type CoreSupervisorLifecycle = "stopped" | "starting" | "running" | "stopping" | "exited" | "failed";

interface CoreSupervisorState {
  state: CoreSupervisorLifecycle;
  restartCount: number;
  startedAt: string | null;
  executable: string | null;
  pid: number | null;
  lastExit: {
    code: number | null;
    signal: string | null;
    at: string;
    error?: string;
  } | null;
  lastHandshake: {
    ok: boolean;
    at: string;
    version?: JsonValue;
    error?: string;
  } | null;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isDev = !app.isPackaged;
const expectedCoreProtocolVersion = "m0-jsonrpc-stdio-1";
const configuredRendererDevUrl = process.env.CANDOR_V3_RENDERER_URL?.trim() ?? "";
if (configuredRendererDevUrl && !isLoopbackHttpUrl(configuredRendererDevUrl)) {
  throw new Error("CANDOR_V3_RENDERER_URL must use loopback HTTP without credentials.");
}
const useDevRenderer = isDev && configuredRendererDevUrl.length > 0;
const rendererDevUrl = configuredRendererDevUrl || "http://127.0.0.1:5173";
const rendererDevEndpoint = new URL(rendererDevUrl);
const rendererFilePath = path.join(__dirname, "..", "renderer", "index.html");
const rendererFileUrl = pathToFileURL(rendererFilePath).href;
const MAX_CORE_STDERR_BYTES = 64 * 1024;
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
const rendererCoreMethods = new Set([
  "core.ping",
  "core.version",
  "core.capabilities",
  "core.status",
  "vault.openLocal",
  "vault.status",
  "privacy.auditSnapshot",
  "privacy.capabilities",
  "updates.status",
  "import.v2.status",
  "consent.status",
  "consent.acknowledge",
  "capture.status",
  "capture.devices",
  "capture.startMic",
  "capture.startSystem",
  "capture.startMicAndSystem",
  "capture.stop",
  "models.status",
  "models.listLocal",
  "models.verifyLocal",
  "ai.status",
  "ai.askHeuristic",
  "ai.recapHeuristic",
  "ai.instructAssetsStatus",
  "ai.instructStatus",
  "ai.askInstruct",
  "ai.recapInstruct",
  "ai.schedulerStatus",
  "transcription.status",
  "transcription.runLocal",
  "recording.durable.status",
  "recording.durable.listPage",
  "recording.durable.read",
  "recording.durable.replayManifest",
  "recording.durable.transcriptPage",
  "recording.privacyReceipt",
  "recording.durable.readAudioChunk",
  "recording.durable.search",
  "recording.notes.read",
  "recording.notes.save",
  "retention.status",
  "export.create",
]);

function isLoopbackHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      !url.username &&
      !url.password &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

function isRendererDevRequest(value: string): boolean {
  if (!useDevRenderer) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "ws:") &&
      url.hostname === rendererDevEndpoint.hostname &&
      url.port === rendererDevEndpoint.port
    );
  } catch {
    return false;
  }
}

function isRendererDevNavigation(value: string): boolean {
  if (!useDevRenderer) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" && url.origin === rendererDevEndpoint.origin;
  } catch {
    return false;
  }
}
const privateCoreMethods = new Set([
  ...rendererCoreMethods,
  "core.shutdown",
  "models.importStart",
  "models.importChunk",
  "models.importFinish",
  "models.importAbort",
  "ai.instructAssetsImportFromPath",
  "recording.durable.start",
  "recording.durable.writeTranscriptSegment",
  "recording.durable.finish",
  "import.v2.fromFolder",
  "import.v2.proofSynthetic",
]);
const rendererCoreTimeoutMs = new Map<string, number>([
  ["ai.askInstruct", 60_000],
  ["ai.recapInstruct", 60_000],
  ["models.verifyLocal", 120_000],
  ["transcription.runLocal", 120_000],
]);

let mainWindow: BrowserWindow | null = null;
let core: ChildProcessWithoutNullStreams | null = null;
let licenseService: LicenseService | null = null;
let coreHasStarted = false;
let handshakePromise: Promise<void> | null = null;
let nextRpcId = 1;
const networkGuard = {
  totalRequests: 0,
  localAllowedRequests: 0,
  externalAllowedRequests: 0,
  blockedRequests: 0,
  blockedSamples: [] as string[],
  deniedWindowOpenRequests: 0,
  deniedNavigationRequests: 0,
  deniedNavigationSamples: [] as string[],
};
const pending = new Map<
  number,
  {
    resolve: (value: CoreResponse) => void;
    reject: (reason: Error) => void;
    timeout: NodeJS.Timeout;
  }
>();
const coreSupervisor: CoreSupervisorState = {
  state: "stopped",
  restartCount: 0,
  startedAt: null,
  executable: null,
  pid: null,
  lastExit: null,
  lastHandshake: null,
};

app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("disable-component-update");
app.commandLine.appendSwitch("disable-domain-reliability");
app.commandLine.appendSwitch("disable-features", "AutofillServerCommunication,OptimizationHints");
app.commandLine.appendSwitch("no-proxy-server");
app.commandLine.appendSwitch("disable-sync");
if (isSmokeMode) {
  app.commandLine.appendSwitch("disable-gpu");
}

function coreExecutableName(): string {
  return process.platform === "win32" ? "candor-core.exe" : "candor-core";
}

function corePath(): string {
  if (isDev) {
    if (useDevRenderer) {
      return path.resolve(__dirname, "..", "..", "crates", "candor-core", "target", "debug", coreExecutableName());
    }
    return path.resolve(__dirname, "..", "..", "build", "core-bin", coreExecutableName());
  }
  return path.join(process.resourcesPath, "bin", coreExecutableName());
}

function rejectPending(reason: Error): void {
  for (const entry of pending.values()) {
    clearTimeout(entry.timeout);
    entry.reject(reason);
  }
  pending.clear();
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function noteCoreStart(executable: string): void {
  if (coreHasStarted) {
    coreSupervisor.restartCount += 1;
  }
  coreHasStarted = true;
  coreSupervisor.state = "starting";
  coreSupervisor.startedAt = new Date().toISOString();
  coreSupervisor.executable = executable;
  coreSupervisor.pid = null;
  coreSupervisor.lastExit = null;
  coreSupervisor.lastHandshake = null;
}

function supervisorSnapshot(): JsonValue {
  return {
    state: coreSupervisor.state,
    restartCount: coreSupervisor.restartCount,
    startedAt: coreSupervisor.startedAt,
    executableName: coreSupervisor.executable ? path.basename(coreSupervisor.executable) : null,
    rawPathExposed: false,
    pid: coreSupervisor.pid,
    lastExit: coreSupervisor.lastExit,
    lastHandshake: coreSupervisor.lastHandshake,
  };
}

function redactCoreDiagnostic(value: string): string {
  return value
    .replace(/\b[A-Za-z]:[\\/][^\r\n\t"']+/g, "<path>")
    .replace(/(?:^|\s)\/(?:Users|home|root|tmp|var|private)\/[^\s"']+/g, " <path>")
    .replace(/\b(?:sk-(?:live|prod)-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16})\b/g, "<secret>");
}

function startCore(): void {
  if (core) return;

  const executable = corePath();
  noteCoreStart(executable);
  const child = spawn(executable, [], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      CANDOR_CORE_TRANSPORT: "stdio-json-lines",
      CANDOR_NETWORK_POLICY: "disabled-by-default",
    },
  });
  core = child;
  coreSupervisor.pid = child.pid ?? null;

  const stdout = createInterface({ input: child.stdout });
  stdout.on("line", (line) => {
    let response: CoreResponse;
    try {
      response = JSON.parse(line) as CoreResponse;
    } catch {
      return;
    }
    const entry = pending.get(response.id);
    if (!entry) return;
    clearTimeout(entry.timeout);
    pending.delete(response.id);
    if (response.protocolVersion !== expectedCoreProtocolVersion || typeof response.ok !== "boolean") {
      entry.reject(new Error("candor-core returned an invalid versioned response envelope"));
      return;
    }
    entry.resolve(response);
  });

  let stderrBytesLogged = 0;
  let stderrSuppressionNoted = false;
  child.stderr.on("data", (chunk: Buffer) => {
    if (!isDev) {
      if (!stderrSuppressionNoted) {
        console.error("[candor-core] diagnostic output suppressed in packaged build");
        stderrSuppressionNoted = true;
      }
      return;
    }

    const remaining = MAX_CORE_STDERR_BYTES - stderrBytesLogged;
    if (remaining > 0) {
      const boundedChunk = chunk.subarray(0, remaining);
      stderrBytesLogged += boundedChunk.byteLength;
      const diagnostic = redactCoreDiagnostic(boundedChunk.toString("utf8")).trim();
      if (diagnostic) console.error(`[candor-core] ${diagnostic}`);
    }
    if (chunk.byteLength > remaining && !stderrSuppressionNoted) {
      console.error(`[candor-core] further diagnostic output suppressed after ${MAX_CORE_STDERR_BYTES} bytes`);
      stderrSuppressionNoted = true;
    }
  });

  child.on("spawn", () => {
    if (core === child) {
      coreSupervisor.state = "running";
      coreSupervisor.pid = child.pid ?? null;
    }
  });

  child.on("error", (error) => {
    if (core === child) {
      coreSupervisor.state = "failed";
      coreSupervisor.lastExit = {
        code: null,
        signal: null,
        at: new Date().toISOString(),
        error: error.message,
      };
    }
  });

  child.on("exit", (code, signal) => {
    if (core === child) {
      core = null;
      handshakePromise = null;
      coreSupervisor.pid = null;
      coreSupervisor.state = coreSupervisor.state === "stopping" ? "stopped" : "exited";
      coreSupervisor.lastExit = {
        code,
        signal,
        at: new Date().toISOString(),
      };
      rejectPending(new Error(`candor-core exited (${code ?? signal ?? "unknown"})`));
    }
  });
}

function callCore(method: string, params: JsonValue = null, timeoutMs = 5000): Promise<CoreResponse> {
  if (!privateCoreMethods.has(method)) {
    return Promise.reject(new Error(`IPC method is not allowed: ${method}`));
  }
  startCore();
  if (!core || core.killed || !core.stdin.writable) {
    return Promise.reject(new Error("candor-core is not available"));
  }

  const id = nextRpcId++;
  const payload = JSON.stringify({ id, method, params });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`candor-core timed out for ${method}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timeout });
    core?.stdin.write(`${payload}\n`, "utf8");
  });
}

async function ensureCoreHandshake(): Promise<void> {
  if (core && coreSupervisor.lastHandshake?.ok) return;
  if (handshakePromise) return handshakePromise;

  handshakePromise = (async () => {
    try {
      const response = await callCore("core.version");
      if (!response.ok) {
        throw new Error(response.error?.message ?? "candor-core version handshake failed");
      }
      coreSupervisor.lastHandshake = {
        ok: true,
        at: new Date().toISOString(),
        version: response.result ?? null,
      };
    } catch (error) {
      handshakePromise = null;
      coreSupervisor.lastHandshake = {
        ok: false,
        at: new Date().toISOString(),
        error: asErrorMessage(error),
      };
      throw error;
    }
  })();

  return handshakePromise;
}

function requireCoreResult(response: CoreResponse, method: string): JsonValue {
  if (!response.ok) {
    throw new Error(response.error?.message ?? `${method} failed`);
  }
  return response.result ?? null;
}

function objectValue(value: JsonValue): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value;
}

function stringField(value: JsonValue, field: string): string {
  const child = objectValue(value)[field];
  return typeof child === "string" ? child : "";
}

type LocalReportFormat = "markdown" | "docx" | "pdf";

interface LocalExportSpecification {
  extension: string;
  filterName: string;
  mimeType: string;
}

const localExportSpecifications: Record<LocalReportFormat, LocalExportSpecification> = {
  markdown: {
    extension: "md",
    filterName: "Markdown document",
    mimeType: "text/markdown; charset=utf-8",
  },
  docx: {
    extension: "docx",
    filterName: "Microsoft Word document",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  pdf: {
    extension: "pdf",
    filterName: "PDF document",
    mimeType: "application/pdf",
  },
};

function localReportFormat(value: JsonValue): LocalReportFormat | null {
  return value === "markdown" || value === "docx" || value === "pdf" ? value : null;
}

function sha256Bytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const MAX_LOCAL_EXPORT_INPUT_BYTES = 768 * 1024;
const MAX_LOCAL_EXPORT_BYTES = 16 * 1024 * 1024;

interface DecodedLocalExport {
  bytes: Buffer;
  fileName: string;
  mimeType: string;
}

function numberField(value: JsonValue, field: string): number {
  const child = objectValue(value)[field];
  return typeof child === "number" && Number.isSafeInteger(child) ? child : -1;
}

function decodeLocalExportResult(format: LocalReportFormat, result: JsonValue): DecodedLocalExport {
  const resultObject = objectValue(result);
  const specification = localExportSpecifications[format];
  if (stringField(result, "format") !== format) {
    throw new Error("candor-core returned an unexpected export format.");
  }
  if (stringField(result, "mimeType") !== specification.mimeType) {
    throw new Error("candor-core returned an unexpected export MIME type.");
  }
  if (
    resultObject.generatedLocally !== true ||
    resultObject.networkAttempted !== false ||
    resultObject.rawPathExposed !== false ||
    resultObject.keyMaterialExposedToRenderer !== false
  ) {
    throw new Error("candor-core did not return the required local export custody facts.");
  }

  let bytes: Buffer;
  if (format === "markdown") {
    const markdown = stringField(result, "markdown");
    bytes = Buffer.from(markdown, "utf8");
  } else {
    const dataBase64 = stringField(result, "dataBase64");
    if (
      !dataBase64 ||
      dataBase64.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64)
    ) {
      throw new Error("candor-core returned invalid document bytes.");
    }
    bytes = Buffer.from(dataBase64, "base64");
    if (bytes.toString("base64") !== dataBase64) {
      throw new Error("candor-core returned non-canonical document bytes.");
    }
  }

  const declaredBytes = numberField(result, "bytes");
  if (
    bytes.length === 0 ||
    declaredBytes !== bytes.length ||
    bytes.length > MAX_LOCAL_EXPORT_BYTES
  ) {
    throw new Error("candor-core returned an invalid local export size.");
  }
  if (format === "docx" && bytes.subarray(0, 2).toString("ascii") !== "PK") {
    throw new Error("candor-core did not return a native DOCX package.");
  }
  if (format === "pdf" && bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error("candor-core did not return a PDF document.");
  }

  const rawName = stringField(result, "fileName");
  const baseName = path.basename(rawName || `candor-report.${specification.extension}`);
  const fileName = baseName.toLowerCase().endsWith(`.${specification.extension}`)
    ? baseName
    : `${baseName}.${specification.extension}`;
  return { bytes, fileName, mimeType: specification.mimeType };
}

function getLicenseService(): LicenseService {
  licenseService ??= new LicenseService({ isDev });
  return licenseService;
}

function installSessionHardening(): void {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);

  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    networkGuard.totalRequests += 1;
    const url = new URL(details.url);
    const isLocalDev = isRendererDevRequest(details.url);
    const allowed =
      url.protocol === "file:" ||
      url.protocol === "devtools:" ||
      url.protocol === "data:" ||
      isLocalDev;
    if (allowed) {
      if (url.protocol === "file:" || url.protocol === "devtools:" || url.protocol === "data:") {
        networkGuard.localAllowedRequests += 1;
      } else {
        networkGuard.externalAllowedRequests += 1;
      }
    } else {
      networkGuard.blockedRequests += 1;
      if (networkGuard.blockedSamples.length < 5) {
        networkGuard.blockedSamples.push(`${url.protocol}//${url.hostname}`);
      }
    }
    callback({ cancel: !allowed });
  });
}

function networkGuardSnapshot(): JsonValue {
  return {
    totalRequests: networkGuard.totalRequests,
    localAllowedRequests: networkGuard.localAllowedRequests,
    externalAllowedRequests: networkGuard.externalAllowedRequests,
    blockedRequests: networkGuard.blockedRequests,
    blockedSamples: [...networkGuard.blockedSamples],
    deniedWindowOpenRequests: networkGuard.deniedWindowOpenRequests,
    deniedNavigationRequests: networkGuard.deniedNavigationRequests,
    deniedNavigationSamples: [...networkGuard.deniedNavigationSamples],
  };
}

function createWindow(options: { smoke?: boolean } = {}): BrowserWindow {
  const preload = path.join(__dirname, "preload.cjs");
  mainWindow = new BrowserWindow({
    width: options.smoke ? smokeWindowWidth : 1180,
    height: options.smoke ? smokeWindowHeight : 760,
    minWidth: 920,
    minHeight: 620,
    title: "Candor",
    show: false,
    webPreferences: {
      preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: useDevRenderer,
    },
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    networkGuard.deniedWindowOpenRequests += 1;
    if (networkGuard.deniedNavigationSamples.length < 5) {
      const category = details.url.startsWith("file:") ? "local-file" : "external";
      networkGuard.deniedNavigationSamples.push(`window-open-denied:${category}`);
    }
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, targetUrl) => {
    const allowed = useDevRenderer
      ? isRendererDevNavigation(targetUrl)
      : targetUrl === rendererFileUrl || targetUrl.startsWith(`${rendererFileUrl}#`);
    if (!allowed) {
      networkGuard.deniedNavigationRequests += 1;
      if (networkGuard.deniedNavigationSamples.length < 5) {
        const category = targetUrl.startsWith("file:") ? "local-file" : "external";
        networkGuard.deniedNavigationSamples.push(`navigation-denied:${category}`);
      }
      event.preventDefault();
    }
  });
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (!useDevRenderer && input.control && input.shift && input.key.toLowerCase() === "i") {
      event.preventDefault();
    }
  });

  if (useDevRenderer) {
    void mainWindow.loadURL(rendererDevUrl);
  } else {
    void mainWindow.loadFile(rendererFilePath);
  }
  mainWindow.once("ready-to-show", () => {
    if (!options.smoke) mainWindow?.show();
  });
  return mainWindow;
}

function waitForRendererLoad(windowRef: BrowserWindow): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Renderer load timed out during M0 smoke."));
    }, 15000);

    const cleanup = () => {
      clearTimeout(timeout);
      windowRef.webContents.removeListener("did-finish-load", onFinish);
      windowRef.webContents.removeListener("did-fail-load", onFail);
    };
    const onFinish = () => {
      cleanup();
      resolve();
    };
    const onFail = (_event: Electron.Event, errorCode: number, errorDescription: string) => {
      cleanup();
      reject(new Error(`Renderer failed to load (${errorCode}): ${errorDescription}`));
    };

    windowRef.webContents.once("did-finish-load", onFinish);
    windowRef.webContents.once("did-fail-load", onFail);
  });
}

async function waitForRendererView(
  windowRef: BrowserWindow,
  view: string,
  timeoutMs = 10000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const currentView = (await windowRef.webContents.executeJavaScript(
      `document.querySelector('[data-view]')?.getAttribute('data-view') ?? null`,
      true,
    )) as JsonValue;
    if (currentView === view) return;
    await delay(50);
  }
  throw new Error(`Renderer did not reach the ${view} view during M0 smoke.`);
}

async function writeSmokeResult(payload: JsonValue): Promise<void> {
  if (!smokeOutputPath) return;
  await mkdir(path.dirname(smokeOutputPath), { recursive: true });
  await writeFile(smokeOutputPath, JSON.stringify(payload, null, 2), "utf8");
}

function requestCoreShutdown(): void {
  if (!core || core.killed) return;
  coreSupervisor.state = "stopping";
  try {
    // Shutdown is fire-and-forget: process exit is the acknowledgement, so no pending RPC entry is registered.
    core.stdin.write(JSON.stringify({ id: nextRpcId++, method: "core.shutdown", params: null }) + "\n");
  } catch {
    core.kill();
  }
}

function waitForCoreExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`candor-core did not exit within ${timeoutMs} ms`));
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timeout);
      resolve();
    };
    child.once("exit", onExit);
  });
}

async function stopCoreForRestart(): Promise<void> {
  const child = core;
  if (!child || child.killed) return;
  requestCoreShutdown();
  await waitForCoreExit(child, 5000);
}

async function exerciseCoreRestartForSmoke(): Promise<JsonValue> {
  const before = supervisorSnapshot();
  await stopCoreForRestart();
  await ensureCoreHandshake();
  const status = await callCore("core.status");
  return {
    before,
    after: supervisorSnapshot(),
    status: status.result ?? null,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function seedDesignSmokeMeeting(): Promise<JsonValue> {
  const started = requireCoreResult(
    await callCore("recording.durable.start", { label: "Product Strategy Sync" }, 15000),
    "recording.durable.start",
  );
  const recordingId = stringField(started, "recordingId");
  if (!recordingId) throw new Error("Design smoke fixture did not return a recording id.");
  const segments = [
    { speaker: "Alex Morgan", text: "The export should read like a finished report, not a copy of the application screen.", startMs: 4000, durationMs: 4200 },
    { speaker: "Priya Mehta", text: "Keep the summary structured so local Word and PDF renderers can preserve every section.", startMs: 9200, durationMs: 4500 },
    { speaker: "Daniel Moss", text: "Keep notes beside the transcript and link each marked moment to its source timestamp.", startMs: 15000, durationMs: 4600 },
    { speaker: "Alex Morgan", text: "Decision: evidence links must stay visible in review and export previews.", startMs: 21800, durationMs: 4100 },
    { speaker: "Priya Mehta", text: "Action: validate the desktop layout at compact and reference window sizes.", startMs: 27400, durationMs: 4300 },
  ];
  for (const [index, segment] of segments.entries()) {
    requireCoreResult(
      await callCore(
        "recording.durable.writeTranscriptSegment",
        {
          recordingId,
          channel: index % 2 === 0 ? "mic" : "system",
          speaker: segment.speaker,
          text: segment.text,
          startMs: segment.startMs,
          durationMs: segment.durationMs,
          confidence: 0.97,
        },
        15000,
      ),
      "recording.durable.writeTranscriptSegment",
    );
  }
  requireCoreResult(
    await callCore(
      "recording.notes.save",
      {
        recordingId,
        markdown: "- Export must remain clean and editable\n- Keep transcript and notes visible together\n- Link marked moments to evidence",
      },
      15000,
    ),
    "recording.notes.save",
  );
  requireCoreResult(
    await callCore("recording.durable.finish", { recordingId }, 15000),
    "recording.durable.finish",
  );
  return {
    created: true,
    recordingId,
    transcriptSegmentCount: segments.length,
    notesSaved: true,
    localOnly: true,
    rawPathExposed: false,
  };
}

async function provePackagedDocumentExports(recordingId: string): Promise<JsonValue> {
  const report: JsonValue = {
    summary: "The team approved a local report workflow with editable Word output and searchable PDF evidence.",
    decisions: [
      {
        text: "Generate report documents inside candor-core.",
        speaker: "Alex Morgan",
        startMs: 4_000,
      },
    ],
    actions: [
      {
        text: "Validate the packaged export surface at both desktop breakpoints.",
        speaker: "Priya Mehta",
        startMs: 27_400,
        owner: "Priya Mehta",
        dueDate: "Not set",
        status: "Open",
      },
    ],
    risks: [
      {
        text: "Unsigned release artifacts remain outside this document proof.",
        speaker: "Daniel Moss",
        startMs: 15_000,
      },
    ],
    questions: [
      {
        text: "When will cross-platform signing evidence be available?",
        speaker: "Alex Morgan",
        startMs: 21_800,
      },
    ],
  };
  const options: JsonValue = {
    includeSummary: true,
    includeDecisions: true,
    includeActions: true,
    includeRisks: true,
    includeQuestions: true,
    includeNotes: true,
    includeTranscript: true,
    includeTimestamps: true,
    paperSize: "letter",
  };
  const formats = {} as Record<string, JsonValue>;

  for (const format of ["docx", "pdf"] as const) {
    const result = requireCoreResult(
      await callCore("export.create", { recordingId, format, report, options }, 30_000),
      `export.create:${format}`,
    );
    const decoded = decodeLocalExportResult(format, result);
    const resultObject = objectValue(result);
    if (format === "docx") {
      const archiveText = decoded.bytes.toString("latin1");
      if (
        resultObject.editable !== true ||
        !archiveText.includes("word/document.xml") ||
        !archiveText.includes("word/footer1.xml")
      ) {
        throw new Error("Packaged DOCX proof did not contain native editable Word structures.");
      }
    } else if (
      resultObject.searchableText !== true ||
      resultObject.bookmarks !== true ||
      numberField(result, "pageCount") < 1
    ) {
      throw new Error("Packaged PDF proof did not report searchable text and bookmarks.");
    }
    formats[format] = {
      fileName: decoded.fileName,
      mimeType: decoded.mimeType,
      bytes: decoded.bytes.length,
      sha256: sha256Bytes(decoded.bytes),
      editable: resultObject.editable === true,
      searchableText: resultObject.searchableText === true,
      bookmarks: resultObject.bookmarks === true,
      pageCount: Math.max(0, numberField(result, "pageCount")),
      nativeSignatureVerified: true,
    };
  }

  return {
    proven: true,
    formats,
    localOnly: true,
    generatedLocally: true,
    networkAttempted: false,
    rawPathExposed: false,
    keyMaterialExposedToRenderer: false,
  };
}

function smokeViewScreenshotPath(basePath: string, view: string): string {
  const parsed = path.parse(basePath);
  return path.join(parsed.dir, `${parsed.name}-${view}${parsed.ext || ".png"}`);
}

async function captureSettledSmokePage(
  windowRef: BrowserWindow,
  outputPath: string,
): Promise<JsonValue> {
  const notificationDismissed = (await windowRef.webContents.executeJavaScript(
    `
      (() => {
        const button = document.querySelector('[aria-label="Dismiss notification"]');
        if (!(button instanceof HTMLButtonElement)) return false;
        button.click();
        return true;
      })()
    `,
    true,
  )) as boolean;
  if (notificationDismissed) await delay(80);
  const originalBounds = windowRef.getBounds();
  windowRef.setBounds({ ...originalBounds, width: Math.max(960, originalBounds.width - 1) }, false);
  await delay(60);
  windowRef.setBounds(originalBounds, false);
  await delay(180);
  await delay(240);
  windowRef.webContents.invalidate();
  await delay(80);
  const firstImage = await windowRef.webContents.capturePage();
  windowRef.webContents.invalidate();
  await delay(60);
  const secondImage = await windowRef.webContents.capturePage();
  windowRef.webContents.invalidate();
  await delay(100);
  const thirdImage = await windowRef.webContents.capturePage();
  const captures = [firstImage, secondImage, thirdImage].map((image) => ({
    image,
    png: image.toPNG(),
  }));
  const selectedCapture = captures.reduce((best, candidate) =>
    candidate.png.length > best.png.length ? candidate : best,
  );
  const png = selectedCapture.png;
  const size = selectedCapture.image.getSize();
  const state = (await windowRef.webContents.executeJavaScript(
    `({
      currentView: document.querySelector('[data-view]')?.getAttribute('data-view') ?? null,
      bodyTextCharacters: document.body?.innerText?.length ?? 0
    })`,
    true,
  )) as JsonValue;
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, png);
  return {
    ...objectValue(state),
    notificationDismissed,
    path: outputPath,
    captured: true,
    forcedWindowRepaint: true,
    warmupCapture: true,
    captureCandidates: captures.map((candidate) => candidate.png.length),
    bytes: png.length,
    width: size.width,
    height: size.height,
  };
}

async function clickSmokeButton(windowRef: BrowserWindow, label: string): Promise<void> {
  const clicked = (await windowRef.webContents.executeJavaScript(
    `(() => {
      const button = Array.from(document.querySelectorAll('button'))
        .find((node) => node.textContent?.trim() === ${JSON.stringify(label)});
      if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
      button.click();
      return true;
    })()`,
    true,
  )) as JsonValue;
  if (clicked !== true) throw new Error(`Smoke could not activate the ${label} button.`);
}

async function captureSmokeView(
  windowRef: BrowserWindow,
  view: string,
  navLabel: string,
): Promise<JsonValue> {
  const navigation = (await windowRef.webContents.executeJavaScript(
    `
      (async () => {
        const settle = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const clickExact = async (selector, label) => {
          const button = Array.from(document.querySelectorAll(selector))
            .find((node) => node.textContent?.trim() === label);
          if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
          button.click();
          await settle();
          return true;
        };
        let clicked = false;
        const targetView = ${JSON.stringify(view)};
        if (targetView === 'home') {
          const wordmark = document.querySelector('.wordmark');
          if (wordmark instanceof HTMLButtonElement && !wordmark.disabled) {
            wordmark.click();
            await settle();
            clicked = true;
          }
        } else if (targetView === 'library') {
          clicked = await clickExact('.desktop-nav button', 'Meetings');
        } else if (targetView === 'detail') {
          if (document.querySelector('[data-view]')?.getAttribute('data-view') !== 'library') {
            await clickExact('.desktop-nav button', 'Meetings');
          }
          const row = document.querySelector('.library-row');
          if (row instanceof HTMLButtonElement && !row.disabled) {
            row.click();
            await settle();
            clicked = true;
          }
        } else if (targetView === 'review') {
          clicked = await clickExact('button', 'Review report');
          if (!clicked) clicked = await clickExact('button', 'Review meeting');
        } else if (targetView === 'export') {
          clicked = await clickExact('.desktop-nav button', 'Exports');
        } else if (targetView === 'settings') {
          clicked = await clickExact('.desktop-nav button', 'Settings');
        } else if (targetView === 'proof') {
          await clickExact('.desktop-nav button', 'Settings');
          const advanced = document.querySelector('.advanced-settings-toggle');
          if (advanced instanceof HTMLButtonElement && advanced.getAttribute('aria-expanded') !== 'true') {
            advanced.click();
            await settle();
          }
          await clickExact('.settings-layout nav button', 'Privacy and diagnostics');
          clicked = await clickExact('button', 'Open full diagnostics');
        }
        if (!clicked) return { clicked: false, reason: 'workflow-navigation-unavailable' };
        for (let index = 0; index < 80; index += 1) {
          const current = document.querySelector('[data-view]')?.getAttribute('data-view');
          if (current === targetView) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        if (${JSON.stringify(view)} === 'detail') {
          const generate = Array.from(document.querySelectorAll('button'))
            .find((node) => node.textContent?.trim() === 'Generate local recap');
          if (generate instanceof HTMLButtonElement && !generate.disabled) {
            generate.click();
            for (let index = 0; index < 40; index += 1) {
              await new Promise((resolve) => setTimeout(resolve, 50));
              if (!generate.disabled) break;
            }
          }
        }
        return {
          clicked,
          currentView: document.querySelector('[data-view]')?.getAttribute('data-view') ?? null,
          bodyTextCharacters: document.body?.innerText?.length ?? 0,
          exportFormats: Array.from(document.querySelectorAll('.format-options button')).map((button) => ({
            label: button.textContent?.replace(/\s+/g, ' ').trim() ?? '',
            disabled: button instanceof HTMLButtonElement ? button.disabled : true,
            pressed: button.getAttribute('aria-pressed') === 'true'
          })),
          exportSaveAction: (() => {
            const button = document.querySelector('[data-export-save]');
            return {
              visible: button instanceof HTMLButtonElement,
              disabled: button instanceof HTMLButtonElement ? button.disabled : true,
              label: button?.textContent?.trim() ?? ''
            };
          })()
        };
      })()
    `,
    true,
  )) as JsonValue;
  const outputPath = smokeViewScreenshotPath(smokeScreenshotPath, view);
  const capture = await captureSettledSmokePage(windowRef, outputPath);
  return {
    ...objectValue(capture),
    view,
    navLabel,
    navigation,
  };
}

function numberSnapshotField(snapshot: JsonValue, field: string): number {
  const value = objectValue(snapshot)[field];
  return typeof value === "number" ? value : 0;
}

function snapshotDelta(before: JsonValue, after: JsonValue, field: string): number {
  return numberSnapshotField(after, field) - numberSnapshotField(before, field);
}

function classifyAbsolutePath(value: string): string | null {
  if (/(?:^|[^A-Za-z0-9+.-])[A-Za-z]:[\\/]/.test(value)) return "windows-absolute-path";
  if (/\\\\[^\\\s]+[\\/]/.test(value)) return "windows-unc-path";
  if (/file:\/\//i.test(value)) return "file-url";
  if (/(?:^|[\s("'=])\/(?:Users|home|root|tmp|var|private|etc|usr|opt|Applications)(?:\/|$)/.test(value)) {
    return "posix-absolute-path";
  }
  return null;
}

function auditRendererFacingPaths(value: JsonValue): JsonValue {
  const findings: JsonValue[] = [];
  let scannedStrings = 0;

  const visit = (candidate: JsonValue, field: string): void => {
    if (typeof candidate === "string") {
      scannedStrings += 1;
      const kind = classifyAbsolutePath(candidate);
      if (kind && findings.length < 20) findings.push({ field, kind });
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach((child, index) => visit(child, `${field}[${index}]`));
      return;
    }
    if (candidate && typeof candidate === "object") {
      for (const [key, child] of Object.entries(candidate)) visit(child, `${field}.${key}`);
    }
  };

  visit(value, "$renderer");
  return {
    ok: findings.length === 0,
    scannedStrings,
    findings,
  };
}

async function runRendererIsolationProbe(windowRef: BrowserWindow): Promise<JsonValue> {
  return (await windowRef.webContents.executeJavaScript(
    `
      (() => {
        const root = globalThis;
        const candor = root.candor;
        const core = candor?.core ?? {};
        const license = candor?.license ?? {};
        const shell = candor?.shell ?? {};
        const coreKeys = Object.keys(core).sort();
        const licenseKeys = Object.keys(license).sort();
        const shellKeys = Object.keys(shell).sort();
        const forbiddenCoreKeys = [
          "callCore",
          "modelsImportStart",
          "modelsImportChunk",
          "modelsImportFinish",
          "modelsImportAbort",
          "aiInstructAssetsImportFromPath",
          "importV2FromFolderRaw",
          "openDialog",
          "readFile",
          "writeFile",
          "spawn",
          "exec"
        ];
        const forbiddenShellKeys = ["openExternal", "shellOpenExternal"];
        const forbiddenLicenseKeys = ["readFile", "writeFile", "storagePath", "openExternal"];
        const forbiddenGlobals = ["require", "process", "ipcRenderer", "electron"];
        return {
          attempted: true,
          candorPresent: Boolean(candor && typeof candor === "object"),
          coreFrozen: Boolean(candor?.core && Object.isFrozen(candor.core)),
          licenseFrozen: Boolean(candor?.license && Object.isFrozen(candor.license)),
          shellFrozen: Boolean(candor?.shell && Object.isFrozen(candor.shell)),
          coreKeys,
          licenseKeys,
          shellKeys,
          forbiddenCoreKeysPresent: forbiddenCoreKeys.filter((key) => key in core),
          forbiddenLicenseKeysPresent: forbiddenLicenseKeys.filter((key) => key in license),
          forbiddenShellKeysPresent: forbiddenShellKeys.filter((key) => key in shell),
          forbiddenGlobalsPresent: forbiddenGlobals.filter((key) => key in root),
          nodeRequireAvailable: typeof root.require === "function",
          nodeProcessAvailable: typeof root.process !== "undefined",
          ipcRendererAvailable: typeof root.ipcRenderer !== "undefined",
          electronGlobalAvailable: typeof root.electron !== "undefined",
          keyMaterialExposedToRenderer: false
        };
      })()
    `,
    true,
  )) as JsonValue;
}

async function runNetworkBlockProbe(windowRef: BrowserWindow): Promise<JsonValue> {
  const probeUrl = "https://example.invalid/candor-m0-network-probe";
  const before = networkGuardSnapshot();
  const rendererFetch = (await windowRef.webContents.executeJavaScript(
    `
      fetch("${probeUrl}?renderer-fetch=1", { cache: "no-store" })
        .then(() => ({ attempted: true, blocked: false, errorName: null, errorMessage: null }))
        .catch((error) => ({
          attempted: true,
          blocked: true,
          errorName: error?.name ?? "Error",
          errorMessage: String(error?.message ?? error)
        }))
    `,
    true,
  )) as JsonValue;
  const windowOpen = (await windowRef.webContents.executeJavaScript(
    `
      (() => {
        const opened = window.open("${probeUrl}?window-open=1", "_blank");
        if (opened) opened.close();
        return { attempted: true, denied: opened === null };
      })()
    `,
    true,
  )) as JsonValue;
  const navigationBefore = windowRef.webContents.getURL();
  await windowRef.webContents.executeJavaScript(
    `window.location.assign("${probeUrl}?navigation=1"); true`,
    true,
  );
  await delay(250);
  const navigationAfter = windowRef.webContents.getURL();
  const localFileProbeUrl = process.platform === "win32" ? "file:///C:/Windows/win.ini" : "file:///etc/hosts";
  const fileNavigationBefore = windowRef.webContents.getURL();
  await windowRef.webContents.executeJavaScript(
    `window.location.assign(${JSON.stringify(localFileProbeUrl)}); true`,
    true,
  );
  await delay(250);
  const fileNavigationAfter = windowRef.webContents.getURL();
  const afterRenderer = networkGuardSnapshot();

  const sessionProbeBefore = networkGuardSnapshot();
  const sessionProbeWindow = new BrowserWindow({
    width: 320,
    height: 200,
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  try {
    await sessionProbeWindow.loadURL(
      "data:text/html;charset=utf-8," +
        encodeURIComponent("<!doctype html><title>Candor network guard probe</title>"),
    );
    const sessionFetch = (await sessionProbeWindow.webContents.executeJavaScript(
      `
        fetch("${probeUrl}?session-guard=1", { cache: "no-store" })
          .then(() => ({ attempted: true, blocked: false, errorName: null, errorMessage: null }))
          .catch((error) => ({
            attempted: true,
            blocked: true,
            errorName: error?.name ?? "Error",
            errorMessage: String(error?.message ?? error)
          }))
      `,
      true,
    )) as JsonValue;
    await delay(100);
    const sessionProbeAfter = networkGuardSnapshot();
    return {
      renderer: {
        before,
        after: afterRenderer,
        fetch: rendererFetch,
        windowOpen,
        navigation: {
          attempted: true,
          stayedInApp: navigationAfter === navigationBefore,
        },
        fileNavigation: {
          attempted: true,
          stayedInApp: fileNavigationAfter === fileNavigationBefore,
        },
        externalAllowedDelta: snapshotDelta(before, afterRenderer, "externalAllowedRequests"),
        blockedDelta: snapshotDelta(before, afterRenderer, "blockedRequests"),
        deniedWindowOpenDelta: snapshotDelta(before, afterRenderer, "deniedWindowOpenRequests"),
        deniedNavigationDelta: snapshotDelta(before, afterRenderer, "deniedNavigationRequests"),
      },
      sessionGuard: {
        before: sessionProbeBefore,
        after: sessionProbeAfter,
        fetch: sessionFetch,
        externalAllowedDelta: snapshotDelta(
          sessionProbeBefore,
          sessionProbeAfter,
          "externalAllowedRequests",
        ),
        blockedDelta: snapshotDelta(sessionProbeBefore, sessionProbeAfter, "blockedRequests"),
      },
    };
  } finally {
    sessionProbeWindow.destroy();
  }
}

async function runM0Smoke(): Promise<void> {
  try {
    installSessionHardening();
    await ensureCoreHandshake();
    const restartExercise = await exerciseCoreRestartForSmoke();
    const designFixture = await seedDesignSmokeMeeting();
    const documentExportFixture = await provePackagedDocumentExports(
      stringField(designFixture, "recordingId"),
    );
    const windowRef = createWindow({ smoke: true });
    await waitForRendererLoad(windowRef);
    windowRef.showInactive();
    const rendererOnboardingScreenshots: JsonValue[] = [];
    await waitForRendererView(windowRef, "activation");
    if (smokeScreenshotPath) {
      rendererOnboardingScreenshots.push(
        await captureSettledSmokePage(
          windowRef,
          smokeViewScreenshotPath(smokeScreenshotPath, "activation"),
        ),
      );
    }
    await clickSmokeButton(windowRef, "Start Trial");
    await waitForRendererView(windowRef, "onboarding");
    if (smokeScreenshotPath) {
      rendererOnboardingScreenshots.push(
        await captureSettledSmokePage(
          windowRef,
          smokeViewScreenshotPath(smokeScreenshotPath, "onboarding"),
        ),
      );
    }
    await clickSmokeButton(windowRef, "Open App");
    await waitForRendererView(windowRef, "home");
    await clickSmokeButton(windowRef, "Current meeting");
    await waitForRendererView(windowRef, "meeting");
    const smokeLicense = await getLicenseService().status();
    const licenseFixture: JsonValue = {
      state: smokeLicense.state,
      activationSource: smokeLicense.activationSource,
      persistentAccountRequired: smokeLicense.persistentAccountRequired,
      localOnly: smokeLicense.localOnly,
      rawPathExposed: smokeLicense.rawPathExposed,
      keyMaterialExposedToRenderer: smokeLicense.keyMaterialExposedToRenderer,
    };

    const rendererBridge = (await windowRef.webContents.executeJavaScript(
      `
        (async () => {
          if (!window.candor?.core) {
            throw new Error("Candor preload bridge is not present.");
          }
          const [status, capabilities, auditSnapshot, updateStatus, importStatus, consentStatus, aiStatus, instructAssetsStatus, instructStatus, schedulerStatus, transcriptionStatus, vaultStatusBeforeOpen, licenseStatus, licensePortalInfo] = await Promise.all([
            window.candor.core.status(),
            window.candor.core.capabilities(),
            window.candor.core.privacyAuditSnapshot(),
            window.candor.core.updateStatus(),
            window.candor.core.v2ImportStatus(),
            window.candor.core.consentStatus(),
            window.candor.core.aiStatus(),
            window.candor.core.aiInstructAssetsStatus(),
            window.candor.core.aiInstructStatus(),
            window.candor.core.aiSchedulerStatus(),
            window.candor.core.transcriptionStatus(),
            window.candor.core.vaultStatus(),
            window.candor.license.status(),
            window.candor.license.portalInfo()
          ]);
          const vaultOpenLocal = vaultStatusBeforeOpen.localOpenAvailable
            ? await window.candor.core.vaultOpenLocal()
            : {
                skipped: true,
                reason: "native-os-key-storage-unavailable",
                keyMaterialExposedToRenderer: false,
                rawPathExposed: false
              };
          const vaultStatus = await window.candor.core.vaultStatus();
          const supervisorStatus = await window.candor.shell.supervisorStatus();
          return {
            preloadBridgePresent: true,
            shell: {
              externalNavigationDisabled: window.candor.shell.externalNavigationDisabled,
              networkPolicy: window.candor.shell.networkPolicy
            },
            supervisorStatus,
            status,
            capabilities,
            updateStatus,
            importStatus,
            consentStatus,
            aiStatus,
            instructAssetsStatus,
            instructStatus,
            schedulerStatus,
            transcriptionStatus,
            vaultStatusBeforeOpen,
            vaultStatus,
            vaultOpenLocal,
            auditSnapshot,
            licenseStatus,
            licensePortalInfo
          };
        })()
      `,
      true,
    )) as JsonValue;

    const rendererIsolationProbe = await runRendererIsolationProbe(windowRef);
    const networkBlockProbe = await runNetworkBlockProbe(windowRef);
    const rendererVisualState = (await windowRef.webContents.executeJavaScript(
      `
        (async () => {
          const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
          const suggestionsTab = tabs.find((node) => node.textContent?.trim().startsWith('AI suggestions'));
          const notesTab = tabs.find((node) => node.textContent?.trim() === 'My notes');
          suggestionsTab?.click();
          await new Promise((resolve) => setTimeout(resolve, 80));
          const mode = document.querySelector('[aria-label="Local AI mode"]');
          const quality = mode?.querySelector('[aria-pressed="true"]');
          const status = document.querySelector('#local-ai-mode-status');
          const currentView = document.querySelector('[data-view="meeting"]');
          const aiSuggestionsTabActivated = suggestionsTab?.getAttribute('aria-selected') === 'true';
          notesTab?.click();
          await new Promise((resolve) => setTimeout(resolve, 80));
          return {
            bodyTextCharacters: document.body?.innerText?.length ?? 0,
            aiModeVisible: Boolean(mode),
            selectedMode: quality?.textContent?.trim() ?? null,
            statusText: status?.textContent?.trim() ?? null,
            aiSuggestionsTabActivated,
            notesTabRestored: notesTab?.getAttribute('aria-selected') === 'true',
            currentView: currentView?.getAttribute('data-view') ?? null,
            sessionRailVisible: Boolean(document.querySelector('.session-rail')),
            sessionTabsVisible: Boolean(document.querySelector('.session-tabs')),
            recordActionVisible: Boolean(document.querySelector('.sidebar-record-action')),
            transcriptVisible: Boolean(document.querySelector('.live-transcript')),
            notesVisible: Boolean(document.querySelector('.meeting-notes-panel')),
            remoteImages: Array.from(document.images).filter((node) => /^https?:/i.test(node.src)).length
          };
        })()
      `,
      true,
    )) as JsonValue;
    let rendererScreenshot: JsonValue = {
      captured: false,
      bytes: 0,
      width: 0,
      height: 0,
    };
    const rendererViewScreenshots: JsonValue[] = [];
    if (smokeScreenshotPath) {
      rendererScreenshot = await captureSettledSmokePage(windowRef, smokeScreenshotPath);
      const views: Array<[string, string]> = [
        ["home", "Candor wordmark"],
        ["library", "Meetings"],
        ["detail", "Open meeting"],
        ["review", "Review report"],
        ["export", "Exports"],
        ["settings", "Settings"],
        ["proof", "Privacy and diagnostics"],
      ];
      for (const [view, navLabel] of views) {
        rendererViewScreenshots.push(await captureSmokeView(windowRef, view, navLabel));
      }
      windowRef.hide();
    }
    const mainStatus = await callCore("core.status");
    const rendererPathAudit = auditRendererFacingPaths({
      rendererBridge,
      rendererIsolationProbe,
      rendererVisualState,
      licenseFixture,
      networkBlockProbe,
      designFixture,
      documentExportFixture,
    });
    const rawPathExposed = objectValue(rendererPathAudit).ok !== true;
    if (rawPathExposed) {
      throw new Error("Renderer-facing smoke payload exposed an absolute local path.");
    }
    const rendererIsolationEvidence: JsonValue = {
      ...objectValue(rendererIsolationProbe),
      rawPathExposed,
    };
    const networkBlockEvidence: JsonValue = {
      ...objectValue(networkBlockProbe),
      rawPathExposed,
    };
    await writeSmokeResult({
      ok: true,
      mode: "m0-packaged-runtime-smoke",
      generatedAt: new Date().toISOString(),
      platform: process.platform,
      arch: process.arch,
      requestedViewport: {
        width: smokeWindowWidth,
        height: smokeWindowHeight,
        scaleFactor: smokeScaleFactor,
      },
      appIsPackaged: app.isPackaged,
      corePath: corePath(),
      rendererBridge,
      mainRpc: {
        status: mainStatus.result ?? null,
      },
      sidecarSupervisor: supervisorSnapshot(),
      restartExercise,
      rendererIsolationProbe: rendererIsolationEvidence,
      rendererPathAudit,
      rendererVisualState,
      rendererScreenshot,
      rendererOnboardingScreenshots,
      rendererViewScreenshots,
      designFixture,
      documentExportFixture,
      licenseFixture,
      networkBlockProbe: networkBlockEvidence,
      sessionNetworkGuard: networkGuardSnapshot(),
    });
    requestCoreShutdown();
    app.exit(0);
  } catch (error) {
    await writeSmokeResult({
      ok: false,
      mode: "m0-packaged-runtime-smoke",
      generatedAt: new Date().toISOString(),
      platform: process.platform,
      arch: process.arch,
      appIsPackaged: app.isPackaged,
      error: error instanceof Error ? error.message : String(error),
    });
    requestCoreShutdown();
    app.exit(1);
  }
}

ipcMain.handle("candor-core:call", async (_event, method: string, params?: JsonValue) => {
  if (!rendererCoreMethods.has(method)) {
    throw new Error(`Renderer method is not allowed: ${method}`);
  }
  const response = await callCore(
    method,
    params ?? null,
    rendererCoreTimeoutMs.get(method) ?? 5000,
  );
  if (!response.ok) {
    throw new Error(response.error?.message ?? "candor-core request failed");
  }
  return response.result ?? null;
});

ipcMain.handle("candor-export:saveLocal", async (_event, params?: JsonValue) => {
  const input = objectValue(params ?? null);
  const recordingId = typeof input.recordingId === "string" ? input.recordingId.trim() : "";
  const format = localReportFormat(input.format);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(recordingId)) {
    throw new Error("A valid local recording id is required for export.");
  }
  if (!format) {
    throw new Error("Local report format must be markdown, docx, or pdf.");
  }
  if (!input.report || typeof input.report !== "object" || Array.isArray(input.report)) {
    throw new Error("A structured local report is required for document export.");
  }
  if (!input.options || typeof input.options !== "object" || Array.isArray(input.options)) {
    throw new Error("Local document export options are required.");
  }
  if (Buffer.byteLength(JSON.stringify(input), "utf8") > MAX_LOCAL_EXPORT_INPUT_BYTES) {
    throw new Error("Local report input exceeds the export boundary limit.");
  }

  const result = requireCoreResult(
    await callCore("export.create", input, 30_000),
    "export.create",
  );
  const decoded = decodeLocalExportResult(format, result);
  const specification = localExportSpecifications[format];
  const options: Electron.SaveDialogOptions = {
    title: `Save local ${format === "docx" ? "Word" : format === "pdf" ? "PDF" : "Markdown"} report`,
    buttonLabel: "Save",
    defaultPath: decoded.fileName,
    filters: [{ name: specification.filterName, extensions: [specification.extension] }],
  };
  const selection = mainWindow
    ? await dialog.showSaveDialog(mainWindow, options)
    : await dialog.showSaveDialog(options);
  if (selection.canceled || !selection.filePath) {
    return {
      canceled: true,
      saved: false,
      format,
      fileName: decoded.fileName,
      savedLocally: false,
      networkAttempted: false,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
  }

  const destinationPath = selection.filePath.toLowerCase().endsWith(`.${specification.extension}`)
    ? selection.filePath
    : `${selection.filePath}.${specification.extension}`;
  await writeFile(destinationPath, decoded.bytes, { flag: "w", mode: 0o600 });
  const savedStat = await stat(destinationPath);
  if (!savedStat.isFile() || savedStat.size !== decoded.bytes.length) {
    throw new Error("The local report could not be verified after saving.");
  }

  const resultObject = objectValue(result);
  return {
    canceled: false,
    saved: true,
    format,
    fileName: path.basename(destinationPath),
    mimeType: decoded.mimeType,
    bytes: decoded.bytes.length,
    sha256: sha256Bytes(decoded.bytes),
    pageCount: Math.max(0, numberField(result, "pageCount")),
    warningCount: Math.max(0, numberField(result, "warningCount")),
    editable: resultObject.editable === true,
    searchableText: resultObject.searchableText === true,
    bookmarks: resultObject.bookmarks === true,
    ...(format === "markdown" ? { markdown: stringField(result, "markdown") } : {}),
    savedLocally: true,
    generatedLocally: true,
    networkAttempted: false,
    rawPathExposed: false,
    keyMaterialExposedToRenderer: false,
  };
});

ipcMain.handle("candor-models:importFromFile", async (_event, params?: JsonValue) => {
  const input = objectValue(params ?? null);
  const modelId = typeof input.modelId === "string" ? input.modelId : "";
  const replace = input.replace === true;
  if (!modelId.trim()) {
    throw new Error("A model id is required for model import.");
  }

  const options: Electron.OpenDialogOptions = {
    title: "Import local Whisper model",
    buttonLabel: "Import",
    properties: ["openFile"],
    filters: [
      { name: "Whisper GGML model", extensions: ["bin"] },
      { name: "All files", extensions: ["*"] },
    ],
  };
  const selection = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  const selectedPath = selection.filePaths[0];
  if (selection.canceled || !selectedPath) {
    return {
      canceled: true,
      imported: false,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
  }

  const selectedStat = await stat(selectedPath);
  if (!selectedStat.isFile()) {
    throw new Error("Selected model import target is not a file.");
  }

  const start = requireCoreResult(
    await callCore(
      "models.importStart",
      {
        modelId,
        expectedBytes: selectedStat.size,
        replace,
      },
      15000,
    ),
    "models.importStart",
  );
  const importId = stringField(start, "importId");
  if (!importId) {
    throw new Error("candor-core did not return a model import id.");
  }

  let bytesRead = 0;
  try {
    for await (const chunk of createReadStream(selectedPath, { highWaterMark: 512 * 1024 })) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytesRead += buffer.length;
      requireCoreResult(
        await callCore(
          "models.importChunk",
          {
            importId,
            dataBase64: buffer.toString("base64"),
          },
          30000,
        ),
        "models.importChunk",
      );
    }

    const finish = requireCoreResult(
      await callCore("models.importFinish", { importId }, 120000),
      "models.importFinish",
    );
    return {
      ...objectValue(finish),
      canceled: false,
      sourceFileName: path.basename(selectedPath),
      bytesRead,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
  } catch (error) {
    await callCore("models.importAbort", { importId }, 15000).catch(() => undefined);
    throw error;
  }
});

ipcMain.handle("candor-instruct-assets:importFromFile", async (_event, params?: JsonValue) => {
  const input = objectValue(params ?? null);
  const assetKind = input.assetKind === "runner" || input.assetKind === "model"
    ? input.assetKind
    : "";
  const expectedSha256 = typeof input.expectedSha256 === "string"
    ? input.expectedSha256.trim().toLowerCase()
    : "";
  const replace = input.replace === true;
  if (!assetKind) {
    throw new Error("Local AI asset kind must be runner or model.");
  }
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new Error("Expected SHA-256 must contain exactly 64 hexadecimal characters.");
  }

  const filters: Electron.FileFilter[] = assetKind === "model"
    ? [
        { name: "GGUF model", extensions: ["gguf"] },
        { name: "All files", extensions: ["*"] },
      ]
    : process.platform === "win32"
      ? [
          { name: "llama.cpp runner", extensions: ["exe"] },
          { name: "All files", extensions: ["*"] },
        ]
      : [{ name: "All files", extensions: ["*"] }];
  const options: Electron.OpenDialogOptions = {
    title: assetKind === "model" ? "Import local GGUF model" : "Import local llama.cpp runner",
    buttonLabel: "Verify and import",
    properties: ["openFile"],
    filters,
  };
  const selection = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  const selectedPath = selection.filePaths[0];
  if (selection.canceled || !selectedPath) {
    return {
      canceled: true,
      imported: false,
      sourcePathExposed: false,
      managedPathExposed: false,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
  }

  const selectedStat = await stat(selectedPath);
  if (!selectedStat.isFile()) {
    throw new Error("Selected local AI asset is not a file.");
  }
  const result = requireCoreResult(
    await callCore(
      "ai.instructAssetsImportFromPath",
      {
        assetKind,
        sourcePath: selectedPath,
        expectedSha256,
        replace,
      },
      10 * 60_000,
    ),
    "ai.instructAssetsImportFromPath",
  );
  return {
    ...objectValue(result),
    canceled: false,
    sourceFileName: path.basename(selectedPath),
    selectedBytes: selectedStat.size,
    sourcePathExposed: false,
    managedPathExposed: false,
    rawPathExposed: false,
    keyMaterialExposedToRenderer: false,
  };
});

ipcMain.handle("candor-import:v2FromFolder", async () => {
  const options: Electron.OpenDialogOptions = {
    title: "Import Candor v2 folder",
    buttonLabel: "Import",
    properties: ["openDirectory"],
  };
  const selection = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  const selectedPath = selection.filePaths[0];
  if (selection.canceled || !selectedPath) {
    return {
      canceled: true,
      importedCount: 0,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
  }

  const selectedStat = await stat(selectedPath);
  if (!selectedStat.isDirectory()) {
    throw new Error("Selected v2 import target is not a folder.");
  }

  const result = requireCoreResult(
    await callCore(
      "import.v2.fromFolder",
      {
        sourcePath: selectedPath,
      },
      120000,
    ),
    "import.v2.fromFolder",
  );
  return {
    ...objectValue(result),
    canceled: false,
    sourceFolderName: path.basename(selectedPath),
    rawPathExposed: false,
    keyMaterialExposedToRenderer: false,
  };
});

ipcMain.handle("candor-license:status", async () => getLicenseService().status());

ipcMain.handle("candor-license:activate", async (_event, params?: JsonValue) => {
  const input = objectValue(params ?? null);
  const licenseKey = typeof input.licenseKey === "string" ? input.licenseKey : "";
  const purchaserEmail = typeof input.purchaserEmail === "string" ? input.purchaserEmail : "";
  return getLicenseService().activate(licenseKey, purchaserEmail);
});

ipcMain.handle("candor-license:startTrial", async () => getLicenseService().startTrial());

ipcMain.handle("candor-license:deactivateDevice", async () => getLicenseService().deactivateDevice());

ipcMain.handle("candor-license:portalInfo", async () => getLicenseService().portalInfo());

ipcMain.handle("candor-shell:openExternal", async (_event, _url: string) => {
  throw new Error("External navigation is disabled during M0.");
});

ipcMain.handle("candor-shell:supervisorStatus", async () => supervisorSnapshot());

app.on("web-contents-created", (_event, contents) => {
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
});

app.whenReady().then(async () => {
  app.setAppUserModelId("com.candor.v3");
  if (isSmokeMode) {
    void runM0Smoke();
    return;
  }
  installSessionHardening();
  try {
    await ensureCoreHandshake();
  } catch (error) {
    console.error(`[candor-core] startup handshake failed: ${asErrorMessage(error)}`);
  }
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("before-quit", () => {
  void shell;
  requestCoreShutdown();
});
