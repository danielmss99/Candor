import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const exe = process.platform === "win32" ? "candor-core.exe" : "candor-core";
const corePath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(repoRoot, "crates", "candor-core", "target", "debug", exe);

if (!existsSync(corePath)) {
  throw new Error(`candor-core debug binary not found: ${corePath}`);
}

function rendererSourcePaths(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return rendererSourcePaths(target);
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return [];
    return [target];
  });
}

const rendererPaths = rendererSourcePaths(path.join(repoRoot, "v3", "renderer", "src"));
const preloadPath = path.join(repoRoot, "electron", "preload.cts");
const mainPath = path.join(repoRoot, "electron", "main.ts");
const licenseServicePath = path.join(repoRoot, "electron", "license-service.ts");
const stylePath = path.join(repoRoot, "v3", "renderer", "src", "styles.css");
const styleGuidePath = path.join(repoRoot, "design", "figma", "style-guide.md");
const tokenPath = path.join(repoRoot, "design", "figma", "token.json");
const rendererSource = rendererPaths.map((file) => readFileSync(file, "utf8")).join("\n");
const preloadSource = readFileSync(preloadPath, "utf8");
const mainSource = readFileSync(mainPath, "utf8");
const licenseServiceSource = readFileSync(licenseServicePath, "utf8");
const styleSource = readFileSync(stylePath, "utf8");
const styleGuideSource = readFileSync(styleGuidePath, "utf8");
const designTokens = JSON.parse(readFileSync(tokenPath, "utf8"));

function requireSource(source, pattern, label) {
  if (pattern instanceof RegExp) {
    if (!pattern.test(source)) throw new Error(`${label} missing pattern ${pattern}`);
    return;
  }
  if (!source.includes(pattern)) throw new Error(`${label} missing ${pattern}`);
}

function rejectSource(source, pattern, label) {
  if (pattern.test(source)) throw new Error(`${label} contains banned pattern ${pattern}`);
}

