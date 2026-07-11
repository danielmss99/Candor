import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const allowMissing = process.argv.includes("--allow-missing");
const selfTest = process.argv.includes("--self-test");
const exe = process.platform === "win32" ? "candor-core.exe" : "candor-core";
const minimumBinaryBytes = 4_096;
const modularLauncherThresholdBytes = 100_000;
const minimumModelBytes = 1_000_000;
const rpcTimeoutMs = 70_000;

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function configuredPath(name) {
  const value = process.env[name]?.trim();
  return value ? path.resolve(value) : null;
}

const corePath = path.resolve(
  argValue(
    "--core",
    path.join(repoRoot, "crates", "candor-core", "target", "debug", exe),
  ),
);
const binaryPath = configuredPath("CANDOR_LOCAL_LLM_BINARY");
const modelPath = configuredPath("CANDOR_LOCAL_LLM_MODEL");
const distributionArchivePath = configuredPath("CANDOR_LOCAL_LLM_DISTRIBUTION_ARCHIVE");
const expectedBinarySha256 = process.env.CANDOR_LOCAL_LLM_BINARY_SHA256?.trim() ?? "";
const expectedModelSha256 = process.env.CANDOR_LOCAL_LLM_MODEL_SHA256?.trim() ?? "";
const expectedDistributionSha256 =
  process.env.CANDOR_LOCAL_LLM_DISTRIBUTION_SHA256?.trim() ?? "";
const contextTokens = process.env.CANDOR_LOCAL_LLM_CONTEXT_TOKENS?.trim() || "4096";
const proofDir = path.join(repoRoot, "release-v3", "proofs");
const proofPath = path.resolve(
  repoRoot,
  argValue(
    "--write",
    path.join(
      "release-v3",
      "proofs",
      `m4-real-local-instruct-proof-${process.platform}-${process.arch}.json`,
    ),
  ),
);
const dataDir = mkdtempSync(path.join(tmpdir(), "candor-v3-m4-real-instruct-"));
const failures = [];
const observations = [];
let child = null;
let status = null;
let recap = null;
let ask = null;
let schedulerAfter = null;
let recapQuality = null;
let askQuality = null;
let rawPathExposed = false;
let inferenceAttempted = false;

