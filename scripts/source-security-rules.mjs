import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

export const requiredSourcePaths = [
  ".gitignore",
  "electron/main.ts",
  "electron/preload.cts",
  "electron/core/json.ts",
  "electron/core/live-transcript-event-bridge.ts",
  "electron/core/core-client.ts",
  "electron/core/core-errors.ts",
  "electron/core/capture-recovery-store.ts",
  "electron/core/background-task.ts",
  "electron/core/operation-registry.ts",
  "electron/core/protocol.ts",
  "electron/core/renderer-boundary.ts",
  "electron/core/request-registry.ts",
  "electron/diagnostics/diagnostic-report.ts",
  "electron/export/local-report.ts",
  "electron/ipc/core-ipc.ts",
  "electron/ipc/capture-settings-ipc.ts",
  "electron/ipc/diagnostics-ipc.ts",
  "electron/ipc/export-ipc.ts",
  "electron/ipc/import-ipc.ts",
  "electron/ipc/jobs-ipc.ts",
  "electron/ipc/ipc-types.ts",
  "electron/ipc/licensing-ipc.ts",
  "electron/ipc/models-ipc.ts",
  "electron/ipc/register-ipc.ts",
  "electron/ipc/terminology-ipc.ts",
  "electron/security/input-limits.ts",
  "electron/security/validate-core-input.ts",
  "electron/security/validate-private-core-input.ts",
  "electron/security/validate-sender.ts",
  "electron/smoke/m0-smoke.ts",
  "electron/security/network-policy.ts",
  "electron/window/create-main-window.ts",
  "electron/window/capture-close-guard.ts",
  "electron/window/navigation-policy.ts",
  "electron/license-service.ts",
  "scripts/build-release-core.mjs",
  "scripts/release-binary-path-audit.mjs",
  "scripts/core-rpc-envelope.mjs",
  "scripts/electron-dev.mjs",
  "v3/renderer/index.html",
  "v3/renderer/src/candor-api.d.ts",
  "crates/candor-core/Cargo.toml",
  "crates/candor-core/Cargo.lock",
  "crates/candor-core/src/lib.rs",
  "crates/candor-core/src/live_transcript_service.rs",
  "crates/candor-core/src/live_transcription.rs",
  "crates/candor-core/src/main.rs",
  "crates/candor-core/src/dictionary_staging.rs",
  "crates/candor-core/src/job_manager.rs",
  "crates/candor-core/src/v2_importer.rs",
  "crates/candor-tools/Cargo.toml",
  "crates/candor-tools/Cargo.lock",
  "crates/candor-tools/src/lib.rs",
  "crates/candor-tools/src/cli.rs",
  "crates/candor-tools/src/core_client.rs",
  "crates/candor-tools/src/mcp.rs",
  "crates/candor-tools/src/service.rs",
  "crates/candor-tools/src/bin/candorctl.rs",
  "crates/candor-tools/src/bin/candor-mcp.rs",
  "docs/mcp-server.md",
  "scripts/spec3-verify-ai-bundle.mjs",
  "scripts/spec6-acquire-release-model.mjs",
  "scripts/spec6-release-publication-gate.mjs",
  "third_party/model-lock.json",
  "electron-builder.v3.yml",
  "electron-builder.source-interface.yml",
  "package.json",
];

function runGit(repoRoot, args) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    shell: false,
  });
  if (result.error) throw result.error;
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function toRepoPath(repoRoot, absolutePath) {
  return relative(repoRoot, absolutePath).replaceAll("\\", "/");
}

function isActiveSource(pathValue) {
  return /^(electron|v3\/renderer\/src|crates\/candor-core\/src|scripts)\//.test(pathValue) ||
    /^crates\/candor-tools\/src\//.test(pathValue) ||
    ["crates/candor-tools/Cargo.toml", "crates/candor-tools/Cargo.lock"].includes(pathValue) ||
    pathValue === "docs/mcp-server.md";
}

export function collectSourceSecurityInput(repoRoot) {
  const normalizedRoot = resolve(repoRoot);
  const trackedActivePaths = runGit(normalizedRoot, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    "electron",
    "v3/renderer/src",
    "crates/candor-core/src",
    "crates/candor-tools/Cargo.toml",
    "crates/candor-tools/Cargo.lock",
    "crates/candor-tools/src",
    "docs/mcp-server.md",
    "scripts",
  ]).filter(isActiveSource);
  const sourcePaths = new Set([...requiredSourcePaths, ...trackedActivePaths]);
  const sources = Object.fromEntries(
    [...sourcePaths].map((sourcePath) => {
      const absolutePath = resolve(normalizedRoot, sourcePath);
      return [sourcePath, existsSync(absolutePath) ? readFileSync(absolutePath, "utf8") : null];
    }),
  );

  return {
    sources,
    trackedActivePaths,
    trackedEnvironmentFiles: runGit(normalizedRoot, [
      "ls-files",
      "--",
      ".env",
      ".env.local",
      ".env.production",
    ]),
    ignoredEnvironmentFiles: runGit(normalizedRoot, [
      "check-ignore",
      ".env",
      ".env.local",
      ".env.production",
    ]),
    rootLabel: toRepoPath(normalizedRoot, normalizedRoot) || ".",
  };
}

