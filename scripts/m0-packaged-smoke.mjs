import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");
const screenshotLabel = (process.env.CANDOR_M0_SCREENSHOT_LABEL ?? "")
  .trim()
  .replace(/[^a-z0-9-]+/gi, "-")
  .replace(/^-+|-+$/g, "");
const screenshotPath = join(
  repoRoot,
  "release-v3",
  "proofs",
  `m3-product-surface${screenshotLabel ? `-${screenshotLabel}` : ""}-${process.platform}-${process.arch}.png`,
);
const minimumSmokeScreenshotWidth = 960;
const minimumSmokeScreenshotHeight = 600;

function defaultExecutableCandidates() {
  if (process.platform === "win32") {
    return [join(repoRoot, "release-v3", "win-unpacked", "Candor.exe")];
  }
  if (process.platform === "darwin") {
    return [
      join(
        repoRoot,
        "release-v3",
        "mac",
        "Candor.app",
        "Contents",
        "MacOS",
        "Candor",
      ),
      join(
        repoRoot,
        "release-v3",
        "mac-arm64",
        "Candor.app",
        "Contents",
        "MacOS",
        "Candor",
      ),
    ];
  }
  return [
    join(repoRoot, "release-v3", "linux-unpacked", "candor"),
    join(repoRoot, "release-v3", "linux-unpacked", "Candor"),
  ];
}

function resolveExecutable() {
  const explicit = process.argv[2] ? resolve(process.argv[2]) : null;
  const candidates = explicit ? [explicit] : defaultExecutableCandidates();
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) {
    throw new Error(`Packaged executable not found. Checked:\n${candidates.join("\n")}`);
  }
  return executable;
}

function sha256(path) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

function paethPredictor(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  if (aboveDistance <= upperLeftDistance) return above;
  return upperLeft;
}

function pngVisualEvidence(imagePath) {
  const png = readFileSync(imagePath);
  const signature = "89504e470d0a1a0a";
  if (png.subarray(0, 8).toString("hex") !== signature) {
    throw new Error("Renderer screenshot is not a PNG file.");
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = -1;
  const idat = [];
  let offset = 8;
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > png.length) throw new Error("Renderer screenshot PNG is truncated.");
    if (type === "IHDR") {
      width = png.readUInt32BE(dataStart);
      height = png.readUInt32BE(dataStart + 4);
      bitDepth = png[dataStart + 8];
      colorType = png[dataStart + 9];
      interlace = png[dataStart + 12];
    } else if (type === "IDAT") {
      idat.push(png.subarray(dataStart, dataEnd));
    } else if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4;
  }

  if (!width || !height || bitDepth !== 8 || ![2, 6].includes(colorType) || interlace !== 0) {
    throw new Error("Renderer screenshot PNG uses an unsupported pixel format.");
  }
  const bytesPerPixel = colorType === 6 ? 4 : 3;
  const stride = width * bytesPerPixel;
  const pixels = inflateSync(Buffer.concat(idat));
  if (pixels.length !== (stride + 1) * height) {
    throw new Error("Renderer screenshot PNG has an unexpected decoded size.");
  }

  const previous = Buffer.alloc(stride);
  const current = Buffer.alloc(stride);
  const xStep = Math.max(1, Math.floor(width / 160));
  const yStep = Math.max(1, Math.floor(height / 100));
  const uniqueColors = new Set();
  let minLuma = 255;
  let maxLuma = 0;
  let nonWhiteSamples = 0;
  let samples = 0;
  let pixelOffset = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = pixels[pixelOffset++];
    for (let index = 0; index < stride; index += 1) {
      const raw = pixels[pixelOffset++];
      const left = index >= bytesPerPixel ? current[index - bytesPerPixel] : 0;
      const above = previous[index];
      const upperLeft = index >= bytesPerPixel ? previous[index - bytesPerPixel] : 0;
      let value;
      if (filter === 0) value = raw;
      else if (filter === 1) value = raw + left;
      else if (filter === 2) value = raw + above;
      else if (filter === 3) value = raw + Math.floor((left + above) / 2);
      else if (filter === 4) value = raw + paethPredictor(left, above, upperLeft);
      else throw new Error(`Renderer screenshot PNG uses unknown row filter ${filter}.`);
      current[index] = value & 0xff;
    }

    if (y % yStep === 0) {
      for (let x = 0; x < width; x += xStep) {
        const index = x * bytesPerPixel;
        const alpha = colorType === 6 ? current[index + 3] : 255;
        const red = Math.round((current[index] * alpha + 255 * (255 - alpha)) / 255);
        const green = Math.round((current[index + 1] * alpha + 255 * (255 - alpha)) / 255);
        const blue = Math.round((current[index + 2] * alpha + 255 * (255 - alpha)) / 255);
        const luma = Math.round((red * 299 + green * 587 + blue * 114) / 1000);
        minLuma = Math.min(minLuma, luma);
        maxLuma = Math.max(maxLuma, luma);
        if (red < 245 || green < 245 || blue < 245) nonWhiteSamples += 1;
        uniqueColors.add(`${red},${green},${blue}`);
        samples += 1;
      }
    }
    current.copy(previous);
    current.fill(0);
  }

  const nonWhiteRatio = samples > 0 ? nonWhiteSamples / samples : 0;
  const lumaRange = maxLuma - minLuma;
  return {
    decoded: true,
    width,
    height,
    samples,
    uniqueColors: uniqueColors.size,
    minLuma,
    maxLuma,
    lumaRange,
    nonWhiteRatio,
    nonBlank:
      samples >= 100 &&
      uniqueColors.size >= 16 &&
      lumaRange >= 20 &&
      nonWhiteRatio >= 0.02,
  };
}