function fileSize(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  try {
    const info = statSync(filePath);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
}

function filePrefix(filePath, bytes) {
  if (!filePath || !existsSync(filePath)) return null;
  let descriptor = null;
  try {
    descriptor = openSync(filePath, "r");
    const buffer = Buffer.alloc(bytes);
    const read = readSync(descriptor, buffer, 0, bytes, 0);
    return buffer.subarray(0, read);
  } catch {
    return null;
  } finally {
    if (descriptor != null) closeSync(descriptor);
  }
}

function sha256File(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  let descriptor = null;
  try {
    descriptor = openSync(filePath, "r");
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(1024 * 1024);
    let offset = 0;
    while (true) {
      const read = readSync(descriptor, buffer, 0, buffer.length, offset);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
      offset += read;
    }
    return hash.digest("hex");
  } catch {
    return null;
  } finally {
    if (descriptor != null) closeSync(descriptor);
  }
}

function nativeHeaderValid(header, platform = process.platform) {
  if (!header) return false;
  if (platform === "win32") {
    if (header.length < 0x40 || header.subarray(0, 2).toString("ascii") !== "MZ") return false;
    const offset = header.readUInt32LE(0x3c);
    return (
      offset + 4 <= header.length &&
      header.subarray(offset, offset + 4).equals(Buffer.from([0x50, 0x45, 0, 0]))
    );
  }
  if (platform === "darwin") {
    if (header.length < 4) return false;
    const magic = header.readUInt32BE(0);
    return [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(magic);
  }
  return (
    header.length >= 7 &&
    header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) &&
    [1, 2].includes(header[4]) &&
    [1, 2].includes(header[5]) &&
    header[6] === 1
  );
}

function runtimeCompanionCandidate(name) {
  const lower = name.toLowerCase();
  if (process.platform === "win32") return lower.endsWith(".dll");
  if (process.platform === "darwin") return lower.endsWith(".dylib");
  return lower.includes(".so");
}

function inspectRuntimeBundle() {
  if (!binaryPath || binaryBytes == null) {
    return {
      modular: false,
      validated: false,
      companionCount: 0,
      totalCompanionBytes: 0,
      missingRequired: [],
      companions: [],
    };
  }
  const modular = binaryBytes < modularLauncherThresholdBytes;
  if (!modular) {
    return {
      modular: false,
      validated: true,
      companionCount: 0,
      totalCompanionBytes: 0,
      missingRequired: [],
      companions: [],
    };
  }

  let entries = [];
  try {
    entries = readdirSync(path.dirname(binaryPath), { withFileTypes: true });
  } catch {
    return {
      modular: true,
      validated: false,
      companionCount: 0,
      totalCompanionBytes: 0,
      missingRequired: ["runtime-directory-unreadable"],
      companions: [],
    };
  }
  const companions = entries
    .filter((entry) => entry.isFile() && runtimeCompanionCandidate(entry.name))
    .map((entry) => {
      const filePath = path.join(path.dirname(binaryPath), entry.name);
      return {
        name: entry.name,
        bytes: fileSize(filePath),
        sha256: sha256File(filePath),
        nativeHeaderValid: nativeHeaderValid(filePrefix(filePath, 64 * 1024)),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  const names = new Set(companions.map((entry) => entry.name.toLowerCase()));
  let missingRequired = [];
  if (process.platform === "win32") {
    const frontendImplementation = path
      .basename(binaryPath)
      .toLowerCase()
      .startsWith("llama-completion")
      ? "llama-completion-impl.dll"
      : "llama-cli-impl.dll";
    const required = [
      frontendImplementation,
      "llama-common.dll",
      "llama.dll",
      "ggml.dll",
      "ggml-base.dll",
    ];
    missingRequired = required.filter((name) => !names.has(name));
    if (![...names].some((name) => name.startsWith("ggml-cpu-") && name.endsWith(".dll"))) {
      missingRequired.push("ggml-cpu-*.dll");
    }
  } else if (companions.length === 0) {
    missingRequired.push(process.platform === "darwin" ? "*.dylib" : "*.so*");
  }
  const companionsValid = companions.every(
    (entry) => entry.bytes > 0 && entry.sha256 && entry.nativeHeaderValid,
  );
  return {
    modular: true,
    validated: missingRequired.length === 0 && companionsValid,
    companionCount: companions.length,
    totalCompanionBytes: companions.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0),
    missingRequired,
    companions,
  };
}

const coreBytes = fileSize(corePath);
const binaryBytes = fileSize(binaryPath);
const modelBytes = fileSize(modelPath);
const modelPrefix = filePrefix(modelPath, 4);
const modelHasGgufMagic = modelPrefix?.toString("ascii") === "GGUF";
const binaryHeaderValid = nativeHeaderValid(filePrefix(binaryPath, 64 * 1024));
const binaryLooksNative =
  binaryBytes != null &&
  binaryBytes >= minimumBinaryBytes &&
  binaryHeaderValid &&
  (process.platform !== "win32" || path.extname(binaryPath ?? "").toLowerCase() === ".exe");
const realGguf =
  modelBytes != null && modelBytes >= minimumModelBytes && modelHasGgufMagic;
const runtimeBundle = inspectRuntimeBundle();
const distributionArchiveBytes = fileSize(distributionArchivePath);
const actualDistributionSha256 = sha256File(distributionArchivePath);
const distributionArchiveVerified =
  !runtimeBundle.modular ||
  (distributionArchiveBytes != null &&
    /^[a-f0-9]{64}$/i.test(expectedDistributionSha256) &&
    actualDistributionSha256?.toLowerCase() === expectedDistributionSha256.toLowerCase());

const missingPrerequisites = [];
if (coreBytes == null) missingPrerequisites.push("candor-core debug binary is missing");
if (!binaryPath) missingPrerequisites.push("CANDOR_LOCAL_LLM_BINARY is not configured");
else if (binaryBytes == null) missingPrerequisites.push("configured local LLM binary is missing");
if (!modelPath) missingPrerequisites.push("CANDOR_LOCAL_LLM_MODEL is not configured");
else if (modelBytes == null) missingPrerequisites.push("configured local GGUF model is missing");
if (!expectedModelSha256) {
  missingPrerequisites.push("CANDOR_LOCAL_LLM_MODEL_SHA256 is not configured");
}
if (!expectedBinarySha256) {
  missingPrerequisites.push("CANDOR_LOCAL_LLM_BINARY_SHA256 is not configured");
}
if (runtimeBundle.modular && !distributionArchivePath) {
  missingPrerequisites.push("CANDOR_LOCAL_LLM_DISTRIBUTION_ARCHIVE is not configured for the modular runtime");
}
if (runtimeBundle.modular && !expectedDistributionSha256) {
  missingPrerequisites.push("CANDOR_LOCAL_LLM_DISTRIBUTION_SHA256 is not configured for the modular runtime");
}
const prerequisiteMissing = missingPrerequisites.length > 0;

const invalidPrerequisites = [];
if (expectedModelSha256 && !/^[a-f0-9]{64}$/i.test(expectedModelSha256)) {
  invalidPrerequisites.push("configured model SHA-256 is not 64 hexadecimal characters");
}
if (expectedBinarySha256 && !/^[a-f0-9]{64}$/i.test(expectedBinarySha256)) {
  invalidPrerequisites.push("configured binary SHA-256 is not 64 hexadecimal characters");
}
if (expectedDistributionSha256 && !/^[a-f0-9]{64}$/i.test(expectedDistributionSha256)) {
  invalidPrerequisites.push("configured distribution SHA-256 is not 64 hexadecimal characters");
}
if (binaryBytes != null && !binaryLooksNative) {
  invalidPrerequisites.push(
    `configured local LLM binary must have a valid native header and contain at least ${minimumBinaryBytes} bytes`,
  );
}
if (runtimeBundle.modular && !runtimeBundle.validated) {
  invalidPrerequisites.push(
    `modular local LLM runtime is incomplete or invalid: ${runtimeBundle.missingRequired.join(", ") || "companion validation failed"}`,
  );
}
if (runtimeBundle.modular && distributionArchivePath && !distributionArchiveVerified) {
  invalidPrerequisites.push("configured modular-runtime distribution archive did not match its SHA-256 pin");
}
if (modelBytes != null && modelBytes < minimumModelBytes) {
  invalidPrerequisites.push(
    `configured model must be at least ${minimumModelBytes} bytes to qualify as a real-model proof`,
  );
}
if (modelBytes != null && !modelHasGgufMagic) {
  invalidPrerequisites.push("configured model does not have the GGUF file signature");
}

const sensitivePaths = [dataDir, corePath, binaryPath, modelPath, distributionArchivePath]
  .filter(Boolean)
  .flatMap((value) => [value, value.replaceAll("\\", "/")]);

function normalizeText(value) {
  return value.replaceAll("\\", "/").toLowerCase();
}

function fail(message) {
  failures.push(message);
}

function record(condition, message) {
  if (!condition) fail(message);
}

function visitStrings(value, visitor) {
  if (typeof value === "string") {
    visitor(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) visitStrings(item, visitor);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const childValue of Object.values(value)) visitStrings(childValue, visitor);
}

function visitCustody(value, label) {
  if (Array.isArray(value)) {
    for (const item of value) visitCustody(item, label);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, childValue] of Object.entries(value)) {
    if (key === "rawPathExposed" && childValue !== false) {
      rawPathExposed = true;
      fail(`${label} reported raw path exposure`);
    }
    if (key === "keyMaterialExposedToRenderer" && childValue !== false) {
      fail(`${label} reported key material exposure`);
    }
    if (key === "promptPathExposed" && childValue !== false) {
      rawPathExposed = true;
      fail(`${label} reported prompt path exposure`);
    }
    if (key === "rawValuesExposed" && childValue !== false) {
      fail(`${label} reported raw configuration values`);
    }
    visitCustody(childValue, label);
  }
}

function assertPathless(value, label) {
  const normalizedSensitivePaths = sensitivePaths.map(normalizeText);
  visitStrings(value, (candidate) => {
    const normalizedCandidate = normalizeText(candidate);
    if (normalizedSensitivePaths.some((rawPath) => normalizedCandidate.includes(rawPath))) {
      rawPathExposed = true;
      fail(`${label} exposed a configured local path`);
    }
  });
  visitCustody(value, label);
}

function redactText(value) {
  let redacted = value;
  for (const rawPath of sensitivePaths) {
    if (!rawPath) continue;
    redacted = redacted.split(rawPath).join("[redacted-local-path]");
  }
  return redacted;
}

function sanitizeForArtifact(value) {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(sanitizeForArtifact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, childValue]) => [key, sanitizeForArtifact(childValue)]),
  );
}

