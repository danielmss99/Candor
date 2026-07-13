import { createVersionedCoreRequest } from "./core-rpc-envelope.mjs";
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
      reject(new Error(`candor-core did not exit within ${timeoutMs} ms`));
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
    const request = createVersionedCoreRequest(method, params);
    const id = request.requestId;
    const payload = JSON.stringify(request);
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

const dataDir = mkdtempSync(path.join(tmpdir(), "candor-v3-crash-recovery-"));
let writer = null;
let recovery = null;

try {
  writer = spawnCore(dataDir);
  const status = await writer.call("recording.durable.status");
  const expectEncryptedChunks = status?.chunkEncryptionAvailable === true;
  if (process.platform === "win32" && !expectEncryptedChunks) {
    throw new Error("Windows crash recovery smoke did not report OS-key chunk encryption");
  }
  const started = await writer.call("recording.durable.start", { label: "crash recovery smoke" });
  const recordingId = started?.recordingId;
  if (!recordingId) throw new Error("recording start did not return an id");

  const written = await writer.call("recording.durable.writeTextChunk", {
    recordingId,
    channel: "mic",
    dataUtf8: "bytes flushed before forced process death",
  });
  if (written?.chunkCount !== 1 || written?.rawPathExposed !== false) {
    throw new Error("durable write did not report one no-path chunk before crash");
  }
  if (expectEncryptedChunks) {
    if (
      written?.encryptedAtRest !== true ||
      written?.encryptedChunkCount !== 1 ||
      !(written?.storedBytes > written?.totalBytes)
    ) {
      throw new Error("durable write did not report encrypted chunk custody before crash");
    }
  }

  await writer.crash();
  writer = null;

  recovery = spawnCore(dataDir);
  const recoveryStatus = await recovery.call("core.status");
  if (recoveryStatus?.startupRecovery?.ok !== true) {
    throw new Error("startup recovery did not report success after crash");
  }
  if (recoveryStatus?.startupRecovery?.recoveredCount !== 1) {
    throw new Error(
      `expected one startup-recovered recording after crash, got ${recoveryStatus?.startupRecovery?.recoveredCount}`,
    );
  }
  if (recoveryStatus?.startupRecovery?.rawPathExposed !== false) {
    throw new Error("startup recovery status exposed a raw path");
  }

  const list = await recovery.call("recording.durable.list");
  if (list?.rawPathExposed !== false) {
    throw new Error("post-startup recovery list exposed a raw path");
  }
  const recoveredRecording = list?.recordings?.find((recording) => recording?.recordingId === recordingId);
  if (!recoveredRecording) {
    throw new Error("startup-recovered recording was not present in the library");
  }
  if (recoveredRecording?.state !== "needsRecovery") {
    throw new Error("crashed recording was not marked needsRecovery");
  }
  if (recoveredRecording?.chunkCount !== 1 || recoveredRecording?.totalBytes <= 0) {
    throw new Error("recovered recording did not preserve the flushed chunk");
  }
  if (expectEncryptedChunks && recoveredRecording?.encryptedAtRest !== true) {
    throw new Error("recovered recording did not preserve encrypted chunk custody");
  }
  const indexStatus = await recovery.call("recording.index.status");
  if (
    indexStatus?.keyMaterialExposedToRenderer !== false ||
    indexStatus?.rawPathExposed !== false
  ) {
    throw new Error("crash recovery vault index exposed key material or raw paths");
  }
  if (recoveredRecording?.rawPathExposed !== false) {
    throw new Error("crash recovery exposed a raw path");
  }

  await recovery.shutdown();
  recovery = null;
  console.log("M1 durable crash recovery smoke passed.");
} finally {
  if (writer) await writer.crash().catch(() => null);
  if (recovery) await recovery.shutdown().catch(() => null);
  rmSync(dataDir, { recursive: true, force: true });
}
