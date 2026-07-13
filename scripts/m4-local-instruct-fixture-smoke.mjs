import { createVersionedCoreRequest } from "./core-rpc-envelope.mjs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
  `m4-local-instruct-fixture-${process.platform}-${process.arch}.json`,
);
const dataDir = mkdtempSync(path.join(tmpdir(), "candor-v3-m4-instruct-fixture-data-"));
const fixtureDir = mkdtempSync(path.join(tmpdir(), "candor-v3-m4-instruct-fixture-bin-"));
function electronRuntimeSourcePaths(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return electronRuntimeSourcePaths(target);
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return [];
    return [target];
  });
}

const electronMainSource = electronRuntimeSourcePaths(path.join(repoRoot, "electron"))
  .filter((file) => !file.endsWith("preload.cts"))
  .map((file) => readFileSync(file, "utf8"))
  .join("\n");
const preloadSource = readFileSync(path.join(repoRoot, "electron", "preload.cts"), "utf8");
const apiTypesSource = readFileSync(
  path.join(repoRoot, "v3", "renderer", "src", "candor-api.d.ts"),
  "utf8",
);
function rendererSourcePaths(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return rendererSourcePaths(target);
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return [];
    return [target];
  });
}

const rendererSource = rendererSourcePaths(path.join(repoRoot, "v3", "renderer", "src"))
  .map((file) => readFileSync(file, "utf8"))
  .join("\n");
const failures = [];
const observations = [];
let child = null;
let status = null;
let recap = null;
let ask = null;
let capabilities = null;
let schedulerAfter = null;
let fixtureBinary = null;
let fixtureModel = null;
const rendererSurface = {
  bridgeImplemented: false,
  qualityModeImplemented: false,
  fallbackImplemented: false,
  citedOutputImplemented: false,
};

function fail(message) {
  failures.push(message);
}

function record(condition, message) {
  if (!condition) fail(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requireSource(source, pattern, label) {
  if (!source.includes(pattern)) {
    throw new Error(`${label} is missing ${pattern}`);
  }
}

function verifyRendererSurface() {
  for (const [method, channel] of [
    ["ai.instructStatus", "candor-core:ai-instruct-status"],
    ["ai.recap.start", "candor-ai:recap"],
    ["ai.ask.start", "candor-ai:ask"],
  ]) {
    requireSource(electronMainSource, `\"${method}\"`, "Electron renderer allowlist");
    requireSource(preloadSource, `\"${channel}\"`, "preload named channel");
  }
  requireSource(electronMainSource, '{ method: "ai.ask.start", timeoutMs: 10_000, mode: "job"', "Electron Ask job contract");
  requireSource(electronMainSource, '{ method: "ai.recap.start", timeoutMs: 10_000, mode: "job"', "Electron recap job contract");
  for (const apiMethod of ["getEnhancedStatus", "generateRecap", "ask"]) {
    requireSource(preloadSource, apiMethod, "preload bridge");
    requireSource(apiTypesSource, apiMethod, "renderer API types");
    requireSource(rendererSource, apiMethod, "renderer workspace");
  }
  rendererSurface.bridgeImplemented = true;

  requireSource(rendererSource, 'aria-label="Local AI mode"', "renderer mode control");
  requireSource(rendererSource, 'aria-pressed={aiMode === "quality"}', "renderer quality mode");
  requireSource(rendererSource, 'aria-pressed={aiMode === "fast"}', "renderer fast mode");
  rendererSurface.qualityModeImplemented = true;

  requireSource(rendererSource, "Fast local fallback", "renderer fallback status");
  requireSource(rendererSource, 'aiMode === "quality" && instructReady', "renderer fallback branch");
  rendererSurface.fallbackImplemented = true;

  requireSource(rendererSource, "recapMarkdown", "renderer model recap parser");
  requireSource(rendererSource, 'aria-label="Recap citations"', "renderer model citations");
  rendererSurface.citedOutputImplemented = true;
}

function writeFixture() {
  const modelBytes = Buffer.from("candor local fixture gguf placeholder\n", "utf8");
  fixtureModel = path.join(fixtureDir, "fixture.gguf");
  writeFileSync(fixtureModel, modelBytes);

  if (process.platform === "win32") {
    fixtureBinary = path.join(fixtureDir, "fake-llama.cmd");
    writeFileSync(
      fixtureBinary,
      [
        "@echo off",
        "echo ## Fixture Recap [s0]",
        "echo - Decision: Candor keeps AI local [s0]",
        "echo - Action: Priya validates cited Ask output [s1]",
      ].join("\r\n"),
      "utf8",
    );
  } else {
    fixtureBinary = path.join(fixtureDir, "fake-llama.sh");
    writeFileSync(
      fixtureBinary,
      [
        "#!/usr/bin/env sh",
        "printf '%s\\n' '## Fixture Recap [s0]'",
        "printf '%s\\n' '- Decision: Candor keeps AI local [s0]'",
        "printf '%s\\n' '- Action: Priya validates cited Ask output [s1]'",
      ].join("\n"),
      "utf8",
    );
    chmodSync(fixtureBinary, 0o755);
  }

  return {
    binary: fixtureBinary,
    binarySha256: sha256(readFileSync(fixtureBinary)),
    model: fixtureModel,
    modelSha256: sha256(modelBytes),
  };
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
    if (key === "promptPathExposed" && childValue !== false) {
      fail(`${label} reported prompt path exposure`);
    }
    if (key === "rawValuesExposed" && childValue !== false) {
      fail(`${label} reported raw configuration values`);
    }
    visitCustody(childValue, label);
  }
}

function assertPathless(value, label) {
  const serialized = JSON.stringify(value);
  for (const rawPath of [dataDir, fixtureDir, fixtureBinary, fixtureModel].filter(Boolean)) {
    if (serialized.includes(rawPath)) {
      fail(`${label} exposed a local fixture or data path`);
    }
  }
  visitCustody(value, label);
}

function spawnCore(envPatch) {
  if (!existsSync(corePath)) {
    throw new Error(`candor-core debug binary not found: ${corePath}`);
  }
  child = spawn(corePath, [], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      ...envPatch,
      CANDOR_V3_DATA_DIR: dataDir,
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
      error.response = response;
      entry.reject(error);
    }
  });

  return function call(method, params = null) {
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
      childProcess.stdin.write(`${payload}\n`);
    });
  };
}