function safeError(error) {
  return redactText(error instanceof Error ? error.message : String(error));
}

function spawnCore() {
  child = spawn(corePath, [], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      CANDOR_V3_DATA_DIR: dataDir,
      CANDOR_LOCAL_LLM_BINARY: binaryPath,
      CANDOR_LOCAL_LLM_BINARY_SHA256: expectedBinarySha256,
      CANDOR_LOCAL_LLM_MODEL: modelPath,
      CANDOR_LOCAL_LLM_MODEL_SHA256: expectedModelSha256,
      CANDOR_LOCAL_LLM_CONTEXT_TOKENS: contextTokens,
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
    let response;
    try {
      response = JSON.parse(line);
    } catch {
      for (const entry of pending.values()) entry.reject(new Error("candor-core returned invalid JSON"));
      pending.clear();
      return;
    }
    const entry = pending.get(response.id);
    if (!entry) return;
    pending.delete(response.id);
    if (response.ok) {
      entry.resolve(response.result);
    } else {
      const error = new Error(response.error?.message ?? "RPC failed");
      error.code = response.error?.code;
      entry.reject(error);
    }
  });

  childProcess.once("exit", () => {
    for (const entry of pending.values()) {
      entry.reject(new Error("candor-core exited before completing the RPC request"));
    }
    pending.clear();
  });

  return function call(method, params = null) {
    const id = nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, rpcTimeoutMs);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      childProcess.stdin.write(`${payload}\n`);
    });
  };
}

