import { createVersionedCoreRequest } from "./core-rpc-envelope.mjs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
const proofDir = path.join(repoRoot, "release-v3", "proofs");
const proofPath = path.join(
  proofDir,
  `m4-instruct-asset-manager-${process.platform}-${process.arch}.json`,
);
const dataDir = mkdtempSync(path.join(tmpdir(), "candor-v3-m4-instruct-assets-data-"));
const sourceDir = mkdtempSync(path.join(tmpdir(), "candor-v3-m4-instruct-assets-source-"));
const failures = [];
const observations = [];
let child = null;
let initialStatus = null;
let runnerImport = null;
let modelImport = null;
let assetStatus = null;
let instructStatus = null;
let hashMismatchRejected = false;

function fail(message) {
  failures.push(message);
}

function record(condition, message) {
  if (!condition) fail(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function runnerFixture() {
  const bytes = Buffer.alloc(100_000);
  if (process.platform === "win32") {
    bytes.write("MZ", 0, "ascii");
    bytes.writeUInt32LE(0x80, 0x3c);
    bytes.write("PE\0\0", 0x80, "binary");
  } else if (process.platform === "darwin") {
    Buffer.from([0xfe, 0xed, 0xfa, 0xcf]).copy(bytes, 0);
  } else {
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01]).copy(bytes, 0);
  }
  return bytes;
}

function modelFixture() {
  const bytes = Buffer.alloc(1024 * 1024);
  bytes.write("GGUF", 0, "ascii");
  return bytes;
}

function visitCustody(value, label) {
  if (Array.isArray(value)) {
    for (const item of value) visitCustody(item, label);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, childValue] of Object.entries(value)) {
    if (key === "rawPathExposed" && childValue !== false) {
      fail(`${label} reported raw path exposure`);
    }
    if (key === "sourcePathExposed" && childValue !== false) {
      fail(`${label} reported source path exposure`);
    }
    if (key === "managedPathExposed" && childValue !== false) {
      fail(`${label} reported managed path exposure`);
    }
    if (key === "keyMaterialExposedToRenderer" && childValue !== false) {
      fail(`${label} reported key material exposure`);
    }
    if (key === "rawValuesExposed" && childValue !== false) {
      fail(`${label} reported raw configuration values`);
    }
    visitCustody(childValue, label);
  }
}

function assertPathless(value, label) {
  const serialized = JSON.stringify(value).replaceAll("\\", "/").toLowerCase();
  for (const rawPath of [dataDir, sourceDir].map((value) => value.replaceAll("\\", "/").toLowerCase())) {
    if (serialized.includes(rawPath)) fail(`${label} exposed a local path`);
  }
  visitCustody(value, label);
}

function spawnCore() {
  if (!existsSync(corePath)) {
    throw new Error(`candor-core debug binary not found: ${corePath}`);
  }
  child = spawn(corePath, [], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      CANDOR_V3_DATA_DIR: dataDir,
      CANDOR_LOCAL_LLM_BINARY: "",
      CANDOR_LOCAL_LLM_BINARY_SHA256: "",
      CANDOR_LOCAL_LLM_MODEL: "",
      CANDOR_LOCAL_LLM_MODEL_SHA256: "",
    },
  });
  return child;
}

function makeRpc(childProcess) {
  const lines = createInterface({ input: childProcess.stdout });
  const pending = new Map();

  childProcess.stderr.on("data", (chunk) => {
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
      entry.reject(error);
    }
  });

  return function call(method, params = null) {
    const request = createVersionedCoreRequest(method, params);
    const id = request.requestId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, 30_000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      childProcess.stdin.write(`${JSON.stringify(request)}\n`);
    });
  };
}

function assertImported(value, label, kind) {
  assertPathless(value, label);
  record(value?.imported === true, `${label} did not import`);
  record(value?.assetKind === kind, `${label} returned the wrong asset kind`);
  record(value?.integrityVerified === true, `${label} did not verify integrity`);
  record(value?.localOnly === true, `${label} did not report local-only`);
  record(value?.cloudAi === false, `${label} did not deny cloud AI`);
  record(value?.networkAttempted === false, `${label} attempted network access`);
  record(value?.downloadsAttempted === false, `${label} attempted a download`);
}

