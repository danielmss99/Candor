import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

export const requiredSourcePaths = [
  "electron/main.ts",
  "electron/preload.cts",
  "electron/core/json.ts",
  "electron/core/core-client.ts",
  "electron/core/core-errors.ts",
  "electron/core/protocol.ts",
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
  "electron/security/validate-sender.ts",
  "electron/smoke/m0-smoke.ts",
  "electron/security/network-policy.ts",
  "electron/window/create-main-window.ts",
  "electron/window/navigation-policy.ts",
  "electron/license-service.ts",
  "scripts/build-release-core.mjs",
  "scripts/electron-dev.mjs",
  "v3/renderer/index.html",
  "v3/renderer/src/candor-api.d.ts",
  "crates/candor-core/Cargo.toml",
  "crates/candor-core/src/main.rs",
  "crates/candor-core/src/v2_importer.rs",
  "electron-builder.v3.yml",
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
  return /^(electron|v3\/renderer\/src|crates\/candor-core\/src|scripts)\//.test(pathValue);
}

export function collectSourceSecurityInput(repoRoot) {
  const normalizedRoot = resolve(repoRoot);
  const trackedActivePaths = runGit(normalizedRoot, [
    "ls-files",
    "--",
    "electron",
    "v3/renderer/src",
    "crates/candor-core/src",
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
  const electronRuntimeSource = Object.entries(input.sources)
    .filter(([sourcePath, content]) =>
      sourcePath.startsWith("electron/") &&
      sourcePath !== "electron/preload.cts" &&
      !sourcePath.endsWith(".test.ts") &&
      typeof content === "string"
    )
    .map(([, content]) => content)
    .join("\n");
  for (const [id, pattern] of [
    ["insecure-content-disabled", "allowRunningInsecureContent: false"],
    ["permission-request-denied", "setPermissionRequestHandler"],
    ["permission-check-denied", "setPermissionCheckHandler"],
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
  add("electron-main:no-shell-open", !/shell\.openExternal\s*\(/.test(electronRuntimeSource), main, "main does not open arbitrary URLs");
  add("electron-main:no-sandbox-flag", !/--no-sandbox|ELECTRON_DISABLE_SANDBOX/.test(electronRuntimeSource), main, "sandbox bypass is absent");

  const preload = "electron/preload.cts";
  for (const [id, pattern] of [
    ["context-bridge", 'contextBridge.exposeInMainWorld("candor"'],
    ["core-frozen", "core: Object.freeze("],
    ["license-frozen", "license: Object.freeze("],
    ["shell-frozen", "shell: Object.freeze("],
    ["named-core-channel", 'ipcRenderer.invoke("candor-core:core-status")'],
    ["durable-status", 'ipcRenderer.invoke("candor-core:recording-durable-status")'],
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
  excludes("preload:no-generic-core-channel", preload, /candor-core:call|\bcallCore\b|\ballowedMethods\b/, "preload uses fixed product channels only");
  add(
    "electron-main:no-generic-core-channel",
    !/candor-core:call/.test(electronRuntimeSource),
    "electron/ipc/core-ipc.ts",
    "main registers fixed product channels only",
  );

  const rendererDeclaration = "v3/renderer/src/candor-api.d.ts";
  includes(
    "renderer-api:durable-status",
    rendererDeclaration,
    "recordingDurableStatus(): Promise<JsonValue>",
    "renderer declaration matches durable status preload operation",
  );
  excludes(
    "renderer-api:no-generic-capabilities",
    rendererDeclaration,
    /\b(?:invoke|readFile|writeFile|runProcess|openPath)\s*\(/,
    "renderer declaration exposes no generic capabilities",
  );

  const rendererHtml = "v3/renderer/index.html";
  for (const directive of [
    "default-src 'self'",
    "script-src 'self'",
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

  const builder = "electron-builder.v3.yml";
  includes("builder:asar", builder, "asar: true", "application source is archived");
  includes("builder:publish-disabled", builder, "publish: null", "automatic publishing is disabled");
  includes("builder:core-resource", builder, "build/core-bin", "staged Rust core is packaged as a resource");

  const coreMain = "crates/candor-core/src/main.rs";
  includes("core:bounded-rpc", coreMain, "MAX_RPC_LINE_BYTES", "Rust core bounds JSONL frames");
  includes("core:stdio-transport", coreMain, '"stdio-json-lines"', "Rust core uses stdio transport");
  includes("core:protocol-version", coreMain, '"protocolVersion"', "Rust core reports protocol version");

  const coreCargo = "crates/candor-core/Cargo.toml";
  excludes(
    "core:no-network-client-dependency",
    coreCargo,
    /^\s*(?:reqwest|hyper|ureq|curl|isahc|surf)\s*=/m,
    "Rust core has no HTTP client dependency",
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
  for (const sourcePath of input.trackedActivePaths) {
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
  const preload = sourceText(input, "electron/preload.cts");
  const coreIpc = sourceText(input, "electron/ipc/core-ipc.ts");
  const importer = sourceText(input, "crates/candor-core/src/v2_importer.rs");
  const proofScript = sourceText(input, "scripts/m0-packaged-smoke.mjs");
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
      name: "generic-preload-capability",
      input: withSource(input, "electron/preload.cts", `${preload}\nconst unsafe = { readFile: () => null };\n`),
      expectedFailure: "preload:no-generic-capabilities",
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
  ];

  const results = cases.map((testCase) => {
    const result = evaluateSourceSecurity(testCase.input);
    return {
      name: testCase.name,
      ok: !result.ok && result.failures.some((failure) => failure.id === testCase.expectedFailure),
      expectedFailure: testCase.expectedFailure,
      observedFailures: result.failures.map((failure) => failure.id),
    };
  });
  return { ok: results.every((result) => result.ok), results };
}