async function seedRecording(call) {
  const started = await call("recording.durable.start", {
    label: "M4 real local instruct quality proof",
  });
  const recordingId = started?.recordingId;
  if (!recordingId) throw new Error("recording start did not return an id");

  const segments = [
    {
      channel: "mic",
      speaker: "Alex",
      text: "Decision: Candor will ship the local-only recorder after the release checklist is complete.",
      startMs: 0,
    },
    {
      channel: "system",
      speaker: "Priya",
      text: "Action: Priya must validate the Windows installer signature and offline replay before Friday.",
      startMs: 1600,
    },
    {
      channel: "system",
      speaker: "Morgan",
      text: "Risk: if crash recovery loses more than one audio chunk, the release must be blocked.",
      startMs: 3300,
    },
    {
      channel: "mic",
      speaker: "Alex",
      text: "Decision: defer embeddings and semantic search until the core workflow is proven.",
      startMs: 4900,
    },
  ];

  for (const segment of segments) {
    await call("recording.durable.writeTranscriptSegment", {
      recordingId,
      ...segment,
      durationMs: 1300,
      confidence: 0.99,
    });
  }
  await call("recording.durable.finish", { recordingId });
  return recordingId;
}

function citationIds(value) {
  return new Set(
    Array.isArray(value?.citations)
      ? value.citations.map((citation) => citation?.citationId).filter(Boolean)
      : [],
  );
}

function matchingTerms(text, terms) {
  const normalized = text.toLowerCase();
  return terms.filter((term) => normalized.includes(term.toLowerCase()));
}

function evaluateRecap(value) {
  const output = value?.recapMarkdown ?? value?.output ?? "";
  const citations = citationIds(value);
  const matchedAnchors = matchingTerms(output, [
    "local-only",
    "Priya",
    "installer",
    "crash",
    "embeddings",
  ]);
  const matchedSections = matchingTerms(output, ["summary", "decision", "action", "risk"]);
  const result = {
    ok: false,
    outputCharacters: output.length,
    citationCount: citations.size,
    requiredCitationsPresent: citations.has("s0") && citations.has("s1"),
    matchedAnchors,
    matchedSections,
  };
  result.ok =
    output.length >= 120 &&
    output.length <= 8_000 &&
    value?.citationsVerifiedFromOutput === true &&
    citations.size >= 2 &&
    result.requiredCitationsPresent &&
    matchedAnchors.length >= 3 &&
    matchedSections.length >= 3;
  return result;
}

