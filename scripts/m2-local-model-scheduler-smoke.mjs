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

const dataDir = mkdtempSync(path.join(tmpdir(), "candor-v3-m2-scheduler-"));
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

try {
  const status = await call("ai.schedulerStatus");
  assertCustody(status, "scheduler status");
  if (
    status?.implemented !== true ||
    status?.active !== false ||
    status?.singleLocalModelJob !== true ||
    status?.whisperLlmConcurrent !== false ||
    !(status?.budgets?.ramBudgetMb > 0) ||
    typeof status?.budgets?.vramBudgetMb !== "number"
  ) {
    throw new Error("scheduler status did not report the local model job contract");
  }

  const proof = await call("ai.proofSchedulerBusy");
  assertCustody(proof, "scheduler busy proof");
  if (
    proof?.proof?.synthetic !== true ||
    proof?.proof?.firstJob !== "whisper" ||
    proof?.proof?.secondJob !== "llm" ||
    proof?.proof?.secondJobDenied !== true ||
    proof?.proof?.deniedCode !== "LOCAL_MODEL_JOB_ACTIVE" ||
    proof?.proof?.whisperLlmConcurrent !== false ||
    proof?.statusAfterProof?.active !== false
  ) {
    throw new Error("scheduler proof did not deny concurrent local model jobs");
  }

  const transcription = await call("transcription.status");
  assertCustody(transcription, "transcription scheduler status");
  if (
    transcription?.scheduler?.singleLocalModelJob !== true ||
    transcription?.scheduler?.whisperLlmConcurrent !== false
  ) {
    throw new Error("transcription status did not use the shared local scheduler");
  }

  const capabilities = await call("core.capabilities");
  if (
    !capabilities?.allowedMethods?.includes("ai.schedulerStatus") ||
    !capabilities?.allowedMethods?.includes("ai.proofSchedulerBusy")
  ) {
    throw new Error("core capabilities did not advertise scheduler methods");
  }

  await call("core.shutdown");
  console.log("M2 local model scheduler smoke passed.");
} finally {
  if (!child.killed) child.kill();
  rmSync(dataDir, { recursive: true, force: true });
}
