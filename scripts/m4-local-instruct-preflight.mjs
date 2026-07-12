import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const strictReady = process.argv.includes("--strict-ready");
const exe = process.platform === "win32" ? "candor-core.exe" : "candor-core";
const corePath = process.argv.find((arg) => !arg.startsWith("--") && arg !== process.argv[0] && arg !== process.argv[1])
  ? path.resolve(process.argv.find((arg) => !arg.startsWith("--") && arg !== process.argv[0] && arg !== process.argv[1]))
  : path.join(repoRoot, "crates", "candor-core", "target", "debug", exe);
const proofDir = path.join(repoRoot, "release-v3", "proofs");
const proofPath = path.join(
  proofDir,
  `m4-local-instruct-preflight-${process.platform}-${process.arch}.json`,
);
const dataDir = mkdtempSync(path.join(tmpdir(), "candor-v3-m4-local-instruct-"));
const failures = [];
const observations = [];
let child = null;
let status = null;
let proof = null;
let capabilities = null;

function fail(message) {
  failures.push(message);
}

function record(condition, message) {
  if (!condition) fail(message);
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
  const serialized = JSON.stringify(value);
  if (serialized.includes(dataDir)) {
    fail(`${label} exposed the temporary data root`);
  }
  for (const rawPath of [
    process.env.CANDOR_LOCAL_LLM_BINARY,
    process.env.CANDOR_LOCAL_LLM_MODEL,
  ].filter(Boolean)) {
    if (serialized.includes(rawPath)) {
      fail(`${label} exposed a configured local model path`);
    }
  }
  visitCustody(value, label);
}

function writeProofArtifact() {
  const summary = {
    ok: failures.length === 0,
    proofKind: "m4-local-instruct-preflight",
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    strictReady,
    localOnly: status?.localOnly === true && proof?.proof?.localOnly === true,
    cloudAi: status?.cloudAi === true || proof?.proof?.cloudAi === true,
    ready: status?.ready === true,
    failureCode: status?.failureCode ?? null,
    generationImplemented: status?.generationImplemented === true,
    preflightImplemented: status?.preflightImplemented === true,
    manualInstallOnly: status?.downloadPolicy === "manual-install-only",
    backgroundDownloads: status?.backgroundDownloads === true,
    networkAttempted: proof?.proof?.networkAttempted === true,
    downloadsAttempted: proof?.proof?.downloadsAttempted === true,
    schedulerReservationOk: proof?.proof?.schedulerReservationOk === true,
    whisperLlmConcurrent: proof?.proof?.whisperLlmConcurrent === true,
    rawPathExposed: false,
    keyMaterialExposedToRenderer: false,
    observations,
    failures,
    status,
    proof,
  };
  mkdirSync(proofDir, { recursive: true });
  writeFileSync(proofPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
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
    },
  });
  return child;
}

function makeRpc(childProcess) {
  const lines = createInterface({ input: childProcess.stdout });
  const pending = new Map();
  let nextId = 1;

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
      error.response = response;
      entry.reject(error);
    }
  });

  return function call(method, params = null) {
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
      childProcess.stdin.write(`${payload}\n`);
    });
  };
}