function evaluateAsk(value) {
  const output = value?.answer ?? value?.output ?? "";
  const citations = citationIds(value);
  const matchedAnchors = matchingTerms(output, [
    "Priya",
    "Windows",
    "installer",
    "signature",
    "offline replay",
    "Friday",
  ]);
  const result = {
    ok: false,
    outputCharacters: output.length,
    citationCount: citations.size,
    requiredCitationPresent: citations.has("s1"),
    matchedAnchors,
  };
  result.ok =
    output.length >= 25 &&
    output.length <= 2_000 &&
    value?.citationsVerifiedFromOutput === true &&
    result.requiredCitationPresent &&
    matchedAnchors.length >= 3;
  return result;
}

function assertInstructResult(value, label, mode) {
  assertPathless(value, label);
  record(value?.engine === "llama-cpp-local", `${label} did not use the local instruct engine`);
  record(value?.backend === "external-llama-cpp-binary", `${label} did not use the local binary backend`);
  record(value?.mode === mode, `${label} returned the wrong mode`);
  record(value?.localOnly === true, `${label} did not report local-only`);
  record(value?.cloudAi === false, `${label} did not deny cloud AI`);
  record(value?.networkAttempted === false, `${label} attempted network access`);
  record(value?.downloadsAttempted === false, `${label} attempted a download`);
  record(value?.promptPathExposed === false, `${label} exposed the prompt path`);
  record(value?.promptDeletedAfterRun === true, `${label} did not delete the prompt file`);
  record(value?.modelOutputGrounded === true, `${label} did not core-ground model output`);
  record(
    value?.groundingMethod === "core-lexical-overlap-speaker-aware",
    `${label} returned the wrong grounding method`,
  );
  record(value?.citationsVerifiedFromOutput === true, `${label} returned no verified citations`);
}

function strictProofSatisfied() {
  return (
    failures.length === 0 &&
    !prerequisiteMissing &&
    invalidPrerequisites.length === 0 &&
    binaryLooksNative &&
    runtimeBundle.validated &&
    distributionArchiveVerified &&
    realGguf &&
    status?.ready === true &&
    status?.modelHashVerified === true &&
    status?.binaryHashVerified === true &&
    status?.localOnly === true &&
    status?.cloudAi === false &&
    inferenceAttempted &&
    recapQuality?.ok === true &&
    askQuality?.ok === true &&
    recap?.networkAttempted === false &&
    ask?.networkAttempted === false &&
    recap?.downloadsAttempted === false &&
    ask?.downloadsAttempted === false &&
    schedulerAfter?.active === false &&
    schedulerAfter?.whisperLlmConcurrent === false &&
    !rawPathExposed
  );
}

