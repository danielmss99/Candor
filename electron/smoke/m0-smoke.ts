import { app, BrowserWindow } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CoreClient } from "../core/core-client.js";
import { objectValue, stringField, type JsonValue } from "../core/json.js";
import type { CoreResponse } from "../core/protocol.js";
import {
  decodeLocalExportResult,
  numberField,
  sha256Bytes,
} from "../export/local-report.js";
import type { LicenseService } from "../license-service.js";
import type { NetworkGuard } from "../security/network-policy.js";

export interface M0SmokeOptions {
  core: CoreClient;
  networkGuard: NetworkGuard;
  createSmokeWindow(): BrowserWindow;
  getLicenseService(): LicenseService;
  installSessionHardening(): void;
  corePath(): string;
  outputPath: string;
  screenshotPath: string;
  windowWidth: number;
  windowHeight: number;
  scaleFactor: number;
}

let activeOptions: M0SmokeOptions | null = null;
let smokeOutputPath = "";
let smokeScreenshotPath = "";
let smokeWindowWidth = 1440;
let smokeWindowHeight = 900;
let smokeScaleFactor = 1;

function options(): M0SmokeOptions {
  if (!activeOptions) throw new Error("M0 smoke options are not initialized.");
  return activeOptions;
}

const callCore = (method: string, params: JsonValue = null) => options().core.call(method, params);
const ensureCoreHandshake = () => options().core.ensureHandshake();
const supervisorSnapshot = () => options().core.snapshot();
const requestCoreShutdown = () => options().core.shutdown();
const exerciseCoreRestartForSmoke = () => options().core.exerciseRestartForSmoke();

function requireCoreResult(response: CoreResponse, method: string): JsonValue {
  if (!response.ok) {
    throw new Error(response.error?.message ?? `${method} failed`);
  }
  return response.result ?? null;
}

function getLicenseService(): LicenseService {
  return options().getLicenseService();
}

function networkGuardSnapshot(): JsonValue {
  return options().networkGuard.snapshot();
}