try {
  const core = spawnCore();
  const call = makeRpc(core);

  status = await call("ai.instructStatus");
  assertPathless(status, "AI instruct status");
  record(status?.implemented === true, "instruct status did not report implementation");
  record(status?.preflightImplemented === true, "instruct preflight was not implemented");
  record(status?.generationImplemented === true, "instruct generation was not implemented");
  record(status?.recapImplemented === true, "instruct recap was not implemented");
  record(status?.askImplemented === true, "instruct Ask was not implemented");
  record(status?.localOnly === true, "instruct status did not report local-only");
  record(status?.cloudAi === false, "instruct status did not deny cloud AI");
  record(status?.downloadPolicy === "manual-install-only", "instruct status did not require manual model install");
  record(status?.backgroundDownloads === false, "instruct status allowed background downloads");
  record(status?.configuration?.rawValuesExposed === false, "instruct status exposed raw configuration values");
  record(status?.scheduler?.whisperLlmConcurrent === false, "scheduler did not deny Whisper plus LLM concurrency");

  if (status?.ready === true) {
    observations.push("local instruct model is configured and ready");
    record(status?.failureCode == null, "ready instruct status still reported a failure code");
    record(status?.binaryExists === true, "ready instruct status did not prove local binary existence");
    record(status?.modelExists === true, "ready instruct status did not prove local model existence");
  } else {
    observations.push(`local instruct model not ready: ${status?.failureCode ?? "unknown"}`);
    record(
      [
        "LOCAL_LLM_BINARY_NOT_CONFIGURED",
        "LOCAL_LLM_MODEL_NOT_CONFIGURED",
        "LOCAL_LLM_BINARY_NOT_FOUND",
        "LOCAL_LLM_MODEL_NOT_FOUND",
        "LOCAL_LLM_BINARY_HASH_NOT_CONFIGURED",
        "LOCAL_LLM_MODEL_HASH_NOT_CONFIGURED",
        "LOCAL_LLM_BINARY_HASH_INVALID",
        "LOCAL_LLM_MODEL_HASH_INVALID",
        "LOCAL_LLM_BINARY_HASH_UNREADABLE",
        "LOCAL_LLM_MODEL_HASH_UNREADABLE",
        "LOCAL_LLM_BINARY_HASH_MISMATCH",
        "LOCAL_LLM_MODEL_HASH_MISMATCH",
      ].includes(status?.failureCode),
      "not-ready instruct status did not fail closed with an expected code",
    );
  }

  proof = await call("ai.proofInstructPreflight");
  assertPathless(proof, "AI instruct preflight proof");
  record(proof?.proofKind === "m4-local-instruct-preflight", "preflight proof kind was wrong");
  record(proof?.proof?.localOnly === true, "preflight proof did not report local-only");
  record(proof?.proof?.cloudAi === false, "preflight proof did not deny cloud AI");
  record(proof?.proof?.networkAttempted === false, "preflight proof attempted network");
  record(proof?.proof?.downloadsAttempted === false, "preflight proof attempted downloads");
  record(proof?.proof?.backgroundDownloads === false, "preflight proof allowed background downloads");
  record(proof?.proof?.schedulerReservationAttempted === true, "preflight proof did not exercise scheduler reservation");
  record(proof?.proof?.schedulerReservationOk === true, "preflight proof could not reserve the LLM scheduler lane");
  record(proof?.proof?.whisperLlmConcurrent === false, "preflight proof allowed Whisper plus LLM concurrency");
  record(proof?.statusAfterProof?.active === false, "preflight proof leaked an active scheduler job");
  record(proof?.ready === status?.ready, "preflight proof readiness did not match status readiness");

  capabilities = await call("core.capabilities");
  assertPathless(capabilities, "core capabilities");
  record(
    capabilities?.allowedMethods?.includes("ai.instructStatus"),
    "core capabilities did not allow ai.instructStatus",
  );
  record(
    capabilities?.allowedMethods?.includes("ai.proofInstructPreflight"),
    "core capabilities did not allow ai.proofInstructPreflight",
  );
  record(
    capabilities?.deniedCapabilities?.includes("cloudAi"),
    "core capabilities did not deny cloud AI",
  );
  record(
    capabilities?.deniedCapabilities?.includes("backgroundModelDownload"),
    "core capabilities did not deny background model download",
  );

  if (strictReady && status?.ready !== true) {
    fail("strict-ready mode requires a configured local binary, local GGUF, and matching optional hash");
  }

  await call("core.shutdown");
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  if (child && !child.killed) child.kill();
  rmSync(dataDir, { recursive: true, force: true });
  writeProofArtifact();
}

if (failures.length > 0) {
  console.error(`M4 local instruct preflight failed. Proof written to ${proofPath}.`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

const artifact = JSON.parse(readFileSync(proofPath, "utf8"));
console.log(
  `M4 local instruct preflight passed. ready=${artifact.ready} proof=${proofPath}`,
);