function commandOutput(command, args = []) {
  const usesWindowsCmdShim = process.platform === "win32" && command.endsWith(".cmd");
  const executable = usesWindowsCmdShim ? process.env.ComSpec ?? "cmd.exe" : command;
  const commandArgs = usesWindowsCmdShim ? ["/d", "/c", [command, ...args].join(" ")] : args;
  const result = spawnSync(executable, commandArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    shell: false,
  });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

function ciProvenance() {
  return {
    githubActions: process.env.GITHUB_ACTIONS === "true",
    workflow: process.env.GITHUB_WORKFLOW ?? null,
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    job: process.env.GITHUB_JOB ?? null,
    sha: process.env.GITHUB_SHA ?? null,
    ref: process.env.GITHUB_REF ?? null,
    runnerOs: process.env.RUNNER_OS ?? null,
  };
}

function fileEvidence(path) {
  if (!path || !existsSync(path)) return { path, exists: false };
  const stat = statSync(path);
  return {
    path,
    exists: true,
    bytes: stat.size,
    sha256: sha256(path),
  };
}

function appArchivePathForExecutable(executable) {
  if (process.platform === "darwin") {
    return join(dirname(dirname(executable)), "Resources", "app.asar");
  }
  return join(dirname(executable), "resources", "app.asar");
}

function nonWindowsAvailableOsKeyLabels() {
  return new Set(["keychain-proof-available", "secret-service-proof-available"]);
}

function nonWindowsUnavailableOsKeyLabels() {
  return new Set(["keychain-unavailable", "secret-service-unavailable"]);
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error(`Packaged app smoke timed out after ${timeoutMs} ms.`));
    }, timeoutMs);

    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolvePromise({ code, signal });
    });
  });
}

