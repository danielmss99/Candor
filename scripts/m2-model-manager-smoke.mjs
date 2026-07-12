import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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

const dataDir = mkdtempSync(path.join(tmpdir(), "candor-v3-m2-models-"));
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

async function expectError(method, params, expectedCode) {
  try {
    await call(method, params);
  } catch (error) {
    if (error.code !== expectedCode) {
      throw new Error(`expected ${expectedCode} from ${method}, got ${error.code ?? "unknown"}`);
    }
    return;
  }
  throw new Error(`expected ${method} to fail with ${expectedCode}`);
}

try {
  const status = await call("models.status");
  assertCustody(status, "model status");
  if (
    status?.localOnly !== true ||
    status?.cloudAi !== false ||
    status?.modelPathAcceptedFromRenderer !== false ||
    status?.manualInstallOnly !== true ||
    status?.manualImportAvailable !== true ||
    status?.backgroundDownloads !== false ||
    status?.defaultModelId !== "base.en" ||
    status?.supportedModelCount < 10
  ) {
    throw new Error("model status did not report the local model custody contract");
  }

  const initialList = await call("models.listLocal");
  assertCustody(initialList, "initial model list");
  if (initialList?.installedModelCount !== 0) {
    throw new Error("isolated model store should start empty");
  }

  const missing = await call("models.verifyLocal", { modelId: "base.en" });
  assertCustody(missing, "missing model verification");
  if (
    missing?.modelId !== "base.en" ||
    missing?.installed !== false ||
    missing?.verified !== false ||
    missing?.failureCode !== "MODEL_NOT_INSTALLED"
  ) {
    throw new Error("missing model verification did not fail closed");
  }

  await expectError("models.verifyLocal", { modelId: "../base.en" }, "MODEL_ID_INVALID");

  const fakeBase = Buffer.from("not a real base.en whisper model");
  const importStart = await call("models.importStart", {
    modelId: "base.en",
    expectedBytes: fakeBase.length,
  });
  assertCustody(importStart, "import start");
  if (
    typeof importStart?.importId !== "string" ||
    importStart?.modelId !== "base.en" ||
    importStart?.chunkBytesMax < fakeBase.length
  ) {
    throw new Error("model import start did not create a pathless import session");
  }
  const importChunk = await call("models.importChunk", {
    importId: importStart.importId,
    dataBase64: fakeBase.toString("base64"),
  });
  assertCustody(importChunk, "import chunk");
  if (importChunk?.bytesWritten !== fakeBase.length || importChunk?.complete !== true) {
    throw new Error("model import chunk did not track streamed bytes");
  }
  const importFinish = await call("models.importFinish", { importId: importStart.importId });
  assertCustody(importFinish, "import finish rejection");
  if (
    importFinish?.imported !== false ||
    importFinish?.rejected !== true ||
    importFinish?.verification?.failureCode !== "MODEL_HASH_MISMATCH"
  ) {
    throw new Error("model import did not reject an invalid hash before install");
  }
  const afterRejectedImport = await call("models.listLocal");
  assertCustody(afterRejectedImport, "list after rejected import");
  if (afterRejectedImport?.models?.some((model) => model.modelId === "base.en")) {
    throw new Error("rejected model import left an installed model behind");
  }

  const abortStart = await call("models.importStart", {
    modelId: "small.en",
    expectedBytes: fakeBase.length,
  });
  assertCustody(abortStart, "abort import start");
  await call("models.importChunk", {
    importId: abortStart.importId,
    dataBase64: fakeBase.toString("base64"),
  });
  const abort = await call("models.importAbort", { importId: abortStart.importId });
  assertCustody(abort, "import abort");
  if (abort?.aborted !== true) {
    throw new Error("model import abort did not report cleanup");
  }
  const abortedVerify = await call("models.verifyLocal", { modelId: "small.en" });
  assertCustody(abortedVerify, "aborted model verification");
  if (abortedVerify?.failureCode !== "MODEL_NOT_INSTALLED") {
    throw new Error("aborted model import left a partial model behind");
  }

  const proof = await call("models.proofSynthetic", { modelId: "tiny.en" });
  assertCustody(proof, "synthetic model proof");
  if (
    proof?.proof?.synthetic !== true ||
    proof?.proof?.tamperedModelBlocked !== true ||
    proof?.verification?.modelId !== "tiny.en" ||
    proof?.verification?.installed !== true ||
    proof?.verification?.verified !== false ||
    proof?.verification?.failureCode !== "MODEL_HASH_MISMATCH" ||
    typeof proof?.verification?.actualSha256 !== "string"
  ) {
    throw new Error("synthetic model proof did not prove hash blocking");
  }

  const localList = await call("models.listLocal");
  assertCustody(localList, "local model list after proof");
  const tiny = localList?.models?.find((model) => model.modelId === "tiny.en");
  if (!tiny || tiny.installed !== true || tiny.verified !== false) {
    throw new Error("local model list did not show the unverified synthetic model");
  }

  const capabilities = await call("core.capabilities");
  assertCustody(capabilities, "capabilities");
  if (!capabilities?.allowedMethods?.includes("models.verifyLocal")) {
    throw new Error("core capabilities did not advertise model verification");
  }

  await call("core.shutdown");
  console.log("M2 model manager smoke passed.");
} finally {
  if (!child.killed) child.kill();
  rmSync(dataDir, { recursive: true, force: true });
}