function sourceText(input, pathValue) {
  return typeof input.sources[pathValue] === "string" ? input.sources[pathValue] : "";
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsElectronNetCall(source) {
  const netBindings = new Set();
  const electronBindings = new Set();

  for (const match of source.matchAll(/\bimport\s*\{([^}]*)\}\s*from\s*["']electron["']/g)) {
    for (const specifier of match[1].split(",")) {
      const binding = specifier.trim().match(/^net(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
      if (binding) netBindings.add(binding[1] ?? "net");
    }
  }
  for (const match of source.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:await\s+)?(?:require\s*\(\s*["']electron["']\s*\)|import\s*\(\s*["']electron["']\s*\))/g)) {
    for (const specifier of match[1].split(",")) {
      const binding = specifier.trim().match(/^net(?:\s*:\s*([A-Za-z_$][\w$]*))?$/);
      if (binding) netBindings.add(binding[1] ?? "net");
    }
  }
  for (const pattern of [
    /\bimport\s*\*\s*as\s*([A-Za-z_$][\w$]*)\s*from\s*["']electron["']/g,
    /\bimport\s+([A-Za-z_$][\w$]*)\s+from\s*["']electron["']/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:require\s*\(\s*["']electron["']\s*\)|import\s*\(\s*["']electron["']\s*\))/g,
  ]) {
    for (const match of source.matchAll(pattern)) electronBindings.add(match[1]);
  }

  if (netBindings.size > 0) return true;
  for (const binding of electronBindings) {
    if (new RegExp(`\\b${escapeRegExp(binding)}\\s*\\.\\s*net\\b`).test(source)) return true;
  }
  return /\(?\s*(?:await\s+)?(?:require\s*\(\s*["']electron["']\s*\)|import\s*\(\s*["']electron["']\s*\))\s*\)?\s*\.\s*net\b/.test(source);
}

function blankRustSource(value) {
  return value.replace(/[^\r\n]/g, " ");
}

function blankRustCfgTestItems(value) {
  const characters = value.split("");
  const testAttribute = /#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]/g;
  for (const match of value.matchAll(testAttribute)) {
    const start = match.index;
    let cursor = start + match[0].length;
    while (/\s/.test(value[cursor] ?? "")) cursor += 1;

    let openingBrace = -1;
    let terminator = -1;
    let parentheses = 0;
    let brackets = 0;
    for (let index = cursor; index < value.length; index += 1) {
      const character = value[index];
      if (character === "(") parentheses += 1;
      else if (character === ")") parentheses = Math.max(0, parentheses - 1);
      else if (character === "[") brackets += 1;
      else if (character === "]") brackets = Math.max(0, brackets - 1);
      else if (parentheses === 0 && brackets === 0 && character === "{") {
        openingBrace = index;
        break;
      } else if (parentheses === 0 && brackets === 0 && character === ";") {
        terminator = index + 1;
        break;
      }
    }

    if (openingBrace >= 0) {
      let depth = 1;
      terminator = openingBrace + 1;
      while (terminator < value.length && depth > 0) {
        if (value[terminator] === "{") depth += 1;
        else if (value[terminator] === "}") depth -= 1;
        terminator += 1;
      }
    }
    if (terminator < 0) terminator = value.length;
    for (let index = start; index < terminator; index += 1) {
      if (characters[index] !== "\r" && characters[index] !== "\n") characters[index] = " ";
    }
  }
  return characters.join("");
}

function rustProductionCode(value) {
  const source = value;
  let output = "";
  let index = 0;
  while (index < source.length) {
    if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index);
      const next = end < 0 ? source.length : end;
      output += blankRustSource(source.slice(index, next));
      index = next;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const start = index;
      let depth = 1;
      index += 2;
      while (index < source.length && depth > 0) {
        if (source.startsWith("/*", index)) {
          depth += 1;
          index += 2;
        } else if (source.startsWith("*/", index)) {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      output += blankRustSource(source.slice(start, index));
      continue;
    }

    const rawString = source.slice(index).match(/^(?:br|r)(#{0,16})"/);
    if (rawString) {
      const start = index;
      const terminator = `"${rawString[1]}`;
      index += rawString[0].length;
      const end = source.indexOf(terminator, index);
      index = end < 0 ? source.length : end + terminator.length;
      output += blankRustSource(source.slice(start, index));
      continue;
    }

    const byteString = source.startsWith('b"', index);
    if (byteString || source[index] === '"') {
      const start = index;
      index += byteString ? 2 : 1;
      while (index < source.length) {
        if (source[index] === "\\") {
          index = Math.min(source.length, index + 2);
        } else if (source[index] === '"') {
          index += 1;
          break;
        } else {
          index += 1;
        }
      }
      output += blankRustSource(source.slice(start, index));
      continue;
    }

    output += source[index];
    index += 1;
  }
  return blankRustCfgTestItems(output);
}

export function evaluateSourceSecurity(input) {
  const checks = [];
  const add = (id, ok, file, detail) => checks.push({ id, ok: Boolean(ok), file, detail });
  const includes = (id, file, pattern, detail) => {
    add(id, sourceText(input, file).includes(pattern), file, detail);
  };
  const excludes = (id, file, pattern, detail) => {
    add(id, !pattern.test(sourceText(input, file)), file, detail);
  };

  for (const sourcePath of requiredSourcePaths) {
    add(
      `required-source:${sourcePath}`,
      typeof input.sources[sourcePath] === "string",
      sourcePath,
      "required Electron/Rust source exists",
    );
  }

  const main = "electron/main.ts";
  const electronRuntimeEntries = Object.entries(input.sources)
    .filter(([sourcePath, content]) =>
      sourcePath.startsWith("electron/") &&
      sourcePath !== "electron/preload.cts" &&
      !sourcePath.endsWith(".test.ts") &&
      typeof content === "string"
    );
  const electronRuntimeSource = electronRuntimeEntries
    .map(([, content]) => content)
    .join("\n");
  const electronNetworkSurfaceEntries = Object.entries(input.sources)
    .filter(([sourcePath, content]) =>
      (sourcePath.startsWith("electron/") || sourcePath.startsWith("v3/renderer/src/")) &&
      !sourcePath.startsWith("electron/smoke/") &&
      !sourcePath.startsWith("electron/test-core/") &&
      !/\.test\.[cm]?[jt]sx?$/.test(sourcePath) &&
      /\.[cm]?[jt]sx?$/.test(sourcePath) &&
      typeof content === "string"
    );
  const electronNetworkSurfaceSource = electronNetworkSurfaceEntries
    .map(([, content]) => content)
    .join("\n");
  const modelAcquisitionPath = "electron/models/model-acquisition-service.ts";
  const electronNetworkSourceOutsideModelAcquisition = electronNetworkSurfaceEntries
    .filter(([sourcePath]) => sourcePath !== modelAcquisitionPath)
    .map(([, content]) => content)
    .join("\n");
  const modelAcquisitionSource = sourceText(input, modelAcquisitionPath);
  const arbitraryShellOpenSource = electronRuntimeEntries
    .filter(([sourcePath]) => sourcePath !== "electron/ipc/capture-settings-ipc.ts")
    .map(([, content]) => content)
    .join("\n");
  for (const [id, pattern] of [
    ["insecure-content-disabled", "allowRunningInsecureContent: false"],
    ["permission-request-denied", "denyPermissionRequest(callback)"],
    ["permission-check-denied", "setPermissionCheckHandler(denyPermissionCheck)"],
    ["popup-blocked", "setWindowOpenHandler"],
    ["navigation-blocked", 'on("will-navigate"'],
    ["webview-blocked", 'on("will-attach-webview"'],
    ["background-networking-disabled", 'appendSwitch("disable-background-networking")'],
    ["component-update-disabled", 'appendSwitch("disable-component-update")'],
    ["domain-reliability-disabled", 'appendSwitch("disable-domain-reliability")'],
    ["proxy-disabled", 'appendSwitch("no-proxy-server")'],
    ["sync-disabled", 'appendSwitch("disable-sync")'],
    ["loopback-dev-url", "CANDOR_V3_RENDERER_URL must use loopback HTTP without credentials"],
  ]) {
    add(`electron-main:${id}`, electronRuntimeSource.includes(pattern), main, `Electron runtime requires ${id}`);
  }
  for (const [id, pattern] of [
    ["context-isolation", /contextIsolation\s*:\s*true/g],
    ["sandbox", /sandbox\s*:\s*true/g],
    ["node-disabled", /nodeIntegration\s*:\s*false/g],
    ["web-security", /webSecurity\s*:\s*true/g],
  ]) {
    const count = [...electronRuntimeSource.matchAll(pattern)].length;
    add(
      `electron-main:${id}`,
      count >= 2,
      main,
      `all BrowserWindow configurations require ${id}; observed ${count}`,
    );
  }
  add("electron-main:no-node-integration", !/nodeIntegration\s*:\s*true/.test(electronRuntimeSource), main, "Node.js stays disabled");
  add("electron-main:no-sandbox-disable", !/sandbox\s*:\s*false/.test(electronRuntimeSource), main, "sandbox stays enabled");
  add("electron-main:no-context-disable", !/contextIsolation\s*:\s*false/.test(electronRuntimeSource), main, "context isolation stays enabled");
  add("electron-main:no-auto-updater", !/\bautoUpdater\b/.test(electronRuntimeSource), main, "background updater is absent");
  add("electron-main:no-crash-upload", !/crashReporter\.start\s*\(/.test(electronRuntimeSource), main, "crash upload is absent");
  add("electron-main:no-shell-open", !/shell\.openExternal\s*\(/.test(arbitraryShellOpenSource), main, "main does not open arbitrary URLs");
  add(
    "electron-runtime:no-node-network-imports",
    !/\bfrom\s*["'](?:node:)?(?:http|https|net|tls|dgram|dns(?:\/promises)?)["']|\b(?:require|import)\s*\(\s*["'](?:node:)?(?:http|https|net|tls|dgram|dns(?:\/promises)?)["']/.test(electronNetworkSourceOutsideModelAcquisition),
    "electron/ and v3/renderer/src/",
    "production Electron and renderer source imports no Node network module outside the reviewed model-acquisition broker",
  );
  add(
    "model-acquisition:https-only",
    /from\s*["']node:https["']/.test(modelAcquisitionSource)
      && !/from\s*["'](?:node:)?(?:net|tls|dgram|dns(?:\/promises)?)["']/.test(modelAcquisitionSource)
      && !/\b(?:fetch|WebSocket|EventSource)\s*\(/.test(modelAcquisitionSource),
    modelAcquisitionPath,
    "the sole model acquisition broker uses bounded HTTPS without raw sockets, DNS APIs, fetch, or browser transports",
  );
  add(
    "electron-runtime:no-network-calls",
    !/\b(?:fetch|WebSocket|EventSource)\s*\(/.test(electronNetworkSurfaceSource) &&
      !Object.entries(input.sources)
        .filter(([sourcePath, content]) =>
          (sourcePath.startsWith("electron/") || sourcePath.startsWith("v3/renderer/src/")) &&
          !sourcePath.startsWith("electron/smoke/") &&
          !sourcePath.startsWith("electron/test-core/") &&
          !/\.test\.[cm]?[jt]sx?$/.test(sourcePath) &&
          /\.[cm]?[jt]sx?$/.test(sourcePath) &&
          typeof content === "string"
        )
        .some(([, content]) => containsElectronNetCall(content)),
    "electron/ and v3/renderer/src/",
    "production Electron and renderer source opens no fetch, WebSocket, EventSource, or Electron net request",
  );
  excludes(
    "electron-runtime:no-network-dependencies",
    "package.json",
    /"(?:axios|undici|node-fetch|got|superagent|ws|socket\.io|socket\.io-client)"\s*:/i,
    "root package has no direct Electron or renderer network client dependency",
  );
  includes(
    "electron-main:fixed-windows-microphone-settings",
    "electron/ipc/capture-settings-ipc.ts",
    'return "ms-settings:privacy-microphone";',
    "Windows microphone settings use a fixed destination",
  );
  includes(
    "electron-main:fixed-macos-microphone-settings",
    "electron/ipc/capture-settings-ipc.ts",
    'return "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";',
    "macOS microphone settings use a fixed destination",
  );
  add("electron-main:no-sandbox-flag", !/--no-sandbox|ELECTRON_DISABLE_SANDBOX/.test(electronRuntimeSource), main, "sandbox bypass is absent");
  includes(
    "electron-main:permission-request-false",
    "electron/security/network-policy.ts",
    "callback(false);",
    "permission requests are denied unconditionally",
  );
  includes(
    "electron-main:permission-check-false",
    "electron/security/network-policy.ts",
    "return false;",
    "permission checks are denied unconditionally",
  );
  includes(
    "electron-main:capture-close-prevented",
    "electron/window/capture-close-guard.ts",
    "event.preventDefault();",
    "window close is blocked until the capture guard approves it",
  );
  includes(
    "electron-main:capture-finalized-before-shutdown",
    "electron/window/capture-close-guard.ts",
    "await dependencies.finalizeCapture();",
    "capture finalization completes before core shutdown",
  );
  includes(
    "electron-main:active-capture-shutdown-denied",
    "electron/core/core-client.ts",
    'if (this.captureGuardPhase() !== "idle")',
    "core shutdown is denied while capture is active or changing state",
  );
  includes(
    "electron-main:operation-registry",
    "electron/core/operation-registry.ts",
    "export const CORE_OPERATIONS",
    "core operations are registered in one runtime-validated allowlist",
  );
  includes(
    "electron-main:private-input-validation",
    "electron/security/validate-private-core-input.ts",
    "export function validatePrivateCoreParams",
    "private core operations have explicit input contracts",
  );
  includes(
    "electron-main:capture-recovery-allowlist",
    "electron/core/capture-recovery-store.ts",
    "SAFE_METHOD.test",
    "capture recovery metadata is reduced to safe allowlisted fields",
  );
  includes(
    "electron-main:jobs-ipc-sender-validation",
    "electron/ipc/jobs-ipc.ts",
    "validateIpcSender",
    "job IPC validates the sender before calling the core",
  );
  includes(
    "electron-main:jobs-event-validation",
    "electron/ipc/jobs-ipc.ts",
    "parseBackgroundTask(coreEvent.payload)",
    "background-task events are validated before renderer delivery",
  );
  includes(
    "proof-clients:versioned-core-envelope",
    "scripts/core-rpc-envelope.mjs",
    "createVersionedCoreRequest",
    "proof clients use the same versioned request envelope as Electron",
  );
  includes(
    "diagnostics:allowlisted-report",
    "electron/diagnostics/diagnostic-report.ts",
    'contentPolicy: "metadata-only-no-user-content"',
    "diagnostic output declares its metadata-only content policy",
  );
  includes(
    "diagnostics:no-user-content",
    "electron/diagnostics/diagnostic-report.ts",
    "userContentIncluded: false",
    "diagnostic output explicitly excludes user content",
  );
  includes(
    "diagnostics:main-owned-save",
    "electron/ipc/diagnostics-ipc.ts",
    'ipcMain.handle("candor-diagnostics:saveLocal"',
    "diagnostic saving is an exact main-process operation",
  );

  const preload = "electron/preload.cts";
  for (const [id, pattern] of [
    ["context-bridge", 'contextBridge.exposeInMainWorld("candor"'],
    ["api-version", "version: 4 as const"],
    ["app-frozen", "app: Object.freeze("],
    ["capture-frozen", "capture: Object.freeze("],
    ["meetings-frozen", "meetings: Object.freeze("],
    ["transcript-frozen", "transcript: Object.freeze("],
    ["ai-frozen", "ai: Object.freeze("],
    ["exports-frozen", "exports: Object.freeze("],
    ["settings-frozen", "settings: Object.freeze("],
    ["licensing-frozen", "licensing: Object.freeze("],
    ["events-frozen", "events: Object.freeze("],
    ["named-status-channel", 'invoke("candor-app:getStatus")'],
    ["durable-status", 'invoke("candor-core:recording-durable-status")'],
    ["diagnostics-preview", 'invoke("candor-diagnostics:preview")'],
    ["diagnostics-save", 'invoke("candor-diagnostics:saveLocal")'],
  ]) {
    includes(`preload:${id}`, preload, pattern, `preload requires ${id}`);
  }
  excludes("preload:no-node-modules", preload, /from\s+["']node:|require\s*\(/, "preload imports no Node.js modules");
  excludes(
    "preload:no-generic-capabilities",
    preload,
    /\b(?:invoke|readFile|writeFile|runProcess|openPath)\s*:/,
    "preload exposes no generic IPC, filesystem, process, or path operation",
  );
  excludes("preload:no-selected-path", preload, /selectedPath|destinationPath/, "renderer never receives selected paths");
  excludes(
    "preload:no-dictionary-archive-bytes",
    preload,
    /importDictionaryPackage|importPackageBytes|archiveBytes/,
    "dictionary package bytes never enter the renderer preload surface",
  );
  excludes("preload:no-generic-core-channel", preload, /candor-core:call|\bcallCore\b|\ballowedMethods\b/, "preload uses fixed product channels only");
  excludes("preload:no-infrastructure-groups", preload, /\b(?:core|shell|license):\s*Object\.freeze/, "preload exposes product domains instead of infrastructure groups");
  add(
    "electron-main:no-generic-core-channel",
    !/candor-core:call/.test(electronRuntimeSource),
    "electron/ipc/core-ipc.ts",
    "main registers fixed product channels only",
  );
  includes(
    "electron-main:validated-core-input",
    "electron/ipc/core-ipc.ts",
    "validateRendererCoreParams(operation.method, params ?? null)",
    "each named core channel validates its payload before crossing into Rust",
  );
  includes(
    "electron-main:safe-core-errors",
    "electron/ipc/core-ipc.ts",
    "rendererSafeCoreError(response.error?.code)",
    "renderer receives only bounded core error codes",
  );
  excludes(
    "electron-main:no-raw-core-errors",
    "electron/ipc/core-ipc.ts",
    /response\.error\?\.message/,
    "renderer IPC never forwards raw Rust error text",
  );

  const rendererDeclaration = "v3/renderer/src/candor-api.d.ts";
  includes(
    "renderer-api:v4",
    rendererDeclaration,
    "interface CandorApiV4",
    "renderer declaration matches the domain preload API version",
  );
  includes(
    "renderer-api:meetings-storage-status",
    rendererDeclaration,
    "getStorageStatus(): Promise<JsonValue>",
    "renderer declaration includes the meeting storage status operation",
  );
  excludes(
    "renderer-api:no-generic-capabilities",
    rendererDeclaration,
    /\b(?:invoke|readFile|writeFile|runProcess|openPath)\s*\(/,
    "renderer declaration exposes no generic capabilities",
  );
  excludes(
    "renderer-api:no-dictionary-archive-bytes",
    rendererDeclaration,
    /importDictionaryPackage|archiveBytes/,
    "renderer declarations cannot accept dictionary archive bytes",
  );

  const terminologyIpc = "electron/ipc/terminology-ipc.ts";
  includes(
    "dictionary:native-file-picker",
    terminologyIpc,
    'ipcMain.handle("candor-terminology:importFromFile"',
    "dictionary packages enter through a sender-validated native file picker",
  );

  const rendererHtml = "v3/renderer/index.html";
  for (const directive of [
    "default-src 'self'",
    "script-src 'self'",
    "media-src 'self' blob:",
    "connect-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ]) {
    includes(`renderer-csp:${directive}`, rendererHtml, directive, `CSP includes ${directive}`);
  }

  const packageJson = "package.json";
  excludes("package:no-tauri-dependencies", packageJson, /@tauri-apps\//, "Tauri npm dependencies are absent");
  includes("package:electron-main", packageJson, '"main": "dist-v3/electron/main.js"', "Electron main is authoritative");
  includes("package:electron-dev", packageJson, '"dev": "node scripts/electron-dev.mjs --dev"', "root dev is Electron");
  includes("package:electron-build", packageJson, '"build": "npm run electron:v3:build"', "root build is Electron");
  includes("package:electron-dist", packageJson, '"dist": "npm run electron:v3:dist"', "root dist is Electron");
  includes(
    "package:source-interface-builder",
    packageJson,
    "electron-builder --config electron-builder.source-interface.yml",
    "ordinary packaging uses the separately identified source-interface product",
  );
  includes(
    "package:complete-release-gate",
    packageJson,
    "spec3-verify-ai-bundle.mjs --require-ready --profile complete",
    "Complete packaging is gated by the exact ready manifest profile",
  );
  includes(
    "package:publication-self-test",
    packageJson,
    "release:publication-policy:self-test",
    "ordinary builds exercise the release publication policy self-test",
  );

  const builder = "electron-builder.v3.yml";
  includes("builder:asar", builder, "asar: true", "application source is archived");
  includes("builder:publish-disabled", builder, "publish: null", "automatic publishing is disabled");
  includes("builder:core-resource", builder, "build/core-bin", "staged Rust core is packaged as a resource");
  includes("builder:offline-nsis", builder, "- nsis", "Windows releases use the offline NSIS target");
  excludes("builder:no-web-installer", builder, /nsis-web/i, "web installers remain prohibited");

  const sourceInterfaceBuilder = "electron-builder.source-interface.yml";
  includes(
    "builder:source-interface-name",
    sourceInterfaceBuilder,
    "productName: Candor Source Interface",
    "developer and CI packages have a visibly different product name",
  );
  includes(
    "builder:source-interface-id",
    sourceInterfaceBuilder,
    "appId: com.candor.v3.source-interface",
    "developer and CI packages use a separate application identity",
  );

  const coreMain = "crates/candor-core/src/main.rs";
  includes("core:bounded-rpc", coreMain, "MAX_RPC_LINE_BYTES", "Rust core bounds JSONL frames");
  includes("core:bounded-rpc-reader", coreMain, "read_bounded_frame", "Rust core bounds frames before allocation");
  includes("core:duplicate-request-rejection", coreMain, "DUPLICATE_REQUEST_ID", "Rust core rejects replayed request ids");
  includes("core:stdio-transport", coreMain, '"stdio-json-lines"', "Rust core uses stdio transport");
  includes("core:protocol-version", coreMain, '"protocolVersion"', "Rust core reports protocol version");
  includes("core:protocol-handshake", coreMain, '"schemaVersion"', "Rust core reports the schema handshake");

  const coreCargo = "crates/candor-core/Cargo.toml";
  const coreCargoLock = "crates/candor-core/Cargo.lock";
  const coreProductionRust = Object.entries(input.sources)
    .filter(([sourcePath, content]) =>
      sourcePath.startsWith("crates/candor-core/src/") &&
      sourcePath.endsWith(".rs") &&
      typeof content === "string"
    )
    .map(([, content]) => rustProductionCode(content))
    .join("\n");
  const networkDependencyPattern = /^\s*(?:reqwest|hyper|ureq|curl|isahc|surf|axum|warp|actix-web|rocket|tonic|tungstenite|tokio-tungstenite|socket2)\s*=|\bpackage\s*=\s*"(?:reqwest|hyper|ureq|curl|isahc|surf|axum|warp|actix-web|rocket|tonic|tungstenite|tokio-tungstenite|socket2)"/m;
  const lockedNetworkDependencyPattern = /^name\s*=\s*"(?:reqwest|hyper|ureq|curl|isahc|surf|axum|warp|actix-web|rocket|tonic|tungstenite|tokio-tungstenite|socket2)"$/m;
  excludes(
    "core:no-network-client-dependency",
    coreCargo,
    networkDependencyPattern,
    "Rust core has no network client, server, or socket dependency",
  );
  excludes(
    "core:no-network-client-dependency-locked",
    coreCargoLock,
    lockedNetworkDependencyPattern,
    "Rust core lockfile contains no network client, server, or socket package",
  );
  add(
    "core:no-network-apis",
    !/\b(?:TcpListener|TcpStream|UdpSocket|ToSocketAddrs)\b|\bstd\s*::\s*net\b|\btokio\s*::\s*net\b|\bhyper\s*::\s*Server\b|\baxum\s*::\s*serve\b/.test(coreProductionRust),
    "crates/candor-core/src",
    "Rust core production source opens no network listener, stream, datagram, or address resolver",
  );

  const automationCargo = "crates/candor-tools/Cargo.toml";
  const automationCargoLock = "crates/candor-tools/Cargo.lock";
  const automationCoreClient = "crates/candor-tools/src/core_client.rs";
  const automationService = "crates/candor-tools/src/service.rs";
  const automationCli = "crates/candor-tools/src/cli.rs";
  const automationMcp = "crates/candor-tools/src/mcp.rs";
  const automationDocs = "docs/mcp-server.md";
  const automationRust = [
    "crates/candor-tools/src/lib.rs",
    automationCli,
    automationCoreClient,
    automationMcp,
    automationService,
    "crates/candor-tools/src/bin/candorctl.rs",
    "crates/candor-tools/src/bin/candor-mcp.rs",
  ].map((sourcePath) => sourceText(input, sourcePath)).join("\n");
  const automationProductionRust = [
    "crates/candor-tools/src/lib.rs",
    automationCli,
    automationCoreClient,
    automationMcp,
    automationService,
    "crates/candor-tools/src/bin/candorctl.rs",
    "crates/candor-tools/src/bin/candor-mcp.rs",
  ].map((sourcePath) => sourceText(input, sourcePath).split("#[cfg(test)]", 1)[0]).join("\n");
  const quotedMatchArms = (content, startPattern, endPattern) => {
    const start = content.search(startPattern);
    if (start < 0) return [];
    const tail = content.slice(start);
    const end = tail.search(endPattern);
    const body = end < 0 ? tail : tail.slice(0, end);
    return [...body.matchAll(/^\s*"([^"]+)"\s*=>/gm)].map((match) => match[1]);
  };
  const exactList = (actual, expected) =>
    actual.length === expected.length && actual.every((value, index) => value === expected[index]);
  const coreAllowlistMatch = sourceText(input, automationCoreClient).match(
    /pub const ALLOWED_CORE_METHODS:\s*&\[&str\]\s*=\s*&\[(.*?)\];/s,
  );
  const coreAllowlist = coreAllowlistMatch
    ? [...coreAllowlistMatch[1].matchAll(/"([^"]+)"/g)].map((match) => match[1])
    : [];
  const expectedCoreAllowlist = [
    "recording.durable.listPage",
    "recording.durable.transcriptPage",
    "recording.durable.search",
    "core.shutdown",
  ];
  add(
    "automation:exact-core-allowlist",
    exactList(coreAllowlist, expectedCoreAllowlist),
    automationCoreClient,
    "automation companions can call only the reviewed read methods and lifecycle shutdown",
  );
  const toolInvokeAllowlist = quotedMatchArms(
    sourceText(input, automationService),
    /let result = match tool\s*\{/,
    /^\s*_\s*=>\s*Err/m,
  );
  const expectedToolAllowlist = [
    "list_meetings",
    "search_meetings",
    "meeting_summary",
    "get_transcript",
    "export_meeting",
    "library_statistics",
  ];
  add(
    "automation:exact-tool-allowlist",
    exactList(toolInvokeAllowlist, expectedToolAllowlist),
    automationService,
    "automation tool dispatch remains on the reviewed read-only allowlist",
  );
  const toolDefinitionMatch = sourceText(input, automationService).match(
    /pub fn tool_definitions\(\) -> Value\s*\{(.*?)\n\}/s,
  );
  const toolDefinitions = toolDefinitionMatch
    ? [...toolDefinitionMatch[1].matchAll(/"name"\s*:\s*"([^"]+)"/g)].map((match) => match[1])
    : [];
  add(
    "automation:exact-tool-definitions",
    exactList(toolDefinitions, expectedToolAllowlist),
    automationService,
    "MCP tool definitions exactly match the reviewed read-only dispatch allowlist",
  );
  const cliAllowlist = quotedMatchArms(
    sourceText(input, automationCli),
    /match command\s*\{/,
    /^\s*_\s*=>\s*Err/m,
  );
  add(
    "automation:exact-cli-allowlist",
    exactList(cliAllowlist, ["list", "search", "summary", "transcript", "export", "stats"]),
    automationCli,
    "candorctl exposes only the reviewed read-only commands",
  );
  const cliOptionAllowlist = quotedMatchArms(
    sourceText(input, automationCli),
    /match argument\.as_str\(\)\s*\{/,
    /^\s*_\s*=>\s*return Err/m,
  );
  add(
    "automation:exact-cli-option-allowlist",
    exactList(cliOptionAllowlist, ["--limit", "--cursor", "--format"]),
    automationCli,
    "candorctl accepts no path, destination, command, or generic dispatch option",
  );
  const mcpAllowlist = quotedMatchArms(
    sourceText(input, automationMcp),
    /match method\s*\{/,
    /^\s*_\s*=>\s*write_jsonrpc_error/m,
  );
  add(
    "automation:exact-mcp-allowlist",
    exactList(mcpAllowlist, ["initialize", "ping", "tools/list", "tools/call"]),
    automationMcp,
    "candor-mcp exposes only initialization, health, and fixed tool operations",
  );
  excludes(
    "automation:no-network-dependencies",
    automationCargo,
    networkDependencyPattern,
    "automation companions have no network client, server, or socket dependency",
  );
  excludes(
    "automation:no-network-dependencies-locked",
    automationCargoLock,
    lockedNetworkDependencyPattern,
    "automation companion lockfile contains no network client, server, or socket package",
  );
  add(
    "automation:no-network-apis",
    !/\b(?:TcpListener|TcpStream|UdpSocket|ToSocketAddrs)\b|\bstd::net\b|\btokio::net\b|\bhyper::Server\b|\baxum::serve\b/.test(automationRust),
    "crates/candor-tools/src",
    "automation companion source opens no network listener or socket",
  );
  add(
    "automation:no-webhook-surface",
    !/\bwebhooks?\b/i.test(automationRust),
    "crates/candor-tools/src",
    "automation companion source exposes no webhook surface",
  );
  add(
    "automation:no-path-or-key-exposure-enabled",
    !/raw_path_exposed\s*:\s*true|key_material_exposed_to_renderer\s*:\s*true|"rawPathExposed"\s*:\s*true|"keyMaterialExposedToRenderer"\s*:\s*true/.test(automationRust),
    "crates/candor-tools/src",
    "automation responses never enable raw path or key material exposure",
  );
  add(
    "automation:no-raw-path-output-fields",
    !/"(?!rawPathExposed")[^"]*(?:Path|path)[^"]*"\s*:/.test(automationProductionRust),
    "crates/candor-tools/src",
    "automation production responses define no raw, local, source, or destination path field",
  );
  includes(
    "automation:export-destination-fixed",
    automationService,
    '"destination": "stdout-only"',
    "the only export destination is the caller-controlled stdout stream",
  );
  includes(
    "automation:sanitized-meeting-output",
    automationService,
    "fn sanitize_summary(value: &Value) -> Option<Value>",
    "meeting metadata is reconstructed through a fixed output allowlist",
  );
  includes(
    "automation:sanitized-transcript-output",
    automationService,
    "fn sanitize_segment(value: &Value) -> Option<Value>",
    "transcript segments are reconstructed through a fixed output allowlist",
  );
  includes(
    "automation:unknown-tool-denied",
    automationService,
    'ToolError::denied("Tool is not on the read-only allowlist")',
    "unknown automation tools are denied",
  );
  includes(
    "automation:mcp-unknown-method-denied",
    automationMcp,
    '"Method is not on the MCP allowlist"',
    "unknown MCP methods are denied",
  );
  includes(
    "automation:stdout-only-export",
    automationCli,
    "never accepts a filesystem destination",
    "CLI export is content-only and never accepts an arbitrary destination path",
  );
  includes(
    "automation:documented-stdio-boundary",
    automationDocs,
    "MCP JSON-RPC on stdin and stdout",
    "automation documentation fixes MCP transport to local stdio",
  );
  includes(
    "automation:documented-no-network-boundary",
    automationDocs,
    "never open a TCP listener, create a socket, make an outbound request, accept a webhook",
    "automation documentation explicitly prohibits listeners, sockets, outbound requests, and webhooks",
  );

  const backgroundTask = "electron/core/background-task.ts";
  includes(
    "tasks:typed-states",
    backgroundTask,
    '"paused",',
    "background tasks include the complete typed lifecycle",
  );
  includes(
    "tasks:canonical-boundary",
    backgroundTask,
    "parseBackgroundTaskCollection",
    "background task collections are canonicalized before renderer use",
  );

  const dictionaryStaging = "crates/candor-core/src/dictionary_staging.rs";
  includes(
    "dictionary:encrypted-staging",
    dictionaryStaging,
    "ChaCha20Poly1305",
    "dictionary archives use a separate authenticated encrypted staging area",
  );
  includes(
    "dictionary:staging-containment",
    dictionaryStaging,
    "canonical_path.starts_with(&canonical_root)",
    "staged dictionary packages are rechecked for path containment",
  );
  includes(
    "dictionary:staging-symlink-rejection",
    dictionaryStaging,
    "metadata.file_type().is_symlink()",
    "staged dictionary packages reject symbolic links",
  );
  const jobManager = "crates/candor-core/src/job_manager.rs";
  includes(
    "dictionary:persist-token-not-archive",
    jobManager,
    "staging_token: String",
    "new dictionary job descriptors persist a random staging token",
  );
  excludes(
    "dictionary:no-new-base64-descriptor",
    jobManager,
    /\barchive_base64\s*:\s*String\b/,
    "new job descriptors never persist a full Base64 dictionary archive",
  );

  const bundleVerifier = "scripts/spec3-verify-ai-bundle.mjs";
  includes(
    "bundle:publisher-key-required",
    bundleVerifier,
    '["terminology", "public-key"]',
    "strict AI release verification requires the Candor dictionary publisher key",
  );
  includes(
    "bundle:publisher-key-rotation-generation",
    bundleVerifier,
    "rotationGeneration",
    "dictionary publisher trust anchors carry an enforced rotation generation",
  );
  const modelLock = "third_party/model-lock.json";
  includes(
    "bundle:profile-key-policy",
    modelLock,
    '"requiresDictionaryPublisherKey": true',
    "every shipping model profile requires the dictionary publisher key",
  );
  const publicationGate = "scripts/spec6-release-publication-gate.mjs";
  includes(
    "release:github-asset-limit",
    publicationGate,
    "2 * 1024 * 1024 * 1024",
    "release publication blocks assets above GitHub's 2 GiB limit",
  );
  includes(
    "release:model-weights-ignored",
    ".gitignore",
    "build/ai-bundle/",
    "acquired model weights remain outside Git",
  );
  includes(
    "release:publisher-private-keys-ignored",
    ".gitignore",
    "third_party/private-keys/",
    "publisher private-key material remains outside Git",
  );
  includes(
    "release:no-web-installer-policy",
    publicationGate,
    'windowsTargets.includes("nsis-web")',
    "release publication explicitly rejects NSIS web installers",
  );

  const importer = "crates/candor-core/src/v2_importer.rs";
  includes("importer:canonical-source", importer, "fs::canonicalize", "v2 source is canonicalized");
  includes("importer:path-contained", importer, "canonical.starts_with(source_root)", "v2 audio stays within selected source");
  includes("importer:originals-untouched", importer, '"originalsUntouched": true', "v2 originals remain untouched");

  add(
    "environment:no-tracked-env-files",
    input.trackedEnvironmentFiles.length === 0,
    null,
    "environment files are not tracked",
  );
  const ignored = new Set(input.ignoredEnvironmentFiles);
  for (const expected of [".env", ".env.local"]) {
    add(`environment:ignored:${expected}`, ignored.has(expected), expected, `${expected} is gitignored`);
  }

  const secretPatterns = [
    ["pem-private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
    ["provider-api-key", /\b(?:sk-(?:live|prod)-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16})\b/g],
    [
      "assigned-secret",
      /\b(?:apiKey|clientSecret|accessToken|refreshToken|privateKey)\s*[:=]\s*["'`][^"'`\r\n]{12,}["'`]/gi,
    ],
  ];
  const secretFindings = [];
  const automationReviewPaths = requiredSourcePaths.filter((sourcePath) =>
    sourcePath.startsWith("crates/candor-tools/") || sourcePath === "docs/mcp-server.md"
  );
  for (const sourcePath of new Set([...input.trackedActivePaths, ...automationReviewPaths])) {
    const content = sourceText(input, sourcePath);
    for (const [kind, pattern] of secretPatterns) {
      for (const match of content.matchAll(pattern)) {
        secretFindings.push({
          file: sourcePath,
          kind,
          line: content.slice(0, match.index).split(/\r?\n/).length,
        });
      }
    }
  }
  add(
    "active-source:no-hardcoded-secrets",
    secretFindings.length === 0,
    null,
    secretFindings.length === 0 ? "no hardcoded secret patterns" : JSON.stringify(secretFindings),
  );

  const failures = checks.filter((check) => !check.ok);
  return { ok: failures.length === 0, checks, failures };
}

function withSource(input, sourcePath, value) {
  return { ...input, sources: { ...input.sources, [sourcePath]: value } };
}

export function runSourceSecuritySelfTest(input) {
  const main = sourceText(input, "electron/main.ts");
  const mainWindow = sourceText(input, "electron/window/create-main-window.ts");
  const networkPolicy = sourceText(input, "electron/security/network-policy.ts");
  const preload = sourceText(input, "electron/preload.cts");
  const coreIpc = sourceText(input, "electron/ipc/core-ipc.ts");
  const jobsIpc = sourceText(input, "electron/ipc/jobs-ipc.ts");
  const importer = sourceText(input, "crates/candor-core/src/v2_importer.rs");
  const proofScript = sourceText(input, "scripts/m0-packaged-smoke.mjs");
  const dictionaryStaging = sourceText(input, "crates/candor-core/src/dictionary_staging.rs");
  const publicationGate = sourceText(input, "scripts/spec6-release-publication-gate.mjs");
  const coreCargo = sourceText(input, "crates/candor-core/Cargo.toml");
  const coreCargoLock = sourceText(input, "crates/candor-core/Cargo.lock");
  const coreMainSource = sourceText(input, "crates/candor-core/src/main.rs");
  const packageSource = sourceText(input, "package.json");
  const automationCargo = sourceText(input, "crates/candor-tools/Cargo.toml");
  const automationCargoLock = sourceText(input, "crates/candor-tools/Cargo.lock");
  const automationCoreClient = sourceText(input, "crates/candor-tools/src/core_client.rs");
  const automationService = sourceText(input, "crates/candor-tools/src/service.rs");
  const automationMcp = sourceText(input, "crates/candor-tools/src/mcp.rs");
  const testSecretName = ["api", "Key"].join("");
  const testSecret = ["sk", "prod", "1234567890abcdefgh"].join("-");
  const cases = [
    {
      name: "missing-required-source",
      input: withSource(input, "electron/main.ts", null),
      expectedFailure: "required-source:electron/main.ts",
    },
    {
      name: "sandbox-disabled",
      input: withSource(
        input,
        "electron/window/create-main-window.ts",
        mainWindow.replace("sandbox: true", "sandbox: false"),
      ),
      expectedFailure: "electron-main:sandbox",
    },
    {
      name: "permission-request-allowed",
      input: withSource(
        input,
        "electron/security/network-policy.ts",
        networkPolicy.replace("callback(false);", "callback(true);"),
      ),
      expectedFailure: "electron-main:permission-request-false",
    },
    {
      name: "generic-preload-capability",
      input: withSource(input, "electron/preload.cts", `${preload}\nconst unsafe = { readFile: () => null };\n`),
      expectedFailure: "preload:no-generic-capabilities",
    },
    {
      name: "renderer-dictionary-archive-bytes",
      input: withSource(
        input,
        "electron/preload.cts",
        `${preload}\nconst unsafeDictionary = { importDictionaryPackage: (_archiveBytes) => null };\n`,
      ),
      expectedFailure: "preload:no-dictionary-archive-bytes",
    },
    {
      name: "generic-core-channel",
      input: withSource(
        input,
        "electron/ipc/core-ipc.ts",
        `${coreIpc}\nipcMain.handle("candor-core:call", () => null);\n`,
      ),
      expectedFailure: "electron-main:no-generic-core-channel",
    },
    {
      name: "unvalidated-background-task-event",
      input: withSource(
        input,
        "electron/ipc/jobs-ipc.ts",
        jobsIpc.replace("parseBackgroundTask(coreEvent.payload)", "coreEvent.payload"),
      ),
      expectedFailure: "electron-main:jobs-event-validation",
    },
    {
      name: "hardcoded-secret",
      input: withSource(
        input,
        "scripts/m0-packaged-smoke.mjs",
        `${proofScript}\nconst ${testSecretName} = "${testSecret}";\n`,
      ),
      expectedFailure: "active-source:no-hardcoded-secrets",
    },
    {
      name: "importer-mutates-originals",
      input: withSource(
        input,
        "crates/candor-core/src/v2_importer.rs",
        importer.replaceAll('"originalsUntouched": true', '"originalsUntouched": false'),
      ),
      expectedFailure: "importer:originals-untouched",
    },
    {
      name: "dictionary-staging-loses-encryption",
      input: withSource(
        input,
        "crates/candor-core/src/dictionary_staging.rs",
        dictionaryStaging.replaceAll("ChaCha20Poly1305", "PlaintextDictionaryArchive"),
      ),
      expectedFailure: "dictionary:encrypted-staging",
    },
    {
      name: "release-size-limit-removed",
      input: withSource(
        input,
        "scripts/spec6-release-publication-gate.mjs",
        publicationGate.replace("2 * 1024 * 1024 * 1024", "Number.MAX_SAFE_INTEGER"),
      ),
      expectedFailure: "release:github-asset-limit",
    },
    {
      name: "electron-node-network-import-added",
      input: withSource(
        input,
        "electron/main.ts",
        `${main}\nimport { request as unsafeRequest } from "node:https";\n`,
      ),
      expectedFailure: "electron-runtime:no-node-network-imports",
    },
    {
      name: "model-acquisition-raw-tls-added",
      input: withSource(
        input,
        "electron/models/model-acquisition-service.ts",
        `${sourceText(input, "electron/models/model-acquisition-service.ts")}\nimport { connect as unsafeTlsConnect } from "node:tls";\n`,
      ),
      expectedFailure: "model-acquisition:https-only",
    },
    {
      name: "electron-renderer-fetch-added",
      input: withSource(
        input,
        "v3/renderer/src/candor-api.d.ts",
        `${sourceText(input, "v3/renderer/src/candor-api.d.ts")}\nconst unsafeFetch = () => fetch("https://example.invalid");\n`,
      ),
      expectedFailure: "electron-runtime:no-network-calls",
    },
    {
      name: "electron-net-aliased-import-call-added",
      input: withSource(
        input,
        "electron/main.ts",
        `${main}\nimport { net as electronNet } from "electron";\nelectronNet.request("https://example.invalid");\n`,
      ),
      expectedFailure: "electron-runtime:no-network-calls",
    },
    {
      name: "electron-net-commonjs-member-alias-added",
      input: withSource(
        input,
        "electron/main.ts",
        `${main}\nconst electronNet = require("electron").net;\nelectronNet.request("https://example.invalid");\n`,
      ),
      expectedFailure: "electron-runtime:no-network-calls",
    },
    {
      name: "electron-net-dynamic-import-member-alias-added",
      input: withSource(
        input,
        "electron/main.ts",
        `${main}\nconst electronNet = (await import("electron")).net;\nelectronNet.request("https://example.invalid");\n`,
      ),
      expectedFailure: "electron-runtime:no-network-calls",
    },
    {
      name: "electron-network-dependency-added",
      input: withSource(
        input,
        "package.json",
        packageSource.replace('"dependencies": {', '"dependencies": {\n    "axios": "1.0.0",'),
      ),
      expectedFailure: "electron-runtime:no-network-dependencies",
    },
    {
      name: "core-network-dependency-added",
      input: withSource(
        input,
        "crates/candor-core/Cargo.toml",
        `${coreCargo}\nreqwest = "0.12"\n`,
      ),
      expectedFailure: "core:no-network-client-dependency",
    },
    {
      name: "core-network-dependency-locked",
      input: withSource(
        input,
        "crates/candor-core/Cargo.lock",
        `${coreCargoLock}\n[[package]]\nname = "reqwest"\nversion = "0.12.0"\n`,
      ),
      expectedFailure: "core:no-network-client-dependency-locked",
    },
    {
      name: "core-std-net-path-added",
      input: withSource(
        input,
        "crates/candor-core/src/main.rs",
        `${coreMainSource}\nfn unsafe_network_path() { let _ = std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST); }\n`,
      ),
      expectedFailure: "core:no-network-apis",
    },
    {
      name: "core-tcp-stream-added",
      input: withSource(
        input,
        "crates/candor-core/src/main.rs",
        `${coreMainSource}\nfn unsafe_tcp_stream(stream: TcpStream) { drop(stream); }\n`,
      ),
      expectedFailure: "core:no-network-apis",
    },
    {
      name: "core-udp-socket-added",
      input: withSource(
        input,
        "crates/candor-core/src/main.rs",
        `${coreMainSource}\nfn unsafe_udp_socket(socket: UdpSocket) { drop(socket); }\n`,
      ),
      expectedFailure: "core:no-network-apis",
    },
    {
      name: "core-address-resolution-added",
      input: withSource(
        input,
        "crates/candor-core/src/main.rs",
        `${coreMainSource}\nfn unsafe_address_resolution<T: ToSocketAddrs>(_target: T) {}\n`,
      ),
      expectedFailure: "core:no-network-apis",
    },
    {
      name: "core-network-names-in-comments-ignored",
      input: withSource(
        input,
        "crates/candor-core/src/main.rs",
        `// std::net::TcpStream UdpSocket ToSocketAddrs\n/* TcpListener and tokio::net are prohibited here. */\n${coreMainSource}`,
      ),
      expectedSuccess: true,
    },
    {
      name: "core-network-names-in-tests-ignored",
      input: withSource(
        input,
        "crates/candor-core/src/main.rs",
        `${coreMainSource}\n#[cfg(test)]\nfn network_name_fixture(_tcp: TcpStream, _udp: UdpSocket, _target: impl ToSocketAddrs) {}\n`,
      ),
      expectedSuccess: true,
    },
    {
      name: "automation-network-dependency-added",
      input: withSource(
        input,
        "crates/candor-tools/Cargo.toml",
        `${automationCargo}\nreqwest = "0.12"\n`,
      ),
      expectedFailure: "automation:no-network-dependencies",
    },
    {
      name: "automation-network-dependency-locked",
      input: withSource(
        input,
        "crates/candor-tools/Cargo.lock",
        `${automationCargoLock}\n[[package]]\nname = "reqwest"\nversion = "0.12.0"\n`,
      ),
      expectedFailure: "automation:no-network-dependencies-locked",
    },
    {
      name: "automation-network-listener-added",
      input: withSource(
        input,
        "crates/candor-tools/src/core_client.rs",
        `${automationCoreClient}\nfn unsafe_listener() { let _ = std::net::TcpListener::bind("127.0.0.1:0"); }\n`,
      ),
      expectedFailure: "automation:no-network-apis",
    },
    {
      name: "automation-webhook-added",
      input: withSource(
        input,
        "crates/candor-tools/src/service.rs",
        `${automationService}\nfn webhook() {}\n`,
      ),
      expectedFailure: "automation:no-webhook-surface",
    },
    {
      name: "automation-mutating-core-method-added",
      input: withSource(
        input,
        "crates/candor-tools/src/core_client.rs",
        automationCoreClient.replace(
          '    "recording.durable.transcriptPage",',
          '    "recording.durable.transcriptPage",\n    "recording.delete",',
        ),
      ),
      expectedFailure: "automation:exact-core-allowlist",
    },
    {
      name: "automation-tool-allowlist-drift",
      input: withSource(
        input,
        "crates/candor-tools/src/service.rs",
        automationService.replace(
          '            "library_statistics" => self.library_statistics(arguments),',
          '            "library_statistics" => self.library_statistics(arguments),\n            "delete_meeting" => self.library_statistics(arguments),',
        ),
      ),
      expectedFailure: "automation:exact-tool-allowlist",
    },
    {
      name: "automation-tool-definition-drift",
      input: withSource(
        input,
        "crates/candor-tools/src/service.rs",
        automationService.replace('"name": "library_statistics"', '"name": "delete_meeting"'),
      ),
      expectedFailure: "automation:exact-tool-definitions",
    },
    {
      name: "automation-cli-path-option-added",
      input: withSource(
        input,
        "crates/candor-tools/src/cli.rs",
        sourceText(input, "crates/candor-tools/src/cli.rs").replace(
          '            "--format" => ("format", "string"),',
          '            "--format" => ("format", "string"),\n            "--destination" => ("destination", "string"),',
        ),
      ),
      expectedFailure: "automation:exact-cli-option-allowlist",
    },
    {
      name: "automation-mcp-allowlist-drift",
      input: withSource(
        input,
        "crates/candor-tools/src/mcp.rs",
        automationMcp.replace(
          '            _ => write_jsonrpc_error(writer, id, -32601, "Method is not on the MCP allowlist")?,',
          '            "resources/read" => write_jsonrpc_result(writer, id, json!({}))?,\n            _ => write_jsonrpc_error(writer, id, -32601, "Method is not on the MCP allowlist")?,',
        ),
      ),
      expectedFailure: "automation:exact-mcp-allowlist",
    },
    {
      name: "automation-raw-path-exposure-enabled",
      input: withSource(
        input,
        "crates/candor-tools/src/service.rs",
        automationService.replace("raw_path_exposed: false", "raw_path_exposed: true"),
      ),
      expectedFailure: "automation:no-path-or-key-exposure-enabled",
    },
    {
      name: "automation-raw-path-output-field-added",
      input: withSource(
        input,
        "crates/candor-tools/src/service.rs",
        automationService.replace(
          '        "rawPathExposed": false,',
          '        "rawPath": "C:/unsafe",\n        "rawPathExposed": false,',
        ),
      ),
      expectedFailure: "automation:no-raw-path-output-fields",
    },
  ];

  const results = cases.map((testCase) => {
    const result = evaluateSourceSecurity(testCase.input);
    const expectsSuccess = testCase.expectedSuccess === true;
    return {
      name: testCase.name,
      ok: expectsSuccess
        ? result.ok
        : !result.ok && result.failures.some((failure) => failure.id === testCase.expectedFailure),
      expectedFailure: expectsSuccess ? "no source-security failure" : testCase.expectedFailure,
      observedFailures: result.failures.map((failure) => failure.id),
    };
  });
  return { ok: results.every((result) => result.ok), results };
}
