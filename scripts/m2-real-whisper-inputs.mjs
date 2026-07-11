import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");
const recordOnly = process.argv.includes("--record-only");
const modelManagerPath = join(repoRoot, "crates", "candor-core", "src", "model_manager.rs");
const defaultAudioFixturePath = join(
  repoRoot,
  "release-v3",
  "fixtures",
  `m2-real-whisper-fixture-${process.platform}-${process.arch}.wav`,
);

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function outputPath() {
  return resolve(
    repoRoot,
    argValue(
      "--write",
      join("release-v3", "proofs", `m2-real-whisper-inputs-${process.platform}-${process.arch}.json`),
    ),
  );
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseModelSpecs() {
  const source = readFileSync(modelManagerPath, "utf8");
  const constants = new Map();
  const constantPattern =
    /const\s+(HASH_[A-Z0-9_]+):\s*&str\s*=\s*match\s+option_env!\("([^"]+)"\)\s*\{[\s\S]*?None\s*=>\s*"([A-Fa-f0-9]{64})"/g;
  for (const match of source.matchAll(constantPattern)) {
    const [, name, envName, fallback] = match;
    constants.set(name, {
      envName,
      sha256: process.env[envName] || fallback,
    });
  }

  const specs = new Map();
  const specPattern =
    /ModelSpec\s*\{\s*id:\s*"([^"]+)",\s*expected_sha256:\s*(HASH_[A-Z0-9_]+),\s*language:\s*"([^"]+)",\s*role:\s*"([^"]+)"/g;
  for (const match of source.matchAll(specPattern)) {
    const [, id, constantName, language, role] = match;
    const constant = constants.get(constantName);
    if (!constant) continue;
    specs.set(id, {
      modelId: id,
      expectedSha256: constant.sha256,
      hashEnvName: constant.envName,
      language,
      role,
    });
  }
  return specs;
}

async function sha256File(path) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectHash);
    stream.on("end", () => resolveHash(hash.digest("hex").toUpperCase()));
  });
}

function localFileStatus(pathValue, label) {
  if (!pathValue) {
    return {
      configured: false,
      exists: false,
      readableFile: false,
      bytes: 0,
      issue: `${label} path is not configured`,
    };
  }
  const resolved = resolve(pathValue);
  if (!existsSync(resolved)) {
    return {
      configured: true,
      exists: false,
      readableFile: false,
      bytes: 0,
      issue: `${label} file does not exist`,
    };
  }
  const stat = statSync(resolved);
  return {
    configured: true,
    exists: true,
    readableFile: stat.isFile(),
    bytes: stat.isFile() ? stat.size : 0,
    issue: stat.isFile() ? null : `${label} path is not a file`,
  };
}

function parseWavPcm16(pathValue) {
  const bytes = readFileSync(pathValue);
  if (bytes.length < 44 || bytes.subarray(0, 4).toString("ascii") !== "RIFF") {
    return { ok: false, issue: "audio fixture must be a RIFF WAV file" };
  }
  if (bytes.subarray(8, 12).toString("ascii") !== "WAVE") {
    return { ok: false, issue: "audio fixture must be a WAVE file" };
  }

  let offset = 12;
  let format = null;
  let dataBytes = 0;
  while (offset + 8 <= bytes.length) {
    const id = bytes.subarray(offset, offset + 4).toString("ascii");
    const size = bytes.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + size;
    if (chunkEnd > bytes.length) {
      return { ok: false, issue: "audio fixture has a truncated WAV chunk" };
    }
    if (id === "fmt ") {
      if (size < 16) return { ok: false, issue: "audio fixture fmt chunk is too small" };
      format = {
        audioFormat: bytes.readUInt16LE(chunkStart),
        channelCount: bytes.readUInt16LE(chunkStart + 2),
        sampleRateHz: bytes.readUInt32LE(chunkStart + 4),
        bitsPerSample: bytes.readUInt16LE(chunkStart + 14),
      };
    } else if (id === "data") {
      dataBytes = size;
    }
    offset = chunkEnd + (size % 2);
  }

  if (!format) return { ok: false, issue: "audio fixture is missing fmt chunk" };
  if (dataBytes === 0) return { ok: false, issue: "audio fixture is missing nonempty data chunk" };
  if (format.audioFormat !== 1) return { ok: false, issue: "audio fixture must be PCM" };
  if (format.bitsPerSample !== 16) return { ok: false, issue: "audio fixture must be PCM 16-bit" };
  if (format.sampleRateHz <= 0 || format.channelCount <= 0) {
    return { ok: false, issue: "audio fixture has an invalid sample rate or channel count" };
  }
  const frameBytes = format.channelCount * 2;
  if (dataBytes % frameBytes !== 0) {
    return { ok: false, issue: "audio fixture data must align to PCM frames" };
  }

  return {
    ok: true,
    ...format,
    dataBytes,
    durationMs: Math.round((dataBytes / frameBytes / format.sampleRateHz) * 1000),
  };
}