async function seedRecording(call) {
  const started = await call("recording.durable.start", {
    label: "M4 local instruct fixture",
  });
  const recordingId = started?.recordingId;
  if (!recordingId) throw new Error("recording start did not return an id");

  await call("recording.durable.writeTranscriptSegment", {
    recordingId,
    channel: "mic",
    speaker: "Alex",
    text: "Decision: Candor keeps all AI processing on the local machine.",
    startMs: 0,
    durationMs: 1200,
    confidence: 0.99,
  });
  await call("recording.durable.writeTranscriptSegment", {
    recordingId,
    channel: "system",
    speaker: "Priya",
    text: "Action: Priya validates the cited Ask output before the release gate.",
    startMs: 1400,
    durationMs: 1300,
    confidence: 0.99,
  });
  await call("recording.durable.finish", { recordingId });
  return recordingId;
}

function assertInstructResult(value, label, mode) {
  assertPathless(value, label);
  record(value?.engine === "llama-cpp-local", `${label} did not use the local instruct engine`);
  record(value?.backend === "external-llama-cpp-binary", `${label} did not report the local binary backend`);
  record(value?.mode === mode, `${label} returned the wrong mode`);
  record(value?.localOnly === true, `${label} did not report local-only`);
  record(value?.cloudAi === false, `${label} did not deny cloud AI`);
  record(value?.networkAttempted === false, `${label} attempted network`);
  record(value?.downloadsAttempted === false, `${label} attempted downloads`);
  record(value?.promptPathExposed === false, `${label} exposed the prompt path`);
  record(value?.promptDeletedAfterRun === true, `${label} did not delete the local prompt file`);
  record(value?.modelRequired === true, `${label} did not require a local model`);
  record(value?.modelOutputGrounded === true, `${label} did not core-ground model output`);
  record(
    value?.groundingMethod === "core-lexical-overlap-speaker-aware",
    `${label} returned the wrong grounding method`,
  );
  record(value?.citationsVerifiedFromOutput === true, `${label} did not verify citations from output`);
  record(value?.citations?.length >= 1, `${label} returned no parsed citations`);
  record(JSON.stringify(value).includes("[s0]"), `${label} did not preserve bracketed citation output`);
}

