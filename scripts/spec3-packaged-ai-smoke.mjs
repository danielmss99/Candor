import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { removeTemporaryDirectory, stopChildProcess } from "./child-process-cleanup.mjs";
import { createVersionedCoreRequest } from "./core-rpc-envelope.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseRoot = path.join(repoRoot, "release-v3");
const resourcesArgument = process.argv.indexOf("--resources");
const defaultResourcesRoots = process.platform === "win32"
  ? [path.join(releaseRoot, "win-unpacked", "resources")]
  : process.platform === "darwin"
    ? [
        path.join(releaseRoot, "mac", "Candor.app", "Contents", "Resources"),
        path.join(releaseRoot, "mac-arm64", "Candor.app", "Contents", "Resources"),
        path.join(releaseRoot, "mac", "Candor Source Interface.app", "Contents", "Resources"),
        path.join(releaseRoot, "mac-arm64", "Candor Source Interface.app", "Contents", "Resources"),
      ]
    : [path.join(releaseRoot, "linux-unpacked", "resources")];
const resourcesRoot = resourcesArgument >= 0
  ? path.resolve(process.argv[resourcesArgument + 1] ?? "")
  : defaultResourcesRoots.find((candidate) => existsSync(candidate)) ?? defaultResourcesRoots[0];
const bundleRoot = path.join(resourcesRoot, "ai");
const manifestPath = path.join(bundleRoot, "manifest.json");
const sourceManifestPath = path.join(repoRoot, "build", "ai-bundle", "manifest.json");
const coreName = process.platform === "win32" ? "candor-core.exe" : "candor-core";
const corePath = path.join(resourcesRoot, "bin", coreName);
const asarPath = path.join(resourcesRoot, "app.asar");
const proofDir = path.join(releaseRoot, "proofs");
const proofPath = path.join(
  proofDir,
  `spec3-packaged-ai-smoke-${process.platform}-${process.arch}.json`,
);
const testDataRoot = mkdtempSync(path.join(tmpdir(), "candor-spec3-packaged-smoke-"));

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function relative(filePath) {
  return path.relative(repoRoot, filePath).replaceAll("\\", "/");
}

for (const requiredPath of [resourcesRoot, bundleRoot, manifestPath, sourceManifestPath, corePath, asarPath]) {
  if (!existsSync(requiredPath)) throw new Error(`required packaged artifact is missing: ${relative(requiredPath)}`);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const child = spawn(corePath, [], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
  env: {
    ...process.env,
    CANDOR_CORE_TRANSPORT: "stdio-json-lines",
    CANDOR_AI_BUNDLE_ROOT: bundleRoot,
    CANDOR_V3_DATA_DIR: testDataRoot,
  },
});
const lines = createInterface({ input: child.stdout });
const pending = new Map();
let stderrBytes = 0;

child.stderr.on("data", (chunk) => {
  stderrBytes += chunk.length;
  if (stderrBytes > 1024 * 1024) child.kill();
});

lines.on("line", (line) => {
  let response;
  try { response = JSON.parse(line); }
  catch { return; }
  const waiter = pending.get(response.requestId ?? response.id);
  if (!waiter) return;
  pending.delete(response.requestId ?? response.id);
  clearTimeout(waiter.timeout);
  if (response.ok) waiter.resolve(response.result);
  else waiter.reject(new Error(`${response.error?.code ?? "CORE_ERROR"}: ${response.error?.message ?? "request failed"}`));
});

function call(method, params = null) {
  const request = createVersionedCoreRequest(method, params);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(request.requestId);
      reject(new Error(`timeout waiting for ${method}`));
    }, 10_000);
    pending.set(request.requestId, { resolve, reject, timeout });
    child.stdin.write(`${JSON.stringify(request)}\n`);
  });
}

let proof;
try {
  const version = await call("core.version");
  const bundled = await call("ai.bundledAssetsStatus");
  const recordings = await call("recording.durable.list");
  const serializedStatus = JSON.stringify(bundled);
  if (bundled.releaseReady !== (manifest.releaseReady === true)) {
    throw new Error("packaged runtime readiness does not match the manifest");
  }
  if (bundled.fixture !== false) throw new Error("packaged runtime accepted a fixture bundle");
  if (bundled.requiredDownload !== false || bundled.backgroundDownloads !== false) {
    throw new Error("packaged runtime reported an AI download path");
  }
  if (bundled.rawPathExposed !== false || bundled.hashExposed !== false) {
    throw new Error("packaged runtime exposed an AI path or hash");
  }
  if (serializedStatus.includes(bundleRoot) || /[A-Z]:\\/i.test(serializedStatus)) {
    throw new Error("packaged runtime serialized a complete filesystem path");
  }
  if (recordings.rawPathExposed !== false || !Array.isArray(recordings.recordings)) {
    throw new Error("meeting library was unavailable while bundled AI was not ready");
  }
  if (sha256(manifestPath) !== sha256(sourceManifestPath)) {
    throw new Error("packaged AI manifest differs from the verified source manifest");
  }
  proof = {
    proofKind: "spec3-packaged-ai-smoke",
    generatedAt: new Date().toISOString(),
    ok: true,
    platform: process.platform,
    arch: process.arch,
    resourcesRoot: relative(resourcesRoot),
    bundleRoot: relative(bundleRoot),
    outsideAsar: true,
    manifestSha256: sha256(manifestPath),
    manifestReleaseReady: manifest.releaseReady === true,
    runtimeState: bundled.state,
    runtimeReady: bundled.ready,
    repairRequired: bundled.repairRequired,
    requiredDownload: bundled.requiredDownload,
    backgroundDownloads: bundled.backgroundDownloads,
    meetingLibraryAccessible: true,
    protocolVersion: version.protocolVersion,
    stderrBytes,
    networkAttempted: false,
    rawPathExposed: false,
  };
  await call("core.shutdown");
} finally {
  lines.close();
  if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
  await stopChildProcess(child);
  removeTemporaryDirectory(testDataRoot);
}

mkdirSync(proofDir, { recursive: true });
writeFileSync(proofPath, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
console.log(`SPEC-3 packaged AI smoke passed: ${relative(proofPath)}`);
