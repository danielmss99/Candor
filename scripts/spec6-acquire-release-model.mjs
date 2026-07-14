import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = path.join(repoRoot, "third_party", "model-lock.json");
const args = process.argv.slice(2);
const assetIndex = args.indexOf("--asset");
const dryRun = args.includes("--dry-run");
const releaseOperator = args.includes("--release-operator");
const requestedId = assetIndex >= 0 ? args[assetIndex + 1] : null;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const REVISION_PATTERN = /^[a-f0-9]{40}$/i;

if (!requestedId) {
  throw new Error("Usage: node scripts/spec6-acquire-release-model.mjs --asset <locked-model-id> [--dry-run | --release-operator]");
}
if (!dryRun && !releaseOperator) {
  throw new Error("Release model acquisition requires the explicit --release-operator acknowledgement");
}

const lock = JSON.parse(readFileSync(lockPath, "utf8"));
const speech = (lock.speech?.candidates ?? []).map((candidate) => ({ ...candidate, capability: "speech" }));
const language = (lock.language?.candidates ?? []).map((candidate) => ({ ...candidate, capability: "language" }));
const candidate = [...speech, ...language].find((entry) => entry.id === requestedId);
if (!candidate) throw new Error(`Model ${requestedId} is not present in third_party/model-lock.json`);
if (!SHA256_PATTERN.test(candidate.expectedSha256 ?? "") || !Number.isSafeInteger(candidate.bytes) || candidate.bytes <= 0) {
  throw new Error(`Model ${requestedId} does not yet have an exact digest and byte count`);
}
if (!REVISION_PATTERN.test(candidate.revision ?? "")) {
  throw new Error(`Model ${requestedId} is not pinned to an immutable 40-character revision`);
}

const source = new URL(candidate.sourceUrl);
if (source.protocol !== "https:" || source.hostname !== "huggingface.co") {
  throw new Error(`Model ${requestedId} does not use the approved HTTPS acquisition host`);
}
const filename = candidate.filename
  ?? (candidate.capability === "speech" ? `ggml-${candidate.id}.bin` : null);
if (!filename || !/^[A-Za-z0-9._-]+$/.test(filename)) {
  throw new Error(`Model ${requestedId} does not define a safe release filename`);
}
const downloadUrl = new URL(`${source.pathname.replace(/\/$/, "")}/resolve/${candidate.revision}/${filename}`, source);
const destinationDirectory = path.join(
  repoRoot,
  "build",
  "ai-bundle",
  "assets",
  "models",
  candidate.capability === "speech" ? "whisper" : "llama",
);
const destination = path.join(destinationDirectory, filename);
const temporary = `${destination}.part`;

if (dryRun) {
  process.stdout.write(`${JSON.stringify({
    asset: requestedId,
    source: downloadUrl.href,
    destination: path.relative(repoRoot, destination).replaceAll("\\", "/"),
    expectedBytes: candidate.bytes,
    expectedSha256: candidate.expectedSha256,
    releaseReadyChanged: false,
  }, null, 2)}\n`);
  process.exit(0);
}

mkdirSync(destinationDirectory, { recursive: true });
if (existsSync(destination)) {
  await verifyCompleteFile(destination, candidate);
  process.stdout.write(`${requestedId} is already present and verified.\n`);
  process.exit(0);
}

let offset = existsSync(temporary) ? statSync(temporary).size : 0;
if (offset === candidate.bytes) {
  try {
    await verifyCompleteFile(temporary, candidate);
    renameSync(temporary, destination);
    process.stdout.write(`${requestedId} resumed from a complete verified temporary file.\n`);
    process.exit(0);
  } catch {
    rmSync(temporary, { force: true });
    offset = 0;
  }
}
if (offset > candidate.bytes) {
  rmSync(temporary, { force: true });
  offset = 0;
}
const headers = offset > 0 ? { Range: `bytes=${offset}-` } : {};
const response = await fetch(downloadUrl, { headers, redirect: "follow" });
if (!response.ok || !response.body) {
  throw new Error(`Release acquisition failed with HTTP ${response.status}`);
}
if (new URL(response.url).protocol !== "https:") {
  throw new Error("Release acquisition followed a non-HTTPS redirect");
}
if (offset > 0 && response.status !== 206) {
  rmSync(temporary, { force: true });
  offset = 0;
}
await pipeline(response.body, createWriteStream(temporary, { flags: offset > 0 ? "a" : "w" }));

try {
  await verifyCompleteFile(temporary, candidate);
} catch (error) {
  if (existsSync(temporary) && statSync(temporary).size >= candidate.bytes) {
    rmSync(temporary, { force: true });
  }
  throw error;
}
renameSync(temporary, destination);
process.stdout.write(`${requestedId} acquired, verified, and atomically promoted.\n`);

async function verifyCompleteFile(filePath, expected) {
  const state = statSync(filePath);
  if (!state.isFile() || state.size !== expected.bytes) {
    throw new Error(`Model ${expected.id} byte count mismatch: expected ${expected.bytes}, received ${state.size}`);
  }
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  const actual = digest.digest("hex");
  if (actual.toLowerCase() !== expected.expectedSha256.toLowerCase()) {
    throw new Error(`Model ${expected.id} SHA-256 mismatch`);
  }
}