function assertSmokePayload(payload) {
  if (!payload || payload.ok !== true) {
    throw new Error(`Packaged smoke reported failure: ${JSON.stringify(payload, null, 2)}`);
  }
  if (payload.mode !== "m0-packaged-runtime-smoke") {
    throw new Error(`Unexpected smoke mode: ${payload.mode}`);
  }
  if (payload.appIsPackaged !== true) {
    throw new Error("Smoke did not run against a packaged Electron app.");
  }
  if (!payload.rendererBridge?.preloadBridgePresent) {
    throw new Error("Renderer did not confirm the preload bridge.");
  }
  if (payload.rendererIsolationProbe?.attempted !== true) {
    throw new Error("Packaged smoke did not run the renderer isolation probe.");
  }
  if (payload.rendererIsolationProbe?.candorPresent !== true) {
    throw new Error("Renderer isolation probe did not find the Candor bridge.");
  }
  if (
    payload.rendererPathAudit?.ok !== true ||
    Number(payload.rendererPathAudit?.scannedStrings ?? 0) < 1 ||
    !Array.isArray(payload.rendererPathAudit?.findings) ||
    payload.rendererPathAudit.findings.length !== 0
  ) {
    throw new Error("Packaged smoke did not prove a clean measured scan of renderer-facing paths.");
  }
  if (
    Object.prototype.hasOwnProperty.call(payload.rendererBridge?.supervisorStatus ?? {}, "executable") ||
    payload.rendererBridge?.supervisorStatus?.rawPathExposed !== false
  ) {
    throw new Error("Renderer supervisor status exposed the core executable path.");
  }
  if (
    payload.rendererIsolationProbe?.coreFrozen !== true ||
    payload.rendererIsolationProbe?.licenseFrozen !== true ||
    payload.rendererIsolationProbe?.shellFrozen !== true
  ) {
    throw new Error("Renderer isolation probe found mutable preload bridge surfaces.");
  }
  if (
    payload.rendererIsolationProbe?.nodeRequireAvailable !== false ||
    payload.rendererIsolationProbe?.nodeProcessAvailable !== false ||
    payload.rendererIsolationProbe?.ipcRendererAvailable !== false ||
    payload.rendererIsolationProbe?.electronGlobalAvailable !== false
  ) {
    throw new Error("Renderer isolation probe found Node or Electron globals in the page.");
  }
  if ((payload.rendererIsolationProbe?.forbiddenGlobalsPresent ?? []).length !== 0) {
    throw new Error("Renderer isolation probe found forbidden globals in the page.");
  }
  if ((payload.rendererIsolationProbe?.forbiddenCoreKeysPresent ?? []).length !== 0) {
    throw new Error("Renderer isolation probe found private core methods on the preload bridge.");
  }
  if ((payload.rendererIsolationProbe?.forbiddenLicenseKeysPresent ?? []).length !== 0) {
    throw new Error("Renderer isolation probe found private license methods on the preload bridge.");
  }
  if ((payload.rendererIsolationProbe?.forbiddenShellKeysPresent ?? []).length !== 0) {
    throw new Error("Renderer isolation probe found private shell methods on the preload bridge.");
  }
  if (
    payload.rendererIsolationProbe?.invalidInputErrorSafe !== true ||
    payload.rendererIsolationProbe?.invalidInputErrorCode !== "INVALID_RENDERER_INPUT"
  ) {
    throw new Error("Renderer isolation probe did not receive a pathless structured input error.");
  }
  if (!payload.rendererIsolationProbe?.coreKeys?.includes("transcriptionRunLocal")) {
    throw new Error("Renderer isolation probe did not find the typed transcription command.");
  }
  if (!payload.rendererIsolationProbe?.coreKeys?.includes("modelsImportFromFile")) {
    throw new Error("Renderer isolation probe did not find the pathless model import command.");
  }
  if (!payload.rendererIsolationProbe?.coreKeys?.includes("exportSaveLocal")) {
    throw new Error("Renderer isolation probe did not find the pathless local document save command.");
  }
  for (const key of ["aiInstructAssetsStatus", "aiInstructAssetImportFromFile", "aiInstructStatus", "aiRecapInstruct", "aiAskInstruct"]) {
    if (!payload.rendererIsolationProbe?.coreKeys?.includes(key)) {
      throw new Error(`Renderer isolation probe did not find the typed local instruct command: ${key}.`);
    }
  }
  if (payload.rendererIsolationProbe?.shellKeys?.includes("openExternal")) {
    throw new Error("Renderer isolation probe found an exposed external navigation command.");
  }
  for (const key of ["diagnosticsPreview", "diagnosticsSaveLocal"]) {
    if (!payload.rendererIsolationProbe?.shellKeys?.includes(key)) {
      throw new Error(`Renderer isolation probe did not find the exact diagnostic command: ${key}.`);
    }
  }
  for (const key of ["status", "activate", "startTrial", "deactivateDevice", "portalInfo"]) {
    if (!payload.rendererIsolationProbe?.licenseKeys?.includes(key)) {
      throw new Error(`Renderer isolation probe did not find the typed license command: ${key}.`);
    }
  }
  if (
    payload.rendererIsolationProbe?.rawPathExposed !== false ||
    payload.rendererIsolationProbe?.keyMaterialExposedToRenderer !== false
  ) {
    throw new Error("Renderer isolation probe exposed raw paths or key material.");
  }
  if (payload.rendererBridge?.status?.sidecarTransport !== "stdio-json-lines") {
    throw new Error("Renderer did not receive stdio sidecar status.");
  }
  const diagnosticText = JSON.stringify(payload.rendererBridge?.diagnosticPreview ?? null);
  if (
    payload.rendererBridge?.diagnosticPreview?.contentPolicy !== "metadata-only-no-user-content" ||
    payload.rendererBridge?.diagnosticPreview?.privacy?.userContentIncluded !== false ||
    payload.rendererBridge?.diagnosticPreview?.privacy?.rawPathsIncluded !== false ||
    payload.rendererBridge?.diagnosticPreview?.privacy?.processIdsIncluded !== false ||
    payload.rendererBridge?.diagnosticPreview?.privacy?.secretsIncluded !== false ||
    diagnosticText.includes('"pid"') ||
    diagnosticText.includes('"transcript"') ||
    diagnosticText.includes('"notes"') ||
    diagnosticText.includes('"prompt"') ||
    diagnosticText.includes('"output"')
  ) {
    throw new Error("Packaged diagnostic preview included non-allowlisted or user-content fields.");
  }
  if (
    payload.rendererScreenshot?.captured !== true ||
    payload.rendererScreenshot?.forcedWindowRepaint !== true ||
    payload.rendererScreenshot?.warmupCapture !== true ||
    payload.rendererScreenshot?.bytes < 10_000 ||
    payload.rendererScreenshot?.width < minimumSmokeScreenshotWidth ||
    payload.rendererScreenshot?.height < minimumSmokeScreenshotHeight
  ) {
    throw new Error("Packaged smoke did not capture a nontrivial renderer screenshot.");
  }
  if (
    payload.localNoticeExercise?.triggered !== true ||
    payload.localNoticeExercise?.notificationVisible !== true ||
    payload.rendererScreenshot?.notificationDismissed !== true
  ) {
    throw new Error("Packaged renderer did not exercise the dismissible local notification control.");
  }
  const requestedWidth = Number(payload.requestedViewport?.width ?? 0);
  const requestedHeight = Number(payload.requestedViewport?.height ?? 0);
  const widthScale = Number(payload.rendererScreenshot?.width ?? 0) / requestedWidth;
  const heightScale = Number(payload.rendererScreenshot?.height ?? 0) / requestedHeight;
  const minimumWidthScale = Math.min(0.9, minimumSmokeScreenshotWidth / requestedWidth);
  const minimumHeightScale = Math.min(0.7, minimumSmokeScreenshotHeight / requestedHeight);
  if (
    requestedWidth < 960 ||
    requestedHeight < 700 ||
    widthScale < minimumWidthScale ||
    widthScale > 3 ||
    heightScale < minimumHeightScale ||
    heightScale > 3
  ) {
    throw new Error("Packaged smoke screenshot did not reflect the requested desktop viewport.");
  }
  if (
    payload.rendererEntryState?.currentView !== "meeting" ||
    payload.rendererEntryState?.activationVisible !== false ||
    payload.rendererEntryState?.onboardingVisible !== false ||
    payload.rendererEntryState?.transcriptVisible !== true ||
    payload.rendererEntryState?.notesVisible !== true
  ) {
    throw new Error("Packaged renderer did not preserve existing local data access without activation.");
  }
  const entryScreenshots = Array.isArray(payload.rendererEntryScreenshots)
    ? payload.rendererEntryScreenshots
    : [];
  const entryScreenshot = entryScreenshots.find((entry) => entry?.currentView === "meeting");
  if (
    entryScreenshot?.captured !== true ||
    entryScreenshot?.forcedWindowRepaint !== true ||
    entryScreenshot?.warmupCapture !== true ||
    entryScreenshot?.bytes < 10_000 ||
    entryScreenshot?.width < minimumSmokeScreenshotWidth ||
    entryScreenshot?.height < minimumSmokeScreenshotHeight ||
    entryScreenshot?.bodyTextCharacters < 150
  ) {
    throw new Error("Packaged renderer did not capture the local data access entry view.");
  }
  const expectedViews = ["home", "library", "detail", "review", "export", "settings", "advanced"];
  const viewScreenshots = Array.isArray(payload.rendererViewScreenshots)
    ? payload.rendererViewScreenshots
    : [];
  for (const view of expectedViews) {
    const screenshot = viewScreenshots.find((entry) => entry?.view === view);
    if (
      screenshot?.captured !== true ||
      screenshot?.forcedWindowRepaint !== true ||
      screenshot?.warmupCapture !== true ||
      screenshot?.bytes < 10_000 ||
      screenshot?.width < minimumSmokeScreenshotWidth ||
      screenshot?.height < minimumSmokeScreenshotHeight ||
      screenshot?.navigation?.clicked !== true ||
      screenshot?.navigation?.currentView !== (view === "advanced" ? "settings" : view) ||
      screenshot?.navigation?.bodyTextCharacters < 150
    ) {
      throw new Error(`Packaged renderer did not capture the ${view} design view.`);
    }
  }
  const exportView = viewScreenshots.find((entry) => entry?.view === "export");
  const advancedView = viewScreenshots.find((entry) => entry?.view === "advanced");
  if (
    advancedView?.navigation?.diagnosticPreviewVisible !== true ||
    advancedView?.navigation?.diagnosticSaveVisible !== true
  ) {
    throw new Error("Packaged Advanced Settings did not expose the inspectable safe diagnostic report.");
  }
  const exportFormats = Array.isArray(exportView?.navigation?.exportFormats)
    ? exportView.navigation.exportFormats
    : [];
  for (const format of ["Word", "PDF", "Markdown"]) {
    const option = exportFormats.find((entry) => entry?.label?.startsWith(format));
    if (!option || option.disabled !== false) {
      throw new Error(`Packaged export view did not enable the local ${format} renderer.`);
    }
  }
  if (
    exportView?.navigation?.exportSaveAction?.visible !== true ||
    exportView?.navigation?.exportSaveAction?.disabled !== false ||
    !exportView?.navigation?.exportSaveAction?.label?.startsWith("Save ")
  ) {
    throw new Error("Packaged export view did not expose an enabled pathless local save action.");
  }
  if (
    payload.designFixture?.created !== true ||
    payload.designFixture?.transcriptSegmentCount !== 5 ||
    payload.designFixture?.notesSaved !== true ||
    payload.designFixture?.localOnly !== true ||
    payload.designFixture?.rawPathExposed !== false
  ) {
    throw new Error("Packaged renderer design fixture was not created locally and pathlessly.");
  }
  const documentProof = payload.documentExportFixture;
  if (
    documentProof?.proven !== true ||
    documentProof?.localOnly !== true ||
    documentProof?.generatedLocally !== true ||
    documentProof?.networkAttempted !== false ||
    documentProof?.rawPathExposed !== false ||
    documentProof?.keyMaterialExposedToRenderer !== false ||
    documentProof?.formats?.docx?.editable !== true ||
    documentProof?.formats?.docx?.nativeSignatureVerified !== true ||
    documentProof?.formats?.pdf?.searchableText !== true ||
    documentProof?.formats?.pdf?.bookmarks !== true ||
    documentProof?.formats?.pdf?.pageCount < 1
  ) {
    throw new Error("Packaged app did not prove native local Word and searchable PDF generation.");
  }
  for (const format of ["docx", "pdf"]) {
    const proof = documentProof.formats?.[format];
    if (proof?.bytes < 1_000 || !/^[a-f0-9]{64}$/.test(proof?.sha256 ?? "")) {
      throw new Error(`Packaged ${format} proof is missing verified bytes or SHA-256 evidence.`);
    }
  }
  if (JSON.stringify(documentProof).includes("dataBase64")) {
    throw new Error("Packaged document proof leaked document payload bytes into the smoke receipt.");
  }
  if (
    payload.licenseFixture?.state !== "inactive" ||
    payload.licenseFixture?.activationSource !== "none" ||
    payload.licenseFixture?.persistentAccountRequired !== false ||
    payload.licenseFixture?.localOnly !== true ||
    payload.licenseFixture?.rawPathExposed !== false ||
    payload.licenseFixture?.keyMaterialExposedToRenderer !== false ||
    payload.rendererBridge?.licenseStatus?.state !== "inactive" ||
    payload.rendererBridge?.licensePortalInfo?.requiresSignInForNormalUse !== false
  ) {
    throw new Error("Packaged renderer did not prove the isolated local license and no-account contract.");
  }
  if (
    payload.rendererVisualState?.bodyTextCharacters < 200 ||
    payload.rendererVisualState?.aiModeVisible !== true ||
    payload.rendererVisualState?.selectedMode !== "Quality" ||
    payload.rendererVisualState?.statusText !== "Fast fallback, model unavailable" ||
    payload.rendererVisualState?.aiSuggestionsTabActivated !== true ||
    payload.rendererVisualState?.notesTabRestored !== true ||
    payload.rendererVisualState?.currentView !== "meeting" ||
    payload.rendererVisualState?.sessionRailVisible !== true ||
    payload.rendererVisualState?.sessionTabsVisible !== true ||
    payload.rendererVisualState?.recordActionVisible !== true ||
    payload.rendererVisualState?.transcriptVisible !== true ||
    payload.rendererVisualState?.notesVisible !== true ||
    payload.rendererVisualState?.remoteImages !== 0
  ) {
    throw new Error("Packaged renderer did not show the expected Figma-aligned local meeting workspace.");
  }
  if (payload.rendererBridge?.status?.networkPolicy !== "disabled-by-default") {
    throw new Error("Renderer did not receive disabled-by-default core network policy.");
  }
  if (payload.rendererBridge?.status?.startupRecovery?.ok !== true) {
    throw new Error("Renderer did not receive successful startup recovery status.");
  }
  if (payload.rendererBridge?.status?.startupRecovery?.rawPathExposed !== false) {
    throw new Error("Renderer-visible startup recovery status exposed a raw path.");
  }
  if (payload.rendererBridge?.shell?.networkPolicy !== "disabled-by-default") {
    throw new Error("Renderer shell policy is not disabled-by-default.");
  }
  if (payload.rendererBridge?.supervisorStatus?.lastHandshake?.ok !== true) {
    throw new Error("Renderer did not receive a successful sidecar supervisor handshake.");
  }
  if (
    payload.rendererBridge?.supervisorStatus?.lastHandshake?.version?.protocolVersion !==
    "m0-jsonrpc-stdio-1"
  ) {
    throw new Error("Renderer did not receive the expected sidecar protocol version.");
  }
  if (!payload.rendererBridge?.capabilities?.deniedCapabilities?.includes("localhostTcp")) {
    throw new Error("Core capability report does not deny localhost TCP.");
  }
  if (payload.rendererBridge?.vaultStatus?.keyMaterialExposedToRenderer !== false) {
    throw new Error("Renderer-visible vault status exposed key material.");
  }
  if (payload.rendererBridge?.consentStatus?.rawPathExposed !== false) {
    throw new Error("Renderer-visible consent status exposed a raw path.");
  }
  if (payload.rendererBridge?.consentStatus?.keyMaterialExposedToRenderer !== false) {
    throw new Error("Renderer-visible consent status exposed key material.");
  }
  if (payload.rendererBridge?.consentStatus?.readyForMicRecording !== false) {
    throw new Error("Fresh packaged smoke consent state should require mic acknowledgement.");
  }
  if (payload.rendererBridge?.schedulerStatus?.singleLocalModelJob !== true) {
    throw new Error("Renderer-visible scheduler status did not prove single local model job policy.");
  }
  if (payload.rendererBridge?.schedulerStatus?.whisperLlmConcurrent !== false) {
    throw new Error("Renderer-visible scheduler status allowed Whisper plus LLM concurrency.");
  }
  if (payload.rendererBridge?.schedulerStatus?.rawPathExposed !== false) {
    throw new Error("Renderer-visible scheduler status exposed a raw path.");
  }
  if (
    payload.rendererBridge?.transcriptionStatus?.localOnly !== true ||
    payload.rendererBridge?.transcriptionStatus?.cloudAi !== false ||
    payload.rendererBridge?.transcriptionStatus?.engine !== "whisper-rs" ||
    payload.rendererBridge?.transcriptionStatus?.whisperFeatureEnabled !== true ||
    payload.rendererBridge?.transcriptionStatus?.modelPathAcceptedFromRenderer !== false
  ) {
    throw new Error("Renderer-visible transcription status did not prove packaged local Whisper readiness.");
  }
  if (
    payload.rendererBridge?.transcriptionStatus?.rawPathExposed !== false ||
    payload.rendererBridge?.transcriptionStatus?.keyMaterialExposedToRenderer !== false
  ) {
    throw new Error("Renderer-visible transcription status exposed key material or raw paths.");
  }
  if (
    payload.rendererBridge?.aiStatus?.engine !== "heuristic-local" ||
    payload.rendererBridge?.aiStatus?.heuristicRecapImplemented !== true ||
    payload.rendererBridge?.aiStatus?.heuristicAskImplemented !== true ||
    payload.rendererBridge?.aiStatus?.askImplemented !== true ||
    payload.rendererBridge?.aiStatus?.modelRequiredForHeuristics !== false ||
    payload.rendererBridge?.aiStatus?.cloudAi !== false
  ) {
    throw new Error("Renderer-visible local AI status did not prove the heuristic local contract.");
  }
  if (payload.rendererBridge?.aiStatus?.rawPathExposed !== false) {
    throw new Error("Renderer-visible local AI status exposed a raw path.");
  }
  if (
    payload.rendererBridge?.instructAssetsStatus?.implemented !== true ||
    payload.rendererBridge?.instructAssetsStatus?.localOnly !== true ||
    payload.rendererBridge?.instructAssetsStatus?.cloudAi !== false ||
    payload.rendererBridge?.instructAssetsStatus?.manualImportOnly !== true ||
    payload.rendererBridge?.instructAssetsStatus?.manualImportMethod !== "native-picker-core-copy" ||
    payload.rendererBridge?.instructAssetsStatus?.backgroundDownloads !== false ||
    payload.rendererBridge?.instructAssetsStatus?.networkAttempted !== false ||
    payload.rendererBridge?.instructAssetsStatus?.downloadsAttempted !== false ||
    payload.rendererBridge?.instructAssetsStatus?.expectedSha256Required !== true ||
    payload.rendererBridge?.instructAssetsStatus?.sourcePathAcceptedFromRenderer !== false ||
    payload.rendererBridge?.instructAssetsStatus?.managedPathExposed !== false ||
    payload.rendererBridge?.instructAssetsStatus?.rawPathExposed !== false ||
    payload.rendererBridge?.instructAssetsStatus?.keyMaterialExposedToRenderer !== false
  ) {
    throw new Error("Renderer-visible instruct asset status did not prove the managed pathless contract.");
  }
  if (
    payload.rendererBridge?.instructStatus?.implemented !== true ||
    payload.rendererBridge?.instructStatus?.generationImplemented !== true ||
    payload.rendererBridge?.instructStatus?.recapImplemented !== true ||
    payload.rendererBridge?.instructStatus?.askImplemented !== true ||
    payload.rendererBridge?.instructStatus?.localOnly !== true ||
    payload.rendererBridge?.instructStatus?.cloudAi !== false ||
    payload.rendererBridge?.instructStatus?.downloadPolicy !== "manual-install-only" ||
    payload.rendererBridge?.instructStatus?.backgroundDownloads !== false
  ) {
    throw new Error("Renderer-visible instruct status did not prove the local model contract.");
  }
  if (
    payload.rendererBridge?.instructStatus?.configuration?.rawValuesExposed !== false ||
    payload.rendererBridge?.instructStatus?.rawPathExposed !== false ||
    payload.rendererBridge?.instructStatus?.keyMaterialExposedToRenderer !== false
  ) {
    throw new Error("Renderer-visible instruct status exposed configuration, key material, or raw paths.");
  }
  if (payload.rendererBridge?.vaultStatus?.rawPathExposed !== false) {
    throw new Error("Renderer-visible vault status exposed a raw path.");
  }
  if (payload.rendererBridge?.vaultStatus?.sqlcipherAvailable !== true) {
    throw new Error("Packaged vault status did not report SQLCipher availability.");
  }
  if (payload.rendererBridge?.vaultStatusBeforeOpen?.localOpenAvailable === true) {
    if (
      payload.rendererBridge?.vaultOpenLocal?.backend !== "sqlcipher" ||
      payload.rendererBridge?.vaultOpenLocal?.encrypted !== true ||
      payload.rendererBridge?.vaultOpenLocal?.openMode !== "os-key" ||
      payload.rendererBridge?.vaultOpenLocal?.passphraseRequired !== false
    ) {
      throw new Error("Renderer bridge did not open the local OS-key SQLCipher vault.");
    }
    if (
      payload.rendererBridge?.vaultOpenLocal?.keyMaterialExposedToRenderer !== false ||
      payload.rendererBridge?.vaultOpenLocal?.rawPathExposed !== false
    ) {
      throw new Error("Renderer-visible vault open result exposed key material or raw paths.");
    }
  } else {
    if (
      payload.rendererBridge?.vaultOpenLocal?.skipped !== true ||
      payload.rendererBridge?.vaultOpenLocal?.reason !== "native-os-key-storage-unavailable" ||
      payload.rendererBridge?.vaultOpenLocal?.keyMaterialExposedToRenderer !== false ||
      payload.rendererBridge?.vaultOpenLocal?.rawPathExposed !== false
    ) {
      throw new Error("Renderer bridge did not report a safe unavailable vault-open state.");
    }
  }
  if (
    process.platform === "win32" &&
    payload.rendererBridge?.vaultStatus?.osKeyStorage !== "dpapi-proof-available"
  ) {
    throw new Error(
      `Windows packaged vault status did not report DPAPI proof availability: ${payload.rendererBridge?.vaultStatus?.osKeyStorage}`,
    );
  }
  if (
    process.platform !== "win32" &&
    payload.rendererBridge?.vaultStatusBeforeOpen?.localOpenAvailable === true &&
    !nonWindowsAvailableOsKeyLabels().has(payload.rendererBridge?.vaultStatus?.osKeyStorage)
  ) {
    throw new Error(
      `Non-Windows packaged vault status did not report available native key storage: ${payload.rendererBridge?.vaultStatus?.osKeyStorage}`,
    );
  }
  if (
    process.platform !== "win32" &&
    payload.rendererBridge?.vaultStatusBeforeOpen?.localOpenAvailable !== true &&
    !nonWindowsUnavailableOsKeyLabels().has(payload.rendererBridge?.vaultStatus?.osKeyStorage)
  ) {
    throw new Error(
      `Non-Windows packaged vault status did not report unavailable native key storage: ${payload.rendererBridge?.vaultStatus?.osKeyStorage}`,
    );
  }
  if (
    !Number.isInteger(payload.rendererBridge?.capabilities?.maxRpcFrameBytes) ||
    payload.rendererBridge.capabilities.maxRpcFrameBytes < 1024
  ) {
    throw new Error("Core capability report does not include a valid maxRpcFrameBytes limit.");
  }
  if (payload.rendererBridge?.auditSnapshot?.externalCallsAttempted !== 0) {
    throw new Error("Core privacy audit did not report zero attempted external calls.");
  }
  if (
    payload.rendererBridge?.updateStatus?.policy !== "manual-check-only" ||
    payload.rendererBridge?.updateStatus?.backgroundChecks !== false ||
    payload.rendererBridge?.updateStatus?.startupCheck !== false ||
    payload.rendererBridge?.updateStatus?.manualCheckNetworkEnabled !== false ||
    payload.rendererBridge?.updateStatus?.attemptedChecks !== 0
  ) {
    throw new Error("Renderer-visible update status did not prove the manual-only no-network policy.");
  }
  if (payload.rendererBridge?.updateStatus?.rawPathExposed !== false) {
    throw new Error("Renderer-visible update status exposed a raw path.");
  }
  if (
    payload.rendererBridge?.importStatus?.implemented !== true ||
    payload.rendererBridge?.importStatus?.localOnly !== true ||
    payload.rendererBridge?.importStatus?.rendererRawPathAccess !== false ||
    payload.rendererBridge?.importStatus?.originalsUntouched !== true
  ) {
    throw new Error("Renderer-visible v2 import status did not prove the local pathless contract.");
  }
  if (payload.rendererBridge?.importStatus?.rawPathExposed !== false) {
    throw new Error("Renderer-visible v2 import status exposed a raw path.");
  }
  if (payload.mainRpc?.status?.sidecarTransport !== "stdio-json-lines") {
    throw new Error("Electron main did not receive stdio sidecar status.");
  }
  if (payload.mainRpc?.status?.networkPolicy !== "disabled-by-default") {
    throw new Error("Electron main did not receive disabled-by-default core network policy.");
  }
  if (payload.mainRpc?.status?.startupRecovery?.ok !== true) {
    throw new Error("Electron main did not receive successful startup recovery status.");
  }
  if (payload.mainRpc?.status?.startupRecovery?.rawPathExposed !== false) {
    throw new Error("Electron main startup recovery status exposed a raw path.");
  }
  if (payload.sidecarSupervisor?.lastHandshake?.ok !== true) {
    throw new Error("Electron main did not record a successful sidecar version handshake.");
  }
  if (
    payload.sidecarSupervisor?.lastHandshake?.version?.protocolVersion !== "m0-jsonrpc-stdio-1"
  ) {
    throw new Error("Electron main recorded an unexpected sidecar protocol version.");
  }
  const restartCountBefore = Number(payload.restartExercise?.before?.restartCount ?? -1);
  const restartCountAfter = Number(payload.restartExercise?.after?.restartCount ?? -1);
  if (restartCountAfter <= restartCountBefore) {
    throw new Error("Packaged smoke did not prove sidecar restart supervision.");
  }
  if (payload.restartExercise?.status?.sidecarTransport !== "stdio-json-lines") {
    throw new Error("Restarted sidecar did not return stdio status.");
  }
  if (payload.sessionNetworkGuard?.externalAllowedRequests !== 0) {
    throw new Error("Packaged session allowed an external request.");
  }
  const rendererProbe = payload.networkBlockProbe?.renderer;
  const sessionProbe = payload.networkBlockProbe?.sessionGuard;
  if (rendererProbe?.fetch?.attempted !== true || rendererProbe?.fetch?.blocked !== true) {
    throw new Error("Packaged smoke did not prove renderer fetch denial.");
  }
  if (rendererProbe?.windowOpen?.attempted !== true || rendererProbe?.windowOpen?.denied !== true) {
    throw new Error("Packaged smoke did not prove external window-open denial.");
  }
  if (rendererProbe?.navigation?.attempted !== true || rendererProbe?.navigation?.stayedInApp !== true) {
    throw new Error("Packaged smoke did not prove external navigation denial.");
  }
  if (
    rendererProbe?.fileNavigation?.attempted !== true ||
    rendererProbe?.fileNavigation?.stayedInApp !== true
  ) {
    throw new Error("Packaged smoke did not prove arbitrary local file navigation denial.");
  }
  if (rendererProbe?.externalAllowedDelta !== 0) {
    throw new Error("Renderer network-denial probe allowed an external request.");
  }
  if (
    Number(rendererProbe?.deniedWindowOpenDelta ?? 0) < 1 ||
    Number(rendererProbe?.deniedNavigationDelta ?? 0) < 2
  ) {
    throw new Error("Renderer network-denial probe did not increment navigation denial counters.");
  }
  if (sessionProbe?.fetch?.attempted !== true || sessionProbe?.fetch?.blocked !== true) {
    throw new Error("Packaged smoke did not prove session fetch denial.");
  }
  if (sessionProbe?.externalAllowedDelta !== 0) {
    throw new Error("Session network-denial probe allowed an external request.");
  }
  if (Number(sessionProbe?.blockedDelta ?? 0) < 1) {
    throw new Error("Session network-denial probe did not increment blocked request count.");
  }
  if (payload.networkBlockProbe?.rawPathExposed !== false) {
    throw new Error("Network-denial probe exposed a raw path.");
  }
  const preProbeBlocked = Number(rendererProbe?.before?.blockedRequests ?? 0);
  if (preProbeBlocked !== 0) {
    throw new Error(
      `Packaged session blocked unexpected requests before the explicit probe: ${JSON.stringify(
        rendererProbe?.before?.blockedSamples ?? [],
      )}`,
    );
  }
}