function writeProofArtifact() {
  const summary = {
    ok: failures.length === 0,
    proofKind: "m4-local-instruct-fixture",
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    fixture: true,
    realModel: false,
    realGguf: false,
    strictRealModelSatisfied: false,
    localOnly: status?.localOnly === true && recap?.localOnly === true && ask?.localOnly === true,
    cloudAi: status?.cloudAi === true || recap?.cloudAi === true || ask?.cloudAi === true,
    ready: status?.ready === true,
    generationImplemented: status?.generationImplemented === true,
    recapImplemented: status?.recapImplemented === true,
    askImplemented: status?.askImplemented === true,
    modelHashVerified: status?.modelHashVerified === true,
    binaryHashVerified: status?.binaryHashVerified === true,
    networkAttempted: recap?.networkAttempted === true || ask?.networkAttempted === true,
    downloadsAttempted: recap?.downloadsAttempted === true || ask?.downloadsAttempted === true,
    recapCitationsVerified: recap?.citationsVerifiedFromOutput === true,
    askCitationsVerified: ask?.citationsVerifiedFromOutput === true,
    schedulerActiveAfter: schedulerAfter?.active === true,
    rendererBridgeImplemented: rendererSurface.bridgeImplemented,
    rendererQualityModeImplemented: rendererSurface.qualityModeImplemented,
    rendererFallbackImplemented: rendererSurface.fallbackImplemented,
    rendererCitedOutputImplemented: rendererSurface.citedOutputImplemented,
    rawPathExposed: false,
    keyMaterialExposedToRenderer: false,
    observations,
    failures,
    status,
    recap,
    ask,
  };
  mkdirSync(proofDir, { recursive: true });
  writeFileSync(proofPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

try {
  verifyRendererSurface();
  observations.push("typed renderer bridge and quality fallback surface are implemented");
  const fixture = writeFixture();
  const core = spawnCore({
    CANDOR_LOCAL_LLM_BINARY: fixture.binary,
    CANDOR_LOCAL_LLM_BINARY_SHA256: fixture.binarySha256,
    CANDOR_LOCAL_LLM_MODEL: fixture.model,
    CANDOR_LOCAL_LLM_MODEL_SHA256: fixture.modelSha256,
    CANDOR_LOCAL_LLM_CONTEXT_TOKENS: "2048",
  });
  const call = makeRpc(core);

  status = await call("ai.instructStatus");
  assertPathless(status, "AI instruct status");
  record(status?.ready === true, "fixture instruct status was not ready");
  record(status?.generationImplemented === true, "fixture instruct status did not implement generation");
  record(status?.recapImplemented === true, "fixture instruct status did not implement recap");
  record(status?.askImplemented === true, "fixture instruct status did not implement Ask");
  record(status?.modelHashVerified === true, "fixture instruct status did not verify model hash");
  record(status?.binaryHashVerified === true, "fixture instruct status did not verify binary hash");
  record(status?.downloadPolicy === "manual-install-only", "fixture instruct status did not stay manual-install only");

  const recordingId = await seedRecording(call);
  recap = await call("ai.recapInstruct", { recordingId, maxTokens: 128 });
  assertInstructResult(recap, "AI instruct recap", "recap");
  ask = await call("ai.askInstruct", {
    recordingId,
    question: "What should Priya validate?",
    maxTokens: 128,
  });
  assertInstructResult(ask, "AI instruct Ask", "ask");

  schedulerAfter = await call("ai.schedulerStatus");
  assertPathless(schedulerAfter, "scheduler after instruct runs");
  record(schedulerAfter?.active === false, "scheduler stayed active after instruct runs");
  record(schedulerAfter?.whisperLlmConcurrent === false, "scheduler allowed Whisper plus LLM concurrency");

  capabilities = await call("core.capabilities");
  assertPathless(capabilities, "core capabilities");
  record(capabilities?.allowedMethods?.includes("ai.recapInstruct"), "core capabilities did not allow ai.recapInstruct");
  record(capabilities?.allowedMethods?.includes("ai.askInstruct"), "core capabilities did not allow ai.askInstruct");
  record(capabilities?.deniedCapabilities?.includes("cloudAi"), "core capabilities did not deny cloud AI");

  observations.push("fixture executable proved local instruct recap and Ask RPC invocation");
  await call("core.shutdown");
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  if (child && !child.killed) child.kill();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(fixtureDir, { recursive: true, force: true });
  writeProofArtifact();
}

if (failures.length > 0) {
  console.error(`M4 local instruct fixture failed. Proof written to ${proofPath}.`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`M4 local instruct fixture passed. Proof written to ${proofPath}.`);