function relativeLuminance(hex) {
  const channels = hex
    .slice(1)
    .match(/../g)
    .map((value) => Number.parseInt(value, 16) / 255)
    .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground, background) {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

requireSource(rendererSource, 'aria-label="Meeting notes"', "M3 renderer");
requireSource(rendererSource, "<textarea", "M3 renderer");
requireSource(rendererSource, "saveMeetingNotes", "M3 renderer");
requireSource(rendererSource, "recordingNotesSave", "M3 renderer");
requireSource(rendererSource, "retentionStatus", "M3 renderer");
requireSource(rendererSource, 'aria-label="Local custody"', "M3 renderer");
requireSource(rendererSource, 'aria-label="Candor navigation"', "M3 renderer");
requireSource(rendererSource, 'aria-label="Primary"', "M3 renderer");
requireSource(rendererSource, "onKeyDown", "M3 renderer");
requireSource(rendererSource, "consentAcknowledge", "M3 renderer");
requireSource(rendererSource, 'aria-label="Local AI mode"', "M3 renderer");
requireSource(rendererSource, 'aria-pressed={aiMode === "quality"}', "M3 renderer");
requireSource(rendererSource, "Fast fallback, model unavailable", "M3 renderer");
requireSource(rendererSource, "document-preview", "M3 renderer");
requireSource(rendererSource, "saveLocalReport", "M3 renderer");
requireSource(rendererSource, "exportSaveLocal", "M3 renderer");
requireSource(rendererSource, "Word (.docx)", "M3 renderer");
requireSource(rendererSource, "Editable, local", "M3 renderer");
requireSource(rendererSource, "Searchable, local", "M3 renderer");
requireSource(rendererSource, "data-export-save", "M3 renderer");
requireSource(rendererSource, 'aria-label="Paper size"', "M3 renderer");
requireSource(rendererSource, "aiInstructAssetsStatus", "M3 renderer");
requireSource(rendererSource, "aiInstructAssetImportFromFile", "M3 renderer");
requireSource(rendererSource, 'data-view="home"', "M3 renderer");
requireSource(rendererSource, 'data-view="meeting"', "M3 renderer");
requireSource(rendererSource, 'data-view="library"', "M3 renderer");
requireSource(rendererSource, 'data-view="detail"', "M3 renderer");
requireSource(rendererSource, 'data-view="review"', "M3 renderer");
requireSource(rendererSource, 'data-view="settings"', "M3 renderer");
requireSource(rendererSource, 'data-view="export"', "M3 renderer");
requireSource(rendererSource, 'data-view="activation"', "M3 renderer");
requireSource(rendererSource, 'data-view="onboarding"', "M3 renderer");
requireSource(rendererSource, "session-tabs", "M3 renderer");
requireSource(rendererSource, "sidebar-record-action", "M3 renderer");
requireSource(rendererSource, "function RecordAction", "M3 renderer");
requireSource(rendererSource, "CandorClient", "M3 renderer");
requireSource(rendererSource, "useCaptureSession", "M3 renderer");
requireSource(rendererSource, "useLocalJob", "M3 renderer");
requireSource(rendererSource, "compact-pane-switcher", "M3 renderer");
requireSource(rendererSource, "privacy-receipt", "M3 renderer");
requireSource(rendererSource, "Privacy and diagnostics", "M3 renderer");
requireSource(rendererSource, 'data-state={active ? "recording" : "idle"}', "M3 renderer");
requireSource(rendererSource, "Stop recording and save local audio", "M3 renderer");
requireSource(rendererSource, "Dismiss notification", "M3 renderer");
requireSource(rendererSource, "Welcome to Candor", "M3 renderer");
requireSource(rendererSource, "Activate License", "M3 renderer");
requireSource(rendererSource, "Start Trial", "M3 renderer");
requireSource(rendererSource, "Candor is yours", "M3 renderer");
requireSource(rendererSource, "License Portal", "M3 renderer");
requireSource(rendererSource, "persistent account", "M3 renderer");
requireSource(rendererSource, "licenseApi.activate", "M3 renderer");
requireSource(rendererSource, "licenseApi.startTrial", "M3 renderer");
requireSource(rendererSource, "licenseApi.deactivateDevice", "M3 renderer");
requireSource(rendererSource, "aria-live=\"polite\"", "M3 renderer");
requireSource(rendererSource, "AnimatedTranscript", "M3 renderer");
requireSource(rendererSource, "EvidenceTimeline", "M3 renderer");
requireSource(rendererSource, 'aria-label="Audio evidence timeline"', "M3 renderer");
requireSource(rendererSource, "Mark moment", "M3 renderer");
requireSource(rendererSource, 'className="verification-text"', "M3 renderer");
requireSource(preloadSource, "recording.notes.read", "M3 preload");
requireSource(preloadSource, "recording.notes.save", "M3 preload");
requireSource(preloadSource, "recording.durable.listPage", "M3 preload");
requireSource(preloadSource, "recording.durable.transcriptPage", "M3 preload");
requireSource(preloadSource, "recording.privacyReceipt", "M3 preload");
requireSource(preloadSource, "privacy.capabilities", "M3 preload");
requireSource(preloadSource, "retention.status", "M3 preload");
requireSource(preloadSource, "candor-license:status", "M3 preload");
requireSource(preloadSource, "candor-license:activate", "M3 preload");
requireSource(preloadSource, "candor-license:startTrial", "M3 preload");
requireSource(preloadSource, "candor-license:deactivateDevice", "M3 preload");
requireSource(preloadSource, "candor-license:portalInfo", "M3 preload");
requireSource(preloadSource, "aiInstructStatus", "M3 preload");
requireSource(preloadSource, "aiRecapInstruct", "M3 preload");
requireSource(preloadSource, "aiAskInstruct", "M3 preload");
requireSource(preloadSource, "aiInstructAssetsStatus", "M3 preload");
requireSource(preloadSource, "aiInstructAssetImportFromFile", "M3 preload");
requireSource(preloadSource, "candor-instruct-assets:importFromFile", "M3 preload");
requireSource(preloadSource, "exportSaveLocal", "M3 preload");
requireSource(preloadSource, "candor-export:saveLocal", "M3 preload");
requireSource(mainSource, "LicenseService", "M3 main");
requireSource(mainSource, "candor-license:activate", "M3 main");
requireSource(mainSource, "candor-license:startTrial", "M3 main");
requireSource(mainSource, "candor-license:deactivateDevice", "M3 main");
requireSource(mainSource, "candor-export:saveLocal", "M3 main");
requireSource(mainSource, "dialog.showSaveDialog", "M3 main");
requireSource(mainSource, "decodeLocalExportResult", "M3 main");
requireSource(licenseServiceSource, "safeStorage", "M3 license service");
requireSource(licenseServiceSource, "persistentAccountRequired: false", "M3 license service");
requireSource(licenseServiceSource, "CANDOR_ENABLE_MOCK_LICENSE", "M3 license service");
requireSource(styleSource, "@media (max-width: 1280px)", "M3 styles");
requireSource(styleSource, "@media (max-width: 1080px)", "M3 styles");
requireSource(styleSource, "@media (max-width: 1180px)", "M3 styles");
requireSource(
  styleSource,
  /@media \(max-width: 1080px\)[\s\S]*?\.review-mode\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?grid-template-columns:\s*140px minmax\(300px, 1fr\) minmax\(230px, 250px\);/,
  "M3 compact Review Mode styles",
);
requireSource(styleSource, ".activation-shell", "M3 styles");
requireSource(styleSource, ".onboarding-progress", "M3 styles");
requireSource(styleSource, "--canvas: #0e1014", "M3 styles");
requireSource(styleSource, "--accent: #7357f2", "M3 styles");
requireSource(styleSource, "--accent-text: #8d79ff", "M3 styles");
requireSource(styleSource, ".live-meeting-view", "M3 styles");
requireSource(styleSource, ".export-preview-heading", "M3 styles");
requireSource(styleSource, ".evidence-marker.decision", "M3 styles");
requireSource(styleSource, "prefers-reduced-motion: reduce", "M3 styles");
requireSource(styleSource, '.record-action[data-state="recording"]', "M3 styles");
requireSource(styleSource, ".suggestion-pane", "M3 styles");
requireSource(styleSource, ".app-message > button", "M3 styles");
requireSource(styleGuideSource, "Candor Desktop Style Guide", "M3 Figma style guide");
requireSource(styleGuideSource, "No account, public sharing", "M3 Figma style guide");
if (designTokens?.source?.fileKey !== "wUT5Ai8170LZAmUqMfo2CI") {
  throw new Error("M3 design tokens do not identify the verified Candor Figma source");
}
if (designTokens?.color?.canvas?.$value !== "#0e1014" || designTokens?.color?.accent?.$value !== "#7357f2") {
  throw new Error("M3 design tokens do not match the verified Figma palette");
}
for (const backgroundToken of ["canvas", "surface", "surfaceRaised"]) {
  const ratio = contrastRatio(
    designTokens.color.accentText.$value,
    designTokens.color[backgroundToken].$value,
  );
  if (ratio < 4.5) {
    throw new Error(`M3 accent text contrast failed on ${backgroundToken}: ${ratio.toFixed(2)}:1`);
  }
}
rejectSource(rendererSource, /\blocalStorage\b/, "M3 renderer");
rejectSource(rendererSource, /\bsessionStorage\b/, "M3 renderer");
rejectSource(rendererSource, /figma\.com\/api\/mcp\/asset/, "M3 renderer");
rejectSource(rendererSource, /VERIFY_GLYPHS|verificationFrame|window\.setInterval/, "M3 renderer");
rejectSource(rendererSource, /Local (?:Word|PDF) renderer pending|<small>Pending<\/small>/, "M3 renderer");
rejectSource(rendererSource, /recordingDurableList\(/, "M3 renderer paged library");
rejectSource(rendererSource, /recordingDurableTranscript\(/, "M3 renderer paged transcript");
const fullRefreshCalls = rendererSource.match(/\brefresh\(\)/g) ?? [];
if (fullRefreshCalls.length !== 1) {
  throw new Error(`M3 renderer must reserve full refresh for startup; found ${fullRefreshCalls.length} calls`);
}
rejectSource(styleSource, /figma\.com\/api\/mcp\/asset/, "M3 styles");
rejectSource(styleSource, /:has\(\.message-stack:not\(:empty\)\)/, "M3 styles");

const dataDir = mkdtempSync(path.join(tmpdir(), "candor-v3-m3-surface-"));
const child = spawn(corePath, [], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
  env: {
    ...process.env,
    CANDOR_V3_DATA_DIR: dataDir,
  },
});

const lines = createInterface({ input: child.stdout });
const pending = new Map();
let nextId = 1;

child.stderr.on("data", (chunk) => {
  process.stderr.write(`[candor-core stderr] ${chunk}`);
});

lines.on("line", (line) => {
  const response = JSON.parse(line);
  const entry = pending.get(response.id);
  if (!entry) return;
  pending.delete(response.id);
  if (response.ok) {
    entry.resolve(response.result);
  } else {
    const error = new Error(response.error?.message ?? "RPC failed");
    error.code = response.error?.code;
    error.response = response;
    entry.reject(error);
  }
});

function call(method, params = null) {
  const id = nextId++;
  const payload = JSON.stringify({ id, method, params });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for ${method}`));
    }, 5000);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      reject: (err) => {
        clearTimeout(timeout);
        reject(err);
      },
    });
    child.stdin.write(`${payload}\n`);
  });
}

function assertCustody(value, label) {
  const serialized = JSON.stringify(value);
  if (serialized.includes(dataDir)) {
    throw new Error(`${label} exposed the data root path`);
  }
  visit(value, label);
}

function visit(value, label) {
  if (Array.isArray(value)) {
    for (const item of value) visit(item, label);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, childValue] of Object.entries(value)) {
    if (key === "rawPathExposed" && childValue !== false) {
      throw new Error(`${label} reported raw path exposure`);
    }
    if (key === "keyMaterialExposedToRenderer" && childValue !== false) {
      throw new Error(`${label} reported key material exposure`);
    }
    visit(childValue, label);
  }
}

try {
  const capabilities = await call("core.capabilities");
  const allowed = capabilities?.allowedMethods ?? [];
  for (const method of ["recording.notes.read", "recording.notes.save", "retention.status", "recording.durable.listPage", "recording.durable.transcriptPage", "recording.privacyReceipt", "privacy.capabilities"]) {
    if (!allowed.includes(method)) throw new Error(`core capabilities omitted ${method}`);
  }

  const retention = await call("retention.status");
  assertCustody(retention, "retention status");
  if (
    retention?.policy !== "manual-delete-only" ||
    retention?.automaticDeletion !== false ||
    retention?.notesSavedWithRecording !== true
  ) {
    throw new Error("retention status did not report the M3 local retention contract");
  }

  const started = await call("recording.durable.start", { label: "M3 Product Surface" });
  const recordingId = started.recordingId;
  await call("recording.durable.writeTranscriptSegment", {
    recordingId,
    channel: "mic",
    speaker: "Alex",
    text: "Decision: save rough notes inside the local meeting record.",
    startMs: 0,
    durationMs: 1300,
    confidence: 0.98,
  });
  const savedNotes = await call("recording.notes.save", {
    recordingId,
    markdown: "## Rough notes\n\n- Decision: keep notes with the encrypted local recording.",
  });
  assertCustody(savedNotes, "saved notes");
  if (
    savedNotes?.savedLocally !== true ||
    savedNotes?.notesChunkCount !== 1 ||
    !savedNotes?.markdown?.includes("Rough notes")
  ) {
    throw new Error("saved notes response did not prove local note persistence");
  }

  const readNotes = await call("recording.notes.read", { recordingId });
  assertCustody(readNotes, "read notes");
  if (readNotes?.markdown !== savedNotes?.markdown) {
    throw new Error("read notes did not return the saved local markdown");
  }

  const search = await call("recording.durable.search", { query: "Rough notes" });
  assertCustody(search, "notes search");
  const searchMatches = Array.isArray(search?.matches) ? search.matches : [];
  if (search?.matchCount < 1 || !searchMatches.some((match) => match?.channel === "notes")) {
    throw new Error("local search did not index meeting notes");
  }

  const exported = await call("export.create", { recordingId, format: "markdown" });
  assertCustody(exported, "notes export");
  if (
    !exported?.markdown?.includes("## Local Notes") ||
    !exported?.markdown?.includes("keep notes with the encrypted local recording") ||
    !exported?.markdown?.includes("## Local Transcript")
  ) {
    throw new Error("markdown export did not include notes before transcript");
  }

  const list = await call("recording.durable.listPage", { offset: 0, limit: 50 });
  assertCustody(list, "recording list");
  if (list?.recordings?.[0]?.notesChunkCount !== 1 || !(list?.recordings?.[0]?.notesBytes > 0)) {
    throw new Error("recording library did not expose pathless notes summary facts");
  }

  const privacyCapabilities = await call("privacy.capabilities");
  assertCustody(privacyCapabilities, "network capability matrix");
  if (privacyCapabilities?.externalCallsAttempted !== 0) {
    throw new Error("network capability matrix reported external calls");
  }

  const receipt = await call("recording.privacyReceipt", { recordingId });
  assertCustody(receipt, "meeting privacy receipt");
  if (receipt?.proofKind !== "meeting-privacy-receipt" || receipt?.content?.notesSavedLocally !== true) {
    throw new Error("meeting privacy receipt did not report core-backed local facts");
  }

  await call("core.shutdown");
  console.log("M3 product surface smoke passed.");
} finally {
  if (!child.killed) child.kill();
  rmSync(dataDir, { recursive: true, force: true });
}