const executable = resolveExecutable();
const outputPath = join(tmpdir(), `candor-m0-smoke-${process.pid}-${Date.now()}.json`);
const smokeDataDir = mkdtempSync(join(tmpdir(), "candor-m0-packaged-data-"));
const proofOutputPath =
  process.env.CANDOR_M0_PACKAGED_SMOKE_PROOF ??
  join(
    repoRoot,
    "release-v3",
    "proofs",
    `m0-packaged-runtime-smoke${screenshotLabel ? `-${screenshotLabel}` : ""}-${process.platform}-${process.arch}.json`,
  );
rmSync(outputPath, { force: true });

const child = spawn(executable, [], {
  cwd: repoRoot,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    CANDOR_M0_SMOKE_OUT: outputPath,
    CANDOR_M0_SMOKE_SCREENSHOT: screenshotPath,
    CANDOR_V3_DATA_DIR: smokeDataDir,
  },
});

let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
});

const result = await waitForExit(child, 90000);
if (result.code !== 0) {
  throw new Error(
    `Packaged app smoke exited with ${result.code ?? result.signal}.\n${stderr.trim()}`,
  );
}
if (!existsSync(outputPath)) {
  throw new Error(`Packaged app smoke did not write proof file: ${outputPath}`);
}
if (!existsSync(screenshotPath)) {
  throw new Error(`Packaged app smoke did not write renderer screenshot: ${screenshotPath}`);
}