const modelId = argValue("--model-id", process.env.CANDOR_M2_REAL_MODEL_ID ?? "base.en");
const modelPath = argValue("--model", process.env.CANDOR_M2_REAL_MODEL_PATH ?? null);
const audioPath = argValue(
  "--audio",
  process.env.CANDOR_M2_REAL_AUDIO_WAV ?? (existsSync(defaultAudioFixturePath) ? defaultAudioFixturePath : null),
);
const expectedTextConfigured = Boolean(argValue("--expect-text", process.env.CANDOR_M2_REAL_EXPECT_TEXT ?? null));
const specs = parseModelSpecs();
const spec = specs.get(modelId);
const failures = [];

const model = {
  configured: Boolean(modelPath),
  modelId,
  allowlisted: Boolean(spec),
  expectedSha256: spec?.expectedSha256 ?? null,
  hashEnvName: spec?.hashEnvName ?? null,
  hashMatched: false,
  bytes: 0,
  sourcePathRecorded: false,
};

if (!spec) {
  failures.push("model id is not in the Candor local Whisper allowlist");
} else {
  const status = localFileStatus(modelPath, "model");
  model.configured = status.configured;
  model.exists = status.exists;
  model.readableFile = status.readableFile;
  model.bytes = status.bytes;
  if (status.issue) failures.push(status.issue);
  if (status.readableFile) {
    model.actualSha256 = await sha256File(resolve(modelPath));
    model.hashMatched = model.actualSha256.toUpperCase() === spec.expectedSha256.toUpperCase();
    if (!model.hashMatched) {
      failures.push("model SHA-256 does not match the trusted Candor pin");
    }
  }
}

const audio = {
  configured: Boolean(audioPath),
  sourcePathRecorded: false,
};
const audioStatus = localFileStatus(audioPath, "audio");
audio.exists = audioStatus.exists;
audio.readableFile = audioStatus.readableFile;
audio.bytes = audioStatus.bytes;
if (audioStatus.issue) failures.push(audioStatus.issue);
if (audioStatus.readableFile) {
  const wav = parseWavPcm16(resolve(audioPath));
  Object.assign(audio, wav);
  if (!wav.ok) failures.push(wav.issue);
}

const ready = failures.length === 0;
const proof = {
  ok: recordOnly || ready,
  proofKind: "m2-real-whisper-inputs",
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  recordOnly,
  ready,
  localOnly: true,
  cloudAi: false,
  downloadsAttempted: false,
  model,
  audio,
  expectedTextConfigured,
  rawPathExposed: false,
  keyMaterialExposedToRenderer: false,
  failures,
};

const path = outputPath();
writeJson(path, proof);

if (ready) {
  console.log(`M2 real Whisper inputs are ready. Proof written to ${path}.`);
} else {
  console.error(`M2 real Whisper inputs are not ready. Proof written to ${path}.`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
}

if (!proof.ok) {
  process.exit(1);
}
