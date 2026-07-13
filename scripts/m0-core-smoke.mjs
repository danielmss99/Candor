import { createVersionedCoreRequest } from "./core-rpc-envelope.mjs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
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

const child = spawn(corePath, [], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

const lines = createInterface({ input: child.stdout });
const pending = new Map();
const responseWaiters = [];
const unmatchedResponses = [];

child.stderr.on("data", (chunk) => {
  process.stderr.write(`[candor-core stderr] ${chunk}`);
});

lines.on("line", (line) => {
  const response = JSON.parse(line);
  const entry = pending.get(response.id);
  if (entry) {
    pending.delete(response.id);
    if (response.ok) entry.resolve(response.result);
    else {
      const error = new Error(response.error?.message ?? "RPC failed");
      error.code = response.error?.code;
      error.response = response;
      entry.reject(error);
    }
    return;
  }

  const waiterIndex = responseWaiters.findIndex((waiter) => waiter.predicate(response));
  if (waiterIndex >= 0) {
    const [waiter] = responseWaiters.splice(waiterIndex, 1);
    clearTimeout(waiter.timeout);
    waiter.resolve(response);
    return;
  }

  unmatchedResponses.push(response);
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

function waitForResponse(predicate, description) {
  const existingIndex = unmatchedResponses.findIndex((response) => predicate(response));
  if (existingIndex >= 0) {
    const [response] = unmatchedResponses.splice(existingIndex, 1);
    return Promise.resolve(response);
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      const waiterIndex = responseWaiters.findIndex((waiter) => waiter.resolve === resolve);
      if (waiterIndex >= 0) responseWaiters.splice(waiterIndex, 1);
      reject(new Error(`timeout waiting for ${description}`));
    }, 5000);
    responseWaiters.push({ predicate, resolve, timeout });
  });
}

async function sendRawExpectError(rawLine, expectedCode) {
  const responsePromise = waitForResponse(
    (response) => response?.ok === false && response?.error?.code === expectedCode,
    expectedCode,
  );
  child.stdin.write(`${rawLine}\n`);
  return responsePromise;
}

try {
  const version = await call("core.version");
  const status = await call("core.status");
  const capabilities = await call("core.capabilities");
  const audit = await call("privacy.auditSnapshot");
  const updates = await call("updates.status");
  const maxRpcFrameBytes = Number(capabilities?.maxRpcFrameBytes);
  if (!Number.isInteger(maxRpcFrameBytes) || maxRpcFrameBytes < 1024) {
    throw new Error("capabilities response missing maxRpcFrameBytes");
  }
  const denied = await call("not.allowed").then(
    () => false,
    (err) => err.code === "METHOD_NOT_ALLOWED" || /not in the M0 allowlist|not allowed/i.test(err.message),
  );
  const malformedJson = await sendRawExpectError("{ definitely not json", "MALFORMED_JSON_RPC");
  const malformedEnvelope = await sendRawExpectError(
    JSON.stringify({ id: "missing-method", params: null }),
    "MALFORMED_JSON_RPC",
  );
  const oversizedFrame = await sendRawExpectError(
    "x".repeat(maxRpcFrameBytes + 1),
    "RPC_FRAME_TOO_LARGE",
  );
  const postFuzzStatus = await call("core.status");

  if (!version?.protocolVersion) throw new Error("version response missing protocolVersion");
  if (status?.sidecarTransport !== "stdio-json-lines") {
    throw new Error(`unexpected sidecar transport: ${status?.sidecarTransport}`);
  }
  if (!Array.isArray(capabilities?.deniedCapabilities)) {
    throw new Error("capabilities response missing deniedCapabilities");
  }
  if (!capabilities.deniedCapabilities.includes("backgroundModelDownload")) {
    throw new Error("capabilities must deny backgroundModelDownload");
  }
  if (audit?.externalCallsAttempted !== 0) {
    throw new Error("privacy audit did not report zero attempted external calls");
  }
  if (
    updates?.policy !== "manual-check-only" ||
    updates?.backgroundChecks !== false ||
    updates?.startupCheck !== false ||
    updates?.manualCheckNetworkEnabled !== false ||
    updates?.attemptedChecks !== 0
  ) {
    throw new Error("updates status did not report the M0 manual-only no-network policy");
  }
  if (!denied) throw new Error("unknown method was not denied");
  if (malformedJson.id !== null || malformedEnvelope.id !== null || oversizedFrame.id !== null) {
    throw new Error("fuzz errors must not bind to trusted request ids");
  }
  if (postFuzzStatus?.sidecarTransport !== "stdio-json-lines") {
    throw new Error("core did not remain healthy after IPC fuzz cases");
  }

  await call("core.shutdown");
  console.log("M0 candor-core smoke passed.");
} finally {
  if (!child.killed) child.kill();
}