const payload = JSON.parse(readFileSync(outputPath, "utf8"));
try {
  assertSmokePayload(payload);
} catch (error) {
  mkdirSync(dirname(proofOutputPath), { recursive: true });
  writeFileSync(
    proofOutputPath,
    JSON.stringify(
      {
        ...payload,
        ok: false,
        proofKind: "m0-packaged-runtime-smoke",
        verifiedBy: "scripts/m0-packaged-smoke.mjs",
        verificationFailure: error instanceof Error ? error.message : String(error),
        ci: ciProvenance(),
        proofWrittenAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf8",
  );
  rmSync(outputPath, { force: true });
  rmSync(smokeDataDir, { recursive: true, force: true });
  throw error;
}
const rendererScreenshotVisualEvidence = pngVisualEvidence(screenshotPath);
if (!rendererScreenshotVisualEvidence.nonBlank) {
  throw new Error(
    `Packaged renderer screenshot was blank: ${JSON.stringify(rendererScreenshotVisualEvidence)}`,
  );
}
const rendererViewScreenshotEvidence = payload.rendererViewScreenshots.map((entry) => {
  if (!existsSync(entry.path)) {
    throw new Error(`Packaged app smoke did not write ${entry.view} screenshot: ${entry.path}`);
  }
  const visualEvidence = pngVisualEvidence(entry.path);
  if (!visualEvidence.nonBlank) {
    throw new Error(`Packaged ${entry.view} screenshot was blank: ${JSON.stringify(visualEvidence)}`);
  }
  return {
    view: entry.view,
    artifact: fileEvidence(entry.path),
    visualEvidence,
  };
});
const rendererEntryScreenshotEvidence = payload.rendererEntryScreenshots.map((entry) => {
  if (!existsSync(entry.path)) {
    throw new Error(`Packaged app smoke did not write ${entry.currentView} screenshot: ${entry.path}`);
  }
  const visualEvidence = pngVisualEvidence(entry.path);
  if (!visualEvidence.nonBlank) {
    throw new Error(`Packaged ${entry.currentView} screenshot was blank: ${JSON.stringify(visualEvidence)}`);
  }
  return {
    view: entry.currentView,
    artifact: fileEvidence(entry.path),
    visualEvidence,
  };
});
const packagedArtifacts = {
  appExecutable: fileEvidence(executable),
  coreExecutable: fileEvidence(payload.corePath),
  appArchive: fileEvidence(appArchivePathForExecutable(executable)),
  rendererScreenshot: fileEvidence(screenshotPath),
};
for (const [name, entry] of Object.entries(packagedArtifacts)) {
  if (!entry.exists || !entry.sha256) {
    throw new Error(`Packaged smoke could not hash ${name}: ${entry.path}`);
  }
}
mkdirSync(dirname(proofOutputPath), { recursive: true });
writeFileSync(
  proofOutputPath,
  JSON.stringify(
    {
      ...payload,
      proofKind: "m0-packaged-runtime-smoke",
      verifiedBy: "scripts/m0-packaged-smoke.mjs",
      executable,
      git: {
        head: commandOutput("git", ["rev-parse", "HEAD"]),
        branch: commandOutput("git", ["branch", "--show-current"]),
        dirty: commandOutput("git", ["status", "--short"])?.length > 0,
      },
      ci: ciProvenance(),
      packagedArtifacts,
      rendererScreenshotVisualEvidence,
      rendererViewScreenshotEvidence,
      rendererEntryScreenshotEvidence,
      proofWrittenAt: new Date().toISOString(),
    },
    null,
    2,
  ),
  "utf8",
);
rmSync(outputPath, { force: true });
rmSync(smokeDataDir, { recursive: true, force: true });

console.log(`M0 packaged runtime smoke passed for ${executable}.`);
console.log(`M0 packaged runtime proof written to ${proofOutputPath}.`);