function writeProof() {
  const summary = {
    ok: failures.length === 0,
    proofKind: "m4-instruct-asset-manager",
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    synthetic: true,
    executionAttempted: false,
    localOnly: assetStatus?.localOnly === true && instructStatus?.localOnly === true,
    cloudAi: assetStatus?.cloudAi === true || instructStatus?.cloudAi === true,
    managed: assetStatus?.managed === true,
    ready: assetStatus?.ready === true && instructStatus?.ready === true,
    expectedSha256Required: assetStatus?.expectedSha256Required === true,
    runnerVerified: assetStatus?.runner?.verified === true,
    modelVerified: assetStatus?.model?.verified === true,
    binaryHashVerified: instructStatus?.binaryHashVerified === true,
    modelHashVerified: instructStatus?.modelHashVerified === true,
    binaryHashVerificationCached: instructStatus?.binaryHashVerificationCached === true,
    modelHashVerificationCached: instructStatus?.modelHashVerificationCached === true,
    managedConfigurationSource:
      instructStatus?.configuration?.source === "managed-local-assets",
    hashMismatchRejected,
    networkAttempted: assetStatus?.networkAttempted === true,
    downloadsAttempted: assetStatus?.downloadsAttempted === true,
    rawPathExposed: false,
    keyMaterialExposedToRenderer: false,
    observations,
    failures,
    initialStatus,
    runnerImport,
    modelImport,
    assetStatus,
    instructStatus,
  };
  mkdirSync(proofDir, { recursive: true });
  writeFileSync(proofPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

try {
  const runnerBytes = runnerFixture();
  const modelBytes = modelFixture();
  const runnerPath = path.join(sourceDir, process.platform === "win32" ? "llama-cli.exe" : "llama-cli");
  const modelPath = path.join(sourceDir, "model.gguf");
  writeFileSync(runnerPath, runnerBytes);
  writeFileSync(modelPath, modelBytes);

  const core = spawnCore();
  const call = makeRpc(core);
  initialStatus = await call("ai.instructAssetsStatus");
  assertPathless(initialStatus, "initial instruct asset status");
  record(initialStatus?.ready === false, "fresh instruct asset manager unexpectedly reported ready");
  record(initialStatus?.expectedSha256Required === true, "asset manager did not require SHA-256");

  try {
    await call("ai.instructAssetsImportFromPath", {
      assetKind: "model",
      sourcePath: modelPath,
      expectedSha256: "0".repeat(64),
      replace: false,
    });
    fail("asset manager accepted a mismatched model hash");
  } catch (error) {
    hashMismatchRejected = error?.code === "INSTRUCT_ASSET_HASH_MISMATCH";
    record(hashMismatchRejected, "asset manager returned the wrong hash mismatch code");
  }

  runnerImport = await call("ai.instructAssetsImportFromPath", {
    assetKind: "runner",
    sourcePath: runnerPath,
    expectedSha256: sha256(runnerBytes),
    replace: false,
  });
  assertImported(runnerImport, "runner import", "runner");

  modelImport = await call("ai.instructAssetsImportFromPath", {
    assetKind: "model",
    sourcePath: modelPath,
    expectedSha256: sha256(modelBytes),
    replace: false,
  });
  assertImported(modelImport, "model import", "model");

  assetStatus = await call("ai.instructAssetsStatus");
  assertPathless(assetStatus, "managed instruct asset status");
  record(assetStatus?.ready === true, "managed instruct assets were not ready after import");
  record(assetStatus?.runner?.verified === true, "managed runner was not verified");
  record(assetStatus?.model?.verified === true, "managed model was not verified");
  record(assetStatus?.sourcePathAcceptedFromRenderer === false, "asset status accepted renderer paths");
  record(assetStatus?.backgroundDownloads === false, "asset manager allowed background downloads");

  instructStatus = await call("ai.instructStatus");
  assertPathless(instructStatus, "managed local instruct status");
  record(instructStatus?.ready === true, "local instruct runtime did not use managed assets");
  record(instructStatus?.binaryHashVerified === true, "managed binary hash was not verified");
  record(instructStatus?.modelHashVerified === true, "managed model hash was not verified");
  record(
    instructStatus?.configuration?.source === "managed-local-assets",
    "local instruct runtime did not report managed configuration",
  );
  record(
    instructStatus?.configuration?.rawValuesExposed === false,
    "local instruct runtime exposed raw managed configuration",
  );

  const capabilities = await call("core.capabilities");
  record(
    capabilities?.allowedMethods?.includes("ai.instructAssetsStatus"),
    "core capabilities omitted instruct asset status",
  );
  record(
    capabilities?.allowedMethods?.includes("ai.instructAssetsImportFromPath"),
    "core capabilities omitted core-only instruct asset import",
  );

  observations.push("managed runner and GGUF imports were hash-pinned and pathless");
  await call("core.shutdown");
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  if (child && !child.killed) child.kill();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(sourceDir, { recursive: true, force: true });
  writeProof();
}

if (failures.length > 0) {
  console.error(`M4 instruct asset manager smoke failed. Proof written to ${proofPath}.`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`M4 instruct asset manager smoke passed. Proof written to ${proofPath}.`);
