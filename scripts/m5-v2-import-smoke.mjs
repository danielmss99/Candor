import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
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

const dataDir = mkdtempSync(path.join(tmpdir(), "candor-v3-m5-import-data-"));
const sourceDir = mkdtempSync(path.join(tmpdir(), "candor-v2-source-"));
mkdirSync(path.join(sourceDir, "audio"));

function fixtureWav() {
  const sampleRate = 16000;
  const channels = 1;
  const bitsPerSample = 16;
  const pcm = Buffer.alloc(sampleRate * 2 / 10);
  const dataLen = pcm.length;
  const wav = Buffer.alloc(44 + dataLen);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataLen, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, 28);
  wav.writeUInt16LE(channels * bitsPerSample / 8, 32);
  wav.writeUInt16LE(bitsPerSample, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataLen, 40);
  pcm.copy(wav, 44);
  return wav;
}

const markdownPath = path.join(sourceDir, "strategy-sync.md");
const markdown = `---
title: Imported Strategy Sync
audio_path: audio/strategy.wav
---

# My notes

Keep the v2 import proof local.

# Transcript

\`00:00\` [Alex] Decision: import v2 notes without touching originals.
\`00:02\` [Priya] Action: Priya to verify the pathless import proof by Friday.
`;
writeFileSync(markdownPath, markdown, "utf8");
writeFileSync(path.join(sourceDir, "audio", "strategy.wav"), fixtureWav());

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
    }, 10000);
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
  if (serialized.includes(dataDir) || serialized.includes(sourceDir)) {
    throw new Error(`${label} exposed a local filesystem path`);
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

function assertImport(result, label) {
  assertCustody(result, label);
  if (
    result?.localOnly !== true ||
    result?.cloudAi !== false ||
    result?.originalsUntouched !== true ||
    result?.importedCount !== 1 ||
    result?.audioImportedCount !== 1 ||
    result?.recordings?.[0]?.transcriptSegmentCount !== 2
  ) {
    throw new Error(`${label} did not report the expected import facts`);
  }
  if (
    !result?.vaultIndex ||
    typeof result.vaultIndex.indexedImportedCount !== "number" ||
    result?.recordings?.[0]?.vaultIndex?.backend !== "sqlcipher" ||
    result?.recordings?.[0]?.vaultIndex?.rawPathExposed !== false
  ) {
    throw new Error(`${label} did not report vault index facts`);
  }
}

try {
  const status = await call("import.v2.status");
  assertCustody(status, "v2 import status");
  if (
    status?.implemented !== true ||
    status?.rendererRawPathAccess !== false ||
    status?.originalsUntouched !== true ||
    status?.pcmWavAudioImport !== true
  ) {
    throw new Error("v2 import status did not report the local pathless contract");
  }

  const before = readFileSync(markdownPath, "utf8");
  const result = await call("import.v2.fromFolder", { sourcePath: sourceDir });
  const after = readFileSync(markdownPath, "utf8");
  if (before !== after) {
    throw new Error("v2 import modified the source markdown");
  }
  assertImport(result, "v2 folder import");

  const proof = await call("import.v2.proofSynthetic", {});
  assertImport(proof, "v2 proof import");

  const list = await call("recording.durable.list");
  assertCustody(list, "recording list after import");
  if ((list?.recordings?.length ?? 0) < 2) {
    throw new Error("imported recordings were not present in the local library");
  }

  await call("core.shutdown");
  console.log("M5 v2 import smoke passed.");
} finally {
  if (!child.killed) child.kill();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(sourceDir, { recursive: true, force: true });
}
