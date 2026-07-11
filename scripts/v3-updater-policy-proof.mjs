import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");
const exe = process.platform === "win32" ? "candor-core.exe" : "candor-core";

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function asPath(pathValue) {
  return resolve(repoRoot, pathValue);
}

function rel(pathValue) {
  return relative(repoRoot, pathValue).replaceAll("\\", "/");
}

function read(relativePath) {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

function firstExisting(candidates) {
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function staticCheck(condition, label, failures) {
  if (!condition) failures.push(label);
  return {
    ok: Boolean(condition),
    label,
  };
}

const outputPath = asPath(
  argValue(
    "--write",
    join("release-v3", "proofs", `v3-updater-policy-proof-${process.platform}-${process.arch}.json`),
  ),
);
const corePath = process.argv[2]
  ? resolve(process.argv[2])
  : firstExisting([
      join(repoRoot, "crates", "candor-core", "target", "debug", exe),
      join(repoRoot, "crates", "candor-core", "target", "release", exe),
    ]);

const mainSource = read("electron/main.ts");
const preloadSource = read("electron/preload.cts");
const rendererIndex = read("v3/renderer/index.html");
const updatePolicySource = read("crates/candor-core/src/update_policy.rs");
const failures = [];

const staticChecks = {
  electronBackgroundNetworkingDisabled: staticCheck(
    mainSource.includes("disable-background-networking"),
    "Electron must disable background networking",
    failures,
  ),
  electronComponentUpdaterDisabled: staticCheck(
    mainSource.includes("disable-component-update"),
    "Electron must disable component updates",
    failures,
  ),
  electronAutoUpdaterAbsent: staticCheck(
    !/autoUpdater/.test(mainSource),
    "Electron autoUpdater must be absent",
    failures,
  ),
  electronCrashReporterStartAbsent: staticCheck(
    !/crashReporter\.start/.test(mainSource),
    "Electron crashReporter.start must be absent",
    failures,
  ),
  mainAllowlistExposesStatusOnly: staticCheck(
    mainSource.includes('"updates.status"') && !mainSource.includes('"updates.check"'),
    "Electron main must expose updates.status without updates.check",
    failures,
  ),
  preloadExposesStatusOnly: staticCheck(
    preloadSource.includes("updateStatus") &&
      preloadSource.includes('"updates.status"') &&
      !preloadSource.includes("updateCheck"),
    "Preload must expose updateStatus without updateCheck",
    failures,
  ),
  rendererBlocksConnect: staticCheck(
    rendererIndex.includes("connect-src 'none'"),
    "Renderer CSP must keep connect-src none",
    failures,
  ),
  coreManualOnlyPolicy: staticCheck(
    updatePolicySource.includes('"policy": "manual-check-only"') &&
      updatePolicySource.includes('"backgroundChecks": false') &&
      updatePolicySource.includes('"backgroundDownloads": false') &&
      updatePolicySource.includes('"manualCheckNetworkEnabled": false'),
    "Rust update policy must be manual-check-only with background networking disabled",
    failures,
  ),
};

let child = null;
let liveChecks = null;

if (!existsSync(corePath)) {
  failures.push("candor-core binary is missing for live updater policy proof");
} else {
  child = spawn(corePath, [], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
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
    return new Promise((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        rejectPromise(new Error(`timeout waiting for ${method}`));
      }, 5000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolvePromise(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          rejectPromise(error);
        },
      });
      child.stdin.write(`${payload}\n`);
    });
  }

  try {
    const [status, updates, auditSnapshot] = await Promise.all([
      call("core.status"),
      call("updates.status"),
      call("privacy.auditSnapshot"),
    ]);

    const liveFailures = [];
    const requireLive = (condition, label) => {
      if (!condition) liveFailures.push(label);
      return Boolean(condition);
    };

    liveChecks = {
      coreBinary: rel(corePath),
      status: {
        networkPolicy: status?.networkPolicy ?? null,
        ok: requireLive(status?.networkPolicy === "disabled-by-default", "core status must report disabled network policy"),
      },
      updates: {
        implemented: updates?.implemented === true,
        policy: updates?.policy ?? null,
        backgroundChecks: updates?.backgroundChecks ?? null,
        backgroundDownloads: updates?.backgroundDownloads ?? null,
        startupCheck: updates?.startupCheck ?? null,
        manualCheckImplemented: updates?.manualCheckImplemented ?? null,
        manualCheckNetworkEnabled: updates?.manualCheckNetworkEnabled ?? null,
        pinnedEndpointConfigured: updates?.pinnedEndpointConfigured ?? null,
        attemptedChecks: updates?.attemptedChecks ?? null,
        attemptedDownloads: updates?.attemptedDownloads ?? null,
        userInitiatedOnly: updates?.userInitiatedOnly ?? null,
        networkPolicy: updates?.networkPolicy ?? null,
        rawPathExposed: updates?.rawPathExposed ?? null,
        keyMaterialExposedToRenderer: updates?.keyMaterialExposedToRenderer ?? null,
        ok: [
          requireLive(updates?.implemented === true, "updates.status must be implemented"),
          requireLive(updates?.policy === "manual-check-only", "updates.status policy must be manual-check-only"),
          requireLive(updates?.backgroundChecks === false, "updates.status must disable background checks"),
          requireLive(updates?.backgroundDownloads === false, "updates.status must disable background downloads"),
          requireLive(updates?.startupCheck === false, "updates.status must disable startup checks"),
          requireLive(updates?.manualCheckNetworkEnabled === false, "updates.status must disable manual check networking in M0"),
          requireLive(updates?.pinnedEndpointConfigured === false, "updates.status must not configure a release endpoint in M0"),
          requireLive(updates?.attemptedChecks === 0, "updates.status must report zero attempted checks"),
          requireLive(updates?.attemptedDownloads === 0, "updates.status must report zero attempted downloads"),
          requireLive(updates?.userInitiatedOnly === true, "updates.status must remain user-initiated-only"),
          requireLive(updates?.networkPolicy === "disabled-by-default", "updates.status network policy must be disabled-by-default"),
          requireLive(updates?.rawPathExposed === false, "updates.status must not expose raw paths"),
          requireLive(updates?.keyMaterialExposedToRenderer === false, "updates.status must not expose key material"),
        ].every(Boolean),
      },
      auditSnapshot: {
        externalCallsAttempted: auditSnapshot?.externalCallsAttempted ?? null,
        ok: requireLive(
          auditSnapshot?.externalCallsAttempted === 0,
          "privacy audit must report zero attempted external calls",
        ),
      },
      failures: liveFailures,
    };
    failures.push(...liveFailures);
    await call("core.shutdown");
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
}

const proof = {
  ok: failures.length === 0,
  proofKind: "v3-updater-policy-proof",
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  localOnly: true,
  cloudAi: false,
  networkAttempted: false,
  rawPathExposed: false,
  keyMaterialExposedToRenderer: false,
  staticChecks,
  liveChecks,
  failures,
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
if (child && !child.killed) child.kill();

if (proof.ok) {
  console.log(`V3 updater policy proof passed. Proof written to ${outputPath}.`);
} else {
  console.error(`V3 updater policy proof failed. Proof written to ${outputPath}.`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}