function writeProofArtifact() {
  const strictRealModelSatisfied = strictProofSatisfied();
  const allowedMissingSatisfied =
    allowMissing && prerequisiteMissing && invalidPrerequisites.length === 0;
  const summary = {
    ok: strictRealModelSatisfied,
    proofKind: "m4-real-local-instruct-proof",
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    allowMissing,
    allowMissingAccepted: allowedMissingSatisfied,
    prerequisiteMissing,
    missingPrerequisites,
    invalidPrerequisites,
    fixture: false,
    realBinary:
      binaryLooksNative &&
      runtimeBundle.validated &&
      distributionArchiveVerified &&
      status?.ready === true,
    realModel: realGguf && status?.modelHashVerified === true,
    realGguf,
    strictRealModelSatisfied,
    inferenceAttempted,
    minimumBinaryBytes,
    modularLauncherThresholdBytes,
    minimumModelBytes,
    binaryBytes,
    binaryHeaderValid,
    modelBytes,
    modelHasGgufMagic,
    runtimeBundle: sanitizeForArtifact(runtimeBundle),
    distributionArchive: {
      configured: Boolean(distributionArchivePath),
      bytes: distributionArchiveBytes,
      expectedSha256: expectedDistributionSha256 || null,
      actualSha256: actualDistributionSha256,
      verified: distributionArchiveVerified,
      rawPathExposed: false,
    },
    localOnly: status?.localOnly === true && recap?.localOnly === true && ask?.localOnly === true,
    cloudAi: status?.cloudAi === true || recap?.cloudAi === true || ask?.cloudAi === true,
    ready: status?.ready === true,
    generationImplemented: status?.generationImplemented === true,
    recapImplemented: status?.recapImplemented === true,
    askImplemented: status?.askImplemented === true,
    modelHashRequired: status?.modelHashRequired === true,
    modelHashVerified: status?.modelHashVerified === true,
    binaryHashRequired: status?.binaryHashRequired === true,
    binaryHashVerified: status?.binaryHashVerified === true,
    manualInstallOnly: status?.downloadPolicy === "manual-install-only",
    backgroundDownloads: status?.backgroundDownloads === true,
    networkAttempted: recap?.networkAttempted === true || ask?.networkAttempted === true,
    networkBoundaryVerified: false,
    downloadsAttempted: recap?.downloadsAttempted === true || ask?.downloadsAttempted === true,
    promptDeletedAfterRun:
      recap?.promptDeletedAfterRun === true && ask?.promptDeletedAfterRun === true,
    recapQualityOk: recapQuality?.ok === true,
    askQualityOk: askQuality?.ok === true,
    schedulerActiveAfter: schedulerAfter?.active === true,
    whisperLlmConcurrent: schedulerAfter?.whisperLlmConcurrent === true,
    rawPathExposed,
    keyMaterialExposedToRenderer: false,
    observations,
    failures,
    recapQuality,
    askQuality,
    status: sanitizeForArtifact(status),
    recap: sanitizeForArtifact(recap),
    ask: sanitizeForArtifact(ask),
  };
  mkdirSync(path.dirname(proofPath), { recursive: true });
  writeFileSync(proofPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return summary;
}

function runSelfTest() {
  const recapFixture = {
    recapMarkdown: [
      "## Summary",
      "Candor keeps the recorder local-only until the release checklist is complete. [s0]",
      "## Decisions",
      "Embeddings remain deferred until the core workflow is proven. [s3]",
      "## Actions",
      "Priya validates the Windows installer signature and offline replay. [s1]",
      "## Risks",
      "Crash recovery loss beyond one chunk blocks release. [s2]",
    ].join("\n"),
    citationsVerifiedFromOutput: true,
    citations: ["s0", "s1", "s2", "s3"].map((citationId) => ({ citationId })),
  };
  const askFixture = {
    answer: "Priya must validate the Windows installer signature and offline replay before Friday. [s1]",
    citationsVerifiedFromOutput: true,
    citations: [{ citationId: "s1" }],
  };
  const badFixture = {
    output: "I do not know.",
    citationsVerifiedFromOutput: false,
    citations: [],
  };

  const validRecap = evaluateRecap(recapFixture);
  const validAsk = evaluateAsk(askFixture);
  const invalidRecap = evaluateRecap(badFixture);
  const invalidAsk = evaluateAsk(badFixture);
  const sanitized = sanitizeForArtifact({ localPath: dataDir });
  const peFixture = Buffer.alloc(256);
  peFixture.write("MZ", 0, "ascii");
  peFixture.writeUInt32LE(0x80, 0x3c);
  peFixture.write("PE\0\0", 0x80, "binary");
  const elfFixture = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01]);
  const machoFixture = Buffer.from([0xfe, 0xed, 0xfa, 0xcf]);

  const selfTestFailures = [];
  if (!validRecap.ok) selfTestFailures.push("known-good recap did not pass quality checks");
  if (!validAsk.ok) selfTestFailures.push("known-good Ask answer did not pass quality checks");
  if (invalidRecap.ok) selfTestFailures.push("uncited recap incorrectly passed quality checks");
  if (invalidAsk.ok) selfTestFailures.push("irrelevant Ask answer incorrectly passed quality checks");
  if (JSON.stringify(sanitized).includes(dataDir)) {
    selfTestFailures.push("artifact sanitizer retained a local path");
  }
  if (!nativeHeaderValid(peFixture, "win32")) {
    selfTestFailures.push("valid PE fixture failed native header validation");
  }
  if (!nativeHeaderValid(elfFixture, "linux")) {
    selfTestFailures.push("valid ELF fixture failed native header validation");
  }
  if (!nativeHeaderValid(machoFixture, "darwin")) {
    selfTestFailures.push("valid Mach-O fixture failed native header validation");
  }
  if (nativeHeaderValid(Buffer.alloc(256), "win32")) {
    selfTestFailures.push("invalid native fixture passed header validation");
  }

  rmSync(dataDir, { recursive: true, force: true });
  if (selfTestFailures.length > 0) {
    for (const failure of selfTestFailures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log("M4 real local instruct proof self-test passed.");
  process.exit(0);
}

if (selfTest) runSelfTest();

if (prerequisiteMissing || invalidPrerequisites.length > 0) {
  if (!allowMissing || invalidPrerequisites.length > 0) {
    failures.push(...missingPrerequisites, ...invalidPrerequisites);
  } else {
    observations.push("real local model prerequisites are missing; strict proof was not attempted");
  }
  rmSync(dataDir, { recursive: true, force: true });
  const summary = writeProofArtifact();
  if (summary.allowMissingAccepted) {
    console.log(`M4 real local instruct proof recorded missing prerequisites at ${proofPath}.`);
    process.exit(0);
  }
  console.error(`M4 real local instruct proof could not run. Proof written to ${proofPath}.`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

try {
  const core = spawnCore();
  const call = makeRpc(core);

  status = await call("ai.instructStatus");
  assertPathless(status, "AI instruct status");
  record(status?.ready === true, "real local instruct status was not ready");
  record(status?.generationImplemented === true, "local generation is not implemented");
  record(status?.recapImplemented === true, "local recap is not implemented");
  record(status?.askImplemented === true, "local Ask is not implemented");
  record(status?.localOnly === true, "instruct status did not report local-only");
  record(status?.cloudAi === false, "instruct status did not deny cloud AI");
  record(status?.modelHashRequired === true, "instruct status did not require a model hash");
  record(status?.modelHashVerified === true, "instruct status did not verify the model hash");
  record(status?.binaryHashRequired === true, "instruct status did not require a binary hash");
  record(status?.binaryHashVerified === true, "instruct status did not verify the binary hash");
  record(status?.modelBytes >= minimumModelBytes, "instruct status reported a model below the real-model threshold");
  record(status?.downloadPolicy === "manual-install-only", "instruct status allowed automatic model download");
  record(status?.backgroundDownloads === false, "instruct status allowed background downloads");

  const recordingId = await seedRecording(call);
  inferenceAttempted = true;
  recap = await call("ai.recapInstruct", { recordingId, maxTokens: 320 });
  assertInstructResult(recap, "AI instruct recap", "recap");
  recapQuality = evaluateRecap(recap);
  record(recapQuality.ok, "real local recap did not satisfy deterministic quality checks");

  ask = await call("ai.askInstruct", {
    recordingId,
    question: "What must Priya validate before Friday?",
    maxTokens: 128,
  });
  assertInstructResult(ask, "AI instruct Ask", "ask");
  askQuality = evaluateAsk(ask);
  record(askQuality.ok, "real local Ask did not satisfy deterministic quality checks");

  schedulerAfter = await call("ai.schedulerStatus");
  assertPathless(schedulerAfter, "scheduler after real local instruct runs");
  record(schedulerAfter?.active === false, "scheduler stayed active after local inference");
  record(
    schedulerAfter?.whisperLlmConcurrent === false,
    "scheduler allowed Whisper and LLM inference concurrently",
  );

  observations.push("real hash-pinned GGUF completed local recap and Ask inference");
  await call("core.shutdown");
} catch (error) {
  fail(safeError(error));
} finally {
  if (child && !child.killed) child.kill();
  rmSync(dataDir, { recursive: true, force: true });
}

const summary = writeProofArtifact();
if (!summary.strictRealModelSatisfied) {
  console.error(`M4 real local instruct proof failed. Proof written to ${proofPath}.`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`M4 real local instruct proof passed. Proof written to ${proofPath}.`);