function createWindow(): BrowserWindow {
  return options().createSmokeWindow();
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function seedDesignSmokeMeeting(): Promise<JsonValue> {
  const started = requireCoreResult(
    await callCore("recording.durable.start", { label: "Product Strategy Sync" }),
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
    ),
    "recording.notes.save",
  );
  requireCoreResult(
    await callCore("recording.durable.finish", { recordingId }),
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
      await callCore("export.create", { recordingId, format, report, options }),
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
      (async () => {
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
        const expectedView = targetView === 'advanced' ? 'settings' : targetView;
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
          clicked = await clickExact('button', 'Export report');
        } else if (targetView === 'settings') {
          clicked = await clickExact('.desktop-nav button', 'Settings');
        } else if (targetView === 'advanced') {
          await clickExact('.desktop-nav button', 'Settings');
          const advanced = document.querySelector('.advanced-settings-toggle');
          if (advanced instanceof HTMLButtonElement && advanced.getAttribute('aria-expanded') !== 'true') {
            advanced.click();
            await settle();
          }
          clicked = await clickExact('.settings-layout nav button', 'Diagnostics');
          if (clicked) {
            await clickExact('button', 'Prepare preview');
            for (let index = 0; index < 80; index += 1) {
              if (document.querySelector('.diagnostic-export details')) break;
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            document.querySelector('.diagnostic-export')?.scrollIntoView({ block: 'center' });
            await settle();
          }
        }
        if (!clicked) return { clicked: false, reason: 'workflow-navigation-unavailable' };
        for (let index = 0; index < 80; index += 1) {
          const current = document.querySelector('[data-view]')?.getAttribute('data-view');
          if (current === expectedView) break;
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
          })(),
          diagnosticPreviewVisible: Boolean(document.querySelector('.diagnostic-export details')),
          diagnosticSaveVisible: Array.from(document.querySelectorAll('.diagnostic-export button'))
            .some((button) => button.textContent?.trim() === 'Save JSON')
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
      (async () => {
        const root = globalThis;
        const candor = root.candor;
        const domainNames = ["app", "capture", "meetings", "transcript", "ai", "exports", "settings", "licensing", "events"];
        const domains = Object.fromEntries(domainNames.map((name) => [name, candor?.[name] ?? {}]));
        const coreKeys = domainNames.flatMap((name) => Object.keys(domains[name]).map((key) => name + "." + key)).sort();
        const licenseKeys = Object.keys(domains.licensing).sort();
        const shellKeys = Object.keys(domains.app).sort();
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
        let invalidInputError = null;
        try {
          await domains.meetings.get("../private-vault");
        } catch (error) {
          invalidInputError = String(error?.message ?? error);
        }
        return {
          attempted: true,
          candorPresent: Boolean(candor && typeof candor === "object"),
          coreFrozen: domainNames.every((name) => Object.isFrozen(domains[name])),
          licenseFrozen: Object.isFrozen(domains.licensing),
          shellFrozen: Object.isFrozen(domains.app),
          coreKeys,
          licenseKeys,
          shellKeys,
          forbiddenCoreKeysPresent: forbiddenCoreKeys.filter((key) => coreKeys.some((candidate) => candidate.endsWith("." + key))),
          forbiddenLicenseKeysPresent: forbiddenLicenseKeys.filter((key) => key in domains.licensing),
          forbiddenShellKeysPresent: forbiddenShellKeys.filter((key) => key in domains.app),
          forbiddenGlobalsPresent: forbiddenGlobals.filter((key) => key in root),
          nodeRequireAvailable: typeof root.require === "function",
          nodeProcessAvailable: typeof root.process !== "undefined",
          ipcRendererAvailable: typeof root.ipcRenderer !== "undefined",
          electronGlobalAvailable: typeof root.electron !== "undefined",
          invalidInputErrorSafe:
            typeof invalidInputError === "string" &&
            invalidInputError.includes("CANDOR_CORE_ERROR:INVALID_RENDERER_INPUT") &&
            !invalidInputError.includes("private-vault"),
          invalidInputErrorCode: typeof invalidInputError === "string" &&
            invalidInputError.includes("CANDOR_CORE_ERROR:INVALID_RENDERER_INPUT")
              ? "INVALID_RENDERER_INPUT"
              : null,
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

export async function runM0Smoke(smokeOptions: M0SmokeOptions): Promise<void> {
  activeOptions = smokeOptions;
  smokeOutputPath = smokeOptions.outputPath;
  smokeScreenshotPath = smokeOptions.screenshotPath;
  smokeWindowWidth = smokeOptions.windowWidth;
  smokeWindowHeight = smokeOptions.windowHeight;
  smokeScaleFactor = smokeOptions.scaleFactor;
  try {
    smokeOptions.installSessionHardening();
    await ensureCoreHandshake();
    const restartExercise = await exerciseCoreRestartForSmoke();
    const designFixture = await seedDesignSmokeMeeting();
    const documentExportFixture = await provePackagedDocumentExports(
      stringField(designFixture, "recordingId"),
    );
    const windowRef = createWindow();
    await waitForRendererLoad(windowRef);
    windowRef.showInactive();
    await waitForRendererView(windowRef, "meeting");
    const rendererEntryState = (await windowRef.webContents.executeJavaScript(
      `({
        currentView: document.querySelector('[data-view]')?.getAttribute('data-view') ?? null,
        activationVisible: Boolean(document.querySelector('[data-view="activation"]')),
        onboardingVisible: Boolean(document.querySelector('[data-view="onboarding"]')),
        transcriptVisible: Boolean(document.querySelector('.live-transcript')),
        notesVisible: Boolean(document.querySelector('.meeting-notes-panel'))
      })`,
      true,
    )) as JsonValue;
    const rendererEntryScreenshots: JsonValue[] = [];
    if (smokeScreenshotPath) {
      rendererEntryScreenshots.push(
        await captureSettledSmokePage(
          windowRef,
          smokeViewScreenshotPath(smokeScreenshotPath, "local-data-access"),
        ),
      );
    }
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
          if (window.candor?.version !== 3) {
            throw new Error("Candor preload bridge is not present.");
          }
          const [status, capabilities, auditSnapshot, updateStatus, importStatus, consentStatus, aiStatus, instructAssetsStatus, instructStatus, schedulerStatus, transcriptionStatus, vaultStatusBeforeOpen, licenseStatus, licensePortalInfo, diagnosticPreview] = await Promise.all([
            window.candor.app.getStatus(),
            window.candor.app.getCapabilities(),
            window.candor.settings.getPrivacyAudit(),
            window.candor.settings.getUpdateStatus(),
            window.candor.meetings.getImportStatus(),
            window.candor.capture.getConsent(),
            window.candor.ai.getStatus(),
            window.candor.ai.getEnhancedAssetsStatus(),
            window.candor.ai.getEnhancedStatus(),
            window.candor.ai.getWorkloadStatus(),
            window.candor.transcript.getStatus(),
            window.candor.settings.getStorageStatus(),
            window.candor.licensing.getStatus(),
            window.candor.licensing.getPortalInfo(),
            window.candor.app.prepareDiagnostics()
          ]);
          const vaultOpenLocal = vaultStatusBeforeOpen.localOpenAvailable
            ? await window.candor.settings.openLocalStorage()
            : {
                skipped: true,
                reason: "native-os-key-storage-unavailable",
                keyMaterialExposedToRenderer: false,
                rawPathExposed: false
              };
          const vaultStatus = await window.candor.settings.getStorageStatus();
          const supervisorStatus = await window.candor.app.getConnectionStatus();
          return {
            preloadBridgePresent: true,
            shell: {
              externalNavigationDisabled: true,
              networkPolicy: "disabled-by-default"
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
            licensePortalInfo,
            diagnosticPreview
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
            desktopShellVisible: Boolean(document.querySelector('.candor-desktop')),
            desktopSidebarVisible: Boolean(document.querySelector('.desktop-sidebar')),
            primaryNavigationVisible: Boolean(document.querySelector('.desktop-nav[aria-label="Primary"]')),
            recordActionVisible: Boolean(document.querySelector('.sidebar-record-action')),
            transcriptVisible: Boolean(document.querySelector('.live-transcript')),
            notesVisible: Boolean(document.querySelector('.meeting-notes-panel')),
            remoteImages: Array.from(document.images).filter((node) => /^https?:/i.test(node.src)).length
          };
        })()
      `,
      true,
    )) as JsonValue;
    const localNoticeExercise = (await windowRef.webContents.executeJavaScript(
      `
        (async () => {
          const button = Array.from(document.querySelectorAll('button'))
            .find((node) => node.textContent?.trim() === 'Mark moment');
          if (!(button instanceof HTMLButtonElement) || button.disabled) {
            return { triggered: false, notificationVisible: false };
          }
          button.click();
          for (let index = 0; index < 40; index += 1) {
            if (document.querySelector('[aria-label="Dismiss notification"]')) break;
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          return {
            triggered: true,
            notificationVisible: Boolean(document.querySelector('[aria-label="Dismiss notification"]'))
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
        ["export", "Export report"],
        ["settings", "Settings"],
        ["advanced", "Diagnostics"],
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
      corePath: smokeOptions.corePath(),
      rendererBridge,
      mainRpc: {
        status: mainStatus.result ?? null,
      },
      sidecarSupervisor: supervisorSnapshot(),
      restartExercise,
      rendererIsolationProbe: rendererIsolationEvidence,
      rendererPathAudit,
      rendererVisualState,
      localNoticeExercise,
      rendererScreenshot,
      rendererEntryState,
      rendererEntryScreenshots,
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
