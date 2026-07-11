import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");
const recordOnly = process.argv.includes("--record-only");
const defaultPhrase = "candor local whisper proof phrase one two three";

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function asPath(pathValue) {
  return resolve(repoRoot, pathValue);
}

function rel(pathValue) {
  return relative(repoRoot, pathValue).replaceAll("\\", "/");
}

function sha256(pathValue) {
  const hash = createHash("sha256");
  hash.update(readFileSync(pathValue));
  return hash.digest("hex").toUpperCase();
}

function writeJson(pathValue, value) {
  mkdirSync(dirname(pathValue), { recursive: true });
  writeFileSync(pathValue, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseWavPcm16(pathValue) {
  if (!existsSync(pathValue) || !statSync(pathValue).isFile()) {
    return { ok: false, issue: "audio fixture file does not exist" };
  }
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

function writeToneFixture(pathValue) {
  const sampleRateHz = 16000;
  const durationSeconds = 3;
  const sampleCount = sampleRateHz * durationSeconds;
  const dataBytes = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataBytes);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRateHz, 24);
  buffer.writeUInt32LE(sampleRateHz * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);

  for (let index = 0; index < sampleCount; index += 1) {
    const t = index / sampleRateHz;
    const sample = Math.round(Math.sin(2 * Math.PI * 440 * t) * 9000);
    buffer.writeInt16LE(sample, 44 + index * 2);
  }

  mkdirSync(dirname(pathValue), { recursive: true });
  writeFileSync(pathValue, buffer);
}

function generateWindowsSpeech(pathValue, phrase) {
  const script = [
    "Add-Type -AssemblyName System.Speech",
    "$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    "$synth.Rate = 0",
    "$synth.Volume = 100",
    "$synth.SetOutputToWaveFile($env:CANDOR_TTS_WAV)",
    "$synth.Speak($env:CANDOR_TTS_PHRASE)",
    "$synth.Dispose()",
  ].join("; ");
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      cwd: repoRoot,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
        CANDOR_TTS_WAV: pathValue,
        CANDOR_TTS_PHRASE: phrase,
      },
    },
  );
  return {
    ok: result.status === 0,
    status: result.status ?? 1,
    stderr: result.stderr?.trim() ?? "",
  };
}

function generateMacSpeech(pathValue, phrase) {
  const result = spawnSync(
    "say",
    ["--file-format=WAVE", "--data-format=LEI16@16000", "-o", pathValue, phrase],
    {
      cwd: repoRoot,
      encoding: "utf8",
      shell: false,
    },
  );
  return {
    ok: result.status === 0,
    status: result.status ?? 1,
    stderr: result.stderr?.trim() ?? "",
  };
}

function generateLinuxSpeech(pathValue, phrase) {
  const result = spawnSync("espeak", ["-w", pathValue, phrase], {
    cwd: repoRoot,
    encoding: "utf8",
    shell: false,
  });
  return {
    ok: result.status === 0,
    status: result.status ?? 1,
    stderr: result.stderr?.trim() ?? "",
  };
}

function generateSpeech(pathValue, phrase) {
  if (process.platform === "win32") return { method: "windows-sapi", ...generateWindowsSpeech(pathValue, phrase) };
  if (process.platform === "darwin") return { method: "macos-say", ...generateMacSpeech(pathValue, phrase) };
  if (process.platform === "linux") return { method: "linux-espeak", ...generateLinuxSpeech(pathValue, phrase) };
  return { method: "unsupported-platform", ok: false, status: 1, stderr: "unsupported platform" };
}

const phrase = argValue("--phrase", process.env.CANDOR_M2_REAL_EXPECT_TEXT ?? defaultPhrase);
const audioPath = asPath(
  argValue(
    "--audio",
    join("release-v3", "fixtures", `m2-real-whisper-fixture-${process.platform}-${process.arch}.wav`),
  ),
);
const proofPath = asPath(
  argValue(
    "--write",
    join("release-v3", "proofs", `m2-local-wav-fixture-${process.platform}-${process.arch}.json`),
  ),
);
const failures = [];
let method = "not-generated";
let speechFixture = false;
let generator = null;

if (!recordOnly) {
  mkdirSync(dirname(audioPath), { recursive: true });
  generator = generateSpeech(audioPath, phrase);
  method = generator.method;
  speechFixture = generator.ok === true;
  if (!generator.ok) {
    writeToneFixture(audioPath);
    method = "fallback-tone";
    speechFixture = false;
    failures.push("local speech synthesis was unavailable, wrote a fallback tone fixture");
  }
}

const wav = parseWavPcm16(audioPath);
if (!wav.ok) failures.push(wav.issue);

const ok = wav.ok === true && existsSync(audioPath);
const proof = {
  ok: recordOnly || ok,
  proofKind: "m2-local-wav-fixture",
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  recordOnly,
  localOnly: true,
  cloudAi: false,
  downloadsAttempted: false,
  method,
  speechFixture,
  suitableForStrictInference: speechFixture && wav.ok === true,
  expectedText: phrase,
  audio: {
    file: rel(audioPath),
    exists: existsSync(audioPath),
    bytes: existsSync(audioPath) ? statSync(audioPath).size : 0,
    sha256: existsSync(audioPath) ? sha256(audioPath) : null,
    ...wav,
  },
  rawPathExposed: false,
  keyMaterialExposedToRenderer: false,
  failures,
};

writeJson(proofPath, proof);

if (proof.ok) {
  console.log(`M2 local WAV fixture proof written to ${rel(proofPath)}.`);
  console.log(`M2 local WAV fixture audio written to ${rel(audioPath)}.`);
} else {
  console.error(`M2 local WAV fixture is not ready. Proof written to ${rel(proofPath)}.`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
}

if (!proof.ok) process.exit(1);
