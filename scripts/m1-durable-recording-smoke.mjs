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

const dataDir = mkdtempSync(path.join(tmpdir(), "candor-v3-durable-"));
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

try {
  const status = await call("recording.durable.status");
  if (status?.durableChunks !== true || status?.rawPathExposed !== false) {
    throw new Error("durable recording status did not report local no-path storage");
  }
  if (process.platform === "win32") {
    if (
      status?.chunkEncryptionAvailable !== true ||
      status?.chunkEncryption !== "os-key-encrypted" ||
      status?.chunkCipher !== "chacha20poly1305"
    ) {
      throw new Error("Windows durable recording status did not report OS-key chunk encryption");
    }
  } else if (status?.chunkEncryptionAvailable === true) {
    if (
      status?.chunkEncryption !== "os-key-encrypted" ||
      status?.chunkCipher !== "chacha20poly1305"
    ) {
      throw new Error("non-Windows durable recording status did not report native OS-key chunk encryption");
    }
  } else if (status?.chunkEncryption !== "pending-native-key-storage") {
    throw new Error("non-Windows durable recording status did not report explicit fallback chunk storage");
  }
  const expectEncryptedChunks = status?.chunkEncryptionAvailable === true;

  const finishedStart = await call("recording.durable.start", { label: "finished smoke" });
  const finishedId = finishedStart.recordingId;
  await call("recording.durable.writeTextChunk", {
    recordingId: finishedId,
    channel: "mic",
    dataUtf8: "local durable bytes",
  });
  const finished = await call("recording.durable.finish", { recordingId: finishedId });
  if (finished?.state !== "finished" || finished?.chunkCount !== 1 || finished?.rawPathExposed !== false) {
    throw new Error("finished durable recording summary was invalid");
  }
  if (
    finished?.vaultIndex?.keyMaterialExposedToRenderer !== false ||
    finished?.vaultIndex?.rawPathExposed !== false
  ) {
    throw new Error("finished durable recording vault index exposed key material or raw paths");
  }
  if (expectEncryptedChunks) {
    if (
      finished?.encryptedAtRest !== true ||
      finished?.encryptedChunkCount !== 1 ||
      !(finished?.storedBytes > finished?.totalBytes)
    ) {
      throw new Error("finished durable recording did not prove encrypted chunk storage");
    }
  }

  const interruptedStart = await call("recording.durable.start", { label: "interrupted smoke" });
  await call("recording.durable.writeTextChunk", {
    recordingId: interruptedStart.recordingId,
    channel: "system",
    dataUtf8: "recoverable local bytes",
  });
  const recovered = await call("recording.durable.recover");
  if (recovered?.recoveredCount !== 1) {
    throw new Error(`expected one recoverable recording, got ${recovered?.recoveredCount}`);
  }
  if (recovered.recoveredRecordings?.[0]?.state !== "needsRecovery") {
    throw new Error("interrupted recording was not marked needsRecovery");
  }
  if (recovered.recoveredRecordings?.[0]?.rawPathExposed !== false) {
    throw new Error("recovery summary exposed a raw path");
  }
  if (expectEncryptedChunks && recovered.recoveredRecordings?.[0]?.encryptedAtRest !== true) {
    throw new Error("recovered durable recording did not preserve encrypted-at-rest custody");
  }
  if (
    recovered?.vaultIndex?.keyMaterialExposedToRenderer !== false ||
    recovered?.vaultIndex?.rawPathExposed !== false
  ) {
    throw new Error("recovery vault index exposed key material or raw paths");
  }

  await call("core.shutdown");
  console.log("M1 durable recording smoke passed.");
} finally {
  if (!child.killed) child.kill();
  rmSync(dataDir, { recursive: true, force: true });
}
