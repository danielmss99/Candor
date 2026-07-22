import { createVersionedCoreRequest } from "./core-rpc-envelope.mjs";
import { removeTemporaryDirectory, stopChildProcess } from "./child-process-cleanup.mjs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdtempSync } from "node:fs";
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

const dataDir = mkdtempSync(path.join(tmpdir(), "candor-v3-m1-consent-"));

function startCore() {
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
    const request = createVersionedCoreRequest(method, params);
    const id = request.requestId;
    const payload = JSON.stringify(request);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, 8000);
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

  return { child, lines, call };
}

async function stopRuntime(runtime) {
  if (!runtime) return;
  runtime.lines.close();
  if (!runtime.child.stdin.destroyed && !runtime.child.stdin.writableEnded) {
    runtime.child.stdin.end();
  }
  await stopChildProcess(runtime.child);
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

let runtime = null;

try {
  runtime = startCore();
  const before = await runtime.call("consent.status");
  assertCustody(before, "initial consent status");
  if (before?.readyForMicRecording !== false || before?.readyForSystemAudioRecording !== false) {
    throw new Error("new consent store should not be ready before acknowledgement");
  }
  if (!Array.isArray(before?.items) || before.items.length < 3) {
    throw new Error("consent status did not return the required consent items");
  }

  try {
    await runtime.call("capture.startMic", { label: "must be denied before consent" });
    throw new Error("mic capture started before consent");
  } catch (error) {
    if (error.code !== "CONSENT_REQUIRED") throw error;
  }

  const afterMic = await runtime.call("consent.acknowledge", {
    items: ["localOnlyStorage", "micRecording"],
  });
  assertCustody(afterMic, "mic consent acknowledgement");
  if (afterMic?.readyForMicRecording !== true) {
    throw new Error("mic consent acknowledgement did not unlock mic recording");
  }
  if (afterMic?.readyForSystemAudioRecording !== false) {
    throw new Error("mic consent must not imply system audio consent");
  }

  try {
    await runtime.call("consent.acknowledge", { items: ["rawFilesystemAccess"] });
    throw new Error("unknown consent item was accepted");
  } catch (error) {
    if (error.code !== "CONSENT_ITEM_UNKNOWN") throw error;
  }

  await runtime.call("core.shutdown");
  await stopRuntime(runtime);
  runtime = null;

  runtime = startCore();
  const reopened = await runtime.call("consent.status");
  assertCustody(reopened, "reopened consent status");
  if (reopened?.readyForMicRecording !== true) {
    throw new Error("consent acknowledgement did not persist locally");
  }

  await runtime.call("core.shutdown");
  console.log("M1 consent smoke passed.");
} finally {
  await stopRuntime(runtime);
  removeTemporaryDirectory(dataDir);
}
