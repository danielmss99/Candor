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

function waitForExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`candor-core did not exit within ${timeoutMs} ms.`));
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function spawnCore(dataDir) {
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

  child.once("exit", (code, signal) => {
    const error = new Error(`candor-core exited (${code ?? signal ?? "unknown"})`);
    for (const entry of pending.values()) {
      clearTimeout(entry.timeout);
      entry.reject(error);
    }
    pending.clear();
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
        timeout,
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

  async function shutdown() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      await call("core.shutdown");
    } catch {
      child.kill("SIGKILL");
    }
    await waitForExit(child);
  }

  async function crash() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGKILL");
    await waitForExit(child);
  }

  return { child, call, shutdown, crash };
}

function assertCustody(value, label, dataDir) {
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

const dataDir = mkdtempSync(path.join(tmpdir(), "candor-v3-capture-crash-"));
let writer = null;
let recovery = null;

try {
  writer = spawnCore(dataDir);
  const proof = await writer.call("capture.proofInterruptedSerializedWriter");
  assertCustody(proof, "capture interrupted proof", dataDir);
  const recordingId = proof?.recordingId;
  if (!recordingId) throw new Error("interrupted capture proof did not return a recording id");
  if (
    proof?.proof?.leftOpenForStartupRecovery !== true ||
    proof?.proof?.serializedWriter !== true ||
    proof?.proof?.micSystemSeparated !== true ||
    proof?.replay?.audioChunkCount !== 8 ||
    proof?.replay?.durationMs !== 400 ||
    !proof?.replay?.tracks?.includes("mic") ||
    !proof?.replay?.tracks?.includes("system")
  ) {
    throw new Error("interrupted capture proof did not create separated durable audio chunks");
  }

  await writer.crash();
  writer = null;

  recovery = spawnCore(dataDir);
  const recoveryStatus = await recovery.call("core.status");
  assertCustody(recoveryStatus, "capture startup recovery status", dataDir);
  if (recoveryStatus?.startupRecovery?.ok !== true) {
    throw new Error("startup recovery did not report success after interrupted capture crash");
  }
  if (recoveryStatus?.startupRecovery?.recoveredCount !== 1) {
    throw new Error(
      `expected one recovered interrupted capture, got ${recoveryStatus?.startupRecovery?.recoveredCount}`,
    );
  }

  const list = await recovery.call("recording.durable.list");
  assertCustody(list, "capture startup recovery list", dataDir);
  const recovered = list?.recordings?.find((recording) => recording?.recordingId === recordingId);
  if (!recovered) {
    throw new Error("startup-recovered capture recording was not present in the library");
  }
  if (recovered?.state !== "needsRecovery") {
    throw new Error("interrupted capture recording was not marked needsRecovery");
  }
  if (recovered?.audioChunkCount !== 8 || recovered?.audioDurationMs !== 400) {
    throw new Error("startup recovery did not preserve interrupted capture audio chunks");
  }
  if (process.platform === "win32" && recovered?.encryptedAtRest !== true) {
    throw new Error("Windows interrupted capture recovery did not preserve encrypted audio custody");
  }

  const replay = await recovery.call("recording.durable.replayManifest", { recordingId });
  assertCustody(replay, "capture startup recovery replay", dataDir);
  if (
    replay?.audioChunkCount !== 8 ||
    replay?.durationMs !== 400 ||
    !replay?.tracks?.includes("mic") ||
    !replay?.tracks?.includes("system")
  ) {
    throw new Error("startup recovery replay did not preserve separated capture tracks");
  }

  await recovery.shutdown();
  recovery = null;
  console.log("M1 capture crash recovery smoke passed.");
} finally {
  if (writer) await writer.crash().catch(() => null);
  if (recovery) await recovery.shutdown().catch(() => null);
  rmSync(dataDir, { recursive: true, force: true });
}
