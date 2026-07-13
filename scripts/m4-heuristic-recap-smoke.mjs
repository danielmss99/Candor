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

const dataDir = mkdtempSync(path.join(tmpdir(), "candor-v3-m4-heuristic-recap-"));
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

function assertRecap(recap, label) {
  assertCustody(recap, label);
  if (
    recap?.engine !== "heuristic-local" ||
    recap?.localOnly !== true ||
    recap?.cloudAi !== false ||
    recap?.modelRequired !== false
  ) {
    throw new Error(`${label} did not report the local heuristic AI contract`);
  }
  if (!recap?.summary || typeof recap.summary !== "string") {
    throw new Error(`${label} did not produce a summary`);
  }
  if (
    recap?.decisions?.length < 1 ||
    recap?.actions?.length < 1 ||
    recap?.risks?.length < 1 ||
    recap?.questions?.length < 1 ||
    recap?.citations?.length < 4
  ) {
    throw new Error(`${label} did not extract the expected local sections`);
  }
}

function assertAsk(ask, label) {
  assertCustody(ask, label);
  if (
    ask?.engine !== "heuristic-local" ||
    ask?.mode !== "extractive-citations" ||
    ask?.localOnly !== true ||
    ask?.cloudAi !== false ||
    ask?.modelRequired !== false
  ) {
    throw new Error(`${label} did not report the local heuristic Ask contract`);
  }
  if (
    ask?.answerFound !== true ||
    typeof ask?.answer !== "string" ||
    ask.answer.length === 0 ||
    ask?.citations?.length < 1
  ) {
    throw new Error(`${label} did not answer from transcript citations`);
  }
}

try {
  const status = await call("ai.status");
  assertCustody(status, "AI status");
  if (
    status?.implemented !== true ||
    status?.engine !== "heuristic-local" ||
    status?.heuristicRecapImplemented !== true ||
    status?.heuristicAskImplemented !== true ||
    status?.askImplemented !== true ||
    status?.modelRequiredForHeuristics !== false ||
    status?.cloudAi !== false ||
    status?.scheduler?.whisperLlmConcurrent !== false
  ) {
    throw new Error("AI status did not report the local heuristic contract");
  }

  const started = await call("recording.durable.start", {
    label: "M4 heuristic recap smoke",
  });
  const recordingId = started?.recordingId;
  if (!recordingId) throw new Error("recording start did not return an id");

  await call("recording.durable.writeTranscriptSegment", {
    recordingId,
    channel: "mic",
    speaker: "Alex",
    text: "Decision: keep Electron only after M0 proves zero outbound traffic.",
    startMs: 0,
    durationMs: 1200,
    confidence: 0.99,
  });
  await call("recording.durable.writeTranscriptSegment", {
    recordingId,
    channel: "system",
    speaker: "Priya",
    text: "Action: Priya to validate the packaged smoke proof by Friday.",
    startMs: 1400,
    durationMs: 1300,
    confidence: 0.99,
  });
  await call("recording.durable.writeTranscriptSegment", {
    recordingId,
    channel: "system",
    speaker: "Lee",
    text: "Risk: Linux system audio may slip without PipeWire proof.",
    startMs: 2900,
    durationMs: 1200,
    confidence: 0.99,
  });
  await call("recording.durable.writeTranscriptSegment", {
    recordingId,
    channel: "mic",
    speaker: "Alex",
    text: "Question: do we need a manual update proof before release?",
    startMs: 4300,
    durationMs: 1200,
    confidence: 0.99,
  });
  await call("recording.durable.finish", { recordingId });

  const recap = await call("ai.recapHeuristic", { recordingId });
  assertRecap(recap, "AI heuristic recap");

  const ask = await call("ai.askHeuristic", {
    recordingId,
    question: "What action should Priya take?",
  });
  assertAsk(ask, "AI heuristic Ask");

  const proof = await call("ai.proofHeuristicRecap", {
    label: "M4 heuristic proof",
  });
  assertCustody(proof, "AI heuristic proof");
  if (proof?.proof?.synthetic !== true || proof?.proof?.modelRequired !== false) {
    throw new Error("AI proof did not report synthetic local heuristic facts");
  }
  assertRecap(proof?.recap, "AI heuristic proof recap");

  const askProof = await call("ai.proofHeuristicAsk", {
    label: "M4 heuristic Ask proof",
  });
  assertCustody(askProof, "AI heuristic Ask proof");
  if (askProof?.proof?.synthetic !== true || askProof?.proof?.modelRequired !== false) {
    throw new Error("AI Ask proof did not report synthetic local heuristic facts");
  }
  assertAsk(askProof?.ask, "AI heuristic proof Ask");

  const capabilities = await call("core.capabilities");
  if (
    !capabilities?.allowedMethods?.includes("ai.status") ||
    !capabilities?.allowedMethods?.includes("ai.askHeuristic") ||
    !capabilities?.allowedMethods?.includes("ai.recapHeuristic") ||
    !capabilities?.allowedMethods?.includes("ai.proofHeuristicAsk") ||
    !capabilities?.allowedMethods?.includes("ai.proofHeuristicRecap") ||
    !capabilities?.deniedCapabilities?.includes("cloudAi")
  ) {
    throw new Error("core capabilities did not advertise local AI methods and cloud AI denial");
  }

  await call("core.shutdown");
  console.log("M4 heuristic recap smoke passed.");
} finally {
  if (!child.killed) child.kill();
  rmSync(dataDir, { recursive: true, force: true });
}
