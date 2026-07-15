import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildRoot = path.join(repoRoot, "build");
const bundleRoot = path.join(buildRoot, "ai-bundle-local");
const cacheRoot = path.join(buildRoot, "ai-bundle-cache");
const stagingRoot = path.join(buildRoot, `ai-bundle-local.installing-${process.pid}`);
const modelLock = JSON.parse(readFileSync(path.join(repoRoot, "third_party", "model-lock.json"), "utf8"));
const runtimeLock = JSON.parse(readFileSync(path.join(repoRoot, "third_party", "runtime-lock.json"), "utf8"));
const acknowledgement = process.argv.includes("--acknowledge-local-development");
const expectedModelIds = ["large-v3-turbo", "small", "qwen3-4b-official-q4_k_m"];
const expectedNoticeIds = [
  "whisper-runtime-license",
  "whisper-model-card",
  "llama-runtime-license",
  "qwen-model-license",
  "qwen-model-card",
];
const openLicenses = new Set(["MIT", "Apache-2.0"]);

if (!acknowledgement) {
  throw new Error("Pass --acknowledge-local-development to install the non-release local AI bundle");
}
if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("The development bundle installer currently supports Windows x64 only");
}

const speechCandidates = modelLock.speech?.candidates ?? [];
const languageCandidates = modelLock.language?.candidates ?? [];
const candidates = [...speechCandidates, ...languageCandidates];
const selectedModels = expectedModelIds.map((id) => {
  const candidate = candidates.find((entry) => entry.id === id);
  if (!candidate) throw new Error(`Locked model ${id} is unavailable`);
  validateLockedModel(candidate);
  return candidate;
});
const languageRuntime = runtimeLock.runtimes?.find((entry) => entry.id === "language-runtime");
const notices = expectedNoticeIds.map((id) => {
  const notice = runtimeLock.notices?.find((entry) => entry.id === id);
  if (!notice) throw new Error(`Pinned notice ${id} is unavailable`);
  validateDownload(notice);
  if (notice.bytes > 2 * 1024 * 1024) throw new Error(`Pinned notice ${id} is too large`);
  return notice;
});
const runtimeArtifact = languageRuntime?.artifacts?.find(
  (entry) => entry.platform === process.platform && entry.arch === process.arch,
);
if (!languageRuntime || !runtimeArtifact) {
  throw new Error("The pinned Windows x64 llama.cpp artifact is unavailable");
}
validateDownload(runtimeArtifact);

process.stdout.write([
  "Candor local AI development installation",
  "This installs verified local assets for this workstation only.",
  "It does not mark Candor release-ready or satisfy signing and hardware release gates.",
  "",
].join("\n"));

rmSync(stagingRoot, { recursive: true, force: true });
mkdirSync(stagingRoot, { recursive: true });
mkdirSync(cacheRoot, { recursive: true });

try {
  const modelAssets = [];
  for (const candidate of selectedModels) {
    const filename = candidate.filename ?? `ggml-${candidate.id}.bin`;
    const url = modelDownloadUrl(candidate, filename);
    const cached = await acquireVerifiedFile({
      id: candidate.id,
      url,
      filename,
      bytes: candidate.bytes,
      sha256: candidate.expectedSha256,
    });
    const capability = candidate.id.startsWith("qwen") ? "language" : "speech";
    const modelDirectory = capability === "speech" ? "whisper" : "llama";
    const relativePath = `assets/models/${modelDirectory}/${filename}`;
    const target = path.join(stagingRoot, ...relativePath.split("/"));
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(cached, target);
    modelAssets.push({ candidate, capability, relativePath, url });
  }

  const archive = await acquireVerifiedFile({
    id: "llama.cpp-windows-x64",
    url: runtimeArtifact.sourceUrl,
    filename: runtimeArtifact.filename,
    bytes: runtimeArtifact.bytes,
    sha256: runtimeArtifact.sha256,
  });
  const runtimeFiles = extractVerifiedRuntimeArchive(archive);
  await installNotices();

  const manifestAssets = [
    ...modelAssets.map(({ candidate, capability, relativePath, url }) => ({
      id: `${capability}-model-${safeId(candidate.id)}`,
      capability,
      kind: "model",
      engine: capability === "speech" ? "whisper.cpp" : "llama.cpp",
      relativePath,
      sha256: candidate.expectedSha256.toLowerCase(),
      bytes: candidate.bytes,
      licenseFile: capability === "speech"
        ? "notices/whisper.cpp-LICENSE.txt"
        : "notices/qwen3-LICENSE.txt",
      licenseExpression: candidate.licenseExpression,
      sourceUrl: url,
      revision: candidate.revision,
      redistributionApproved: true,
      required: true,
      modelId: candidate.id,
      modelCard: capability === "speech"
        ? "notices/whisper.cpp-model-card.md"
        : "notices/qwen3-model-card.md",
      ...(capability === "language" ? { contextTokens: 8192 } : {}),
    })),
    ...runtimeFiles.map((file) => ({
      id: file.name === "llama-completion.exe" ? "language-runtime-llama-completion" : `language-library-${safeId(file.name)}`,
      capability: "language",
      kind: file.name === "llama-completion.exe" ? "runtime" : "library",
      engine: "llama.cpp",
      relativePath: file.relativePath,
      sha256: file.sha256,
      bytes: file.bytes,
      licenseFile: "notices/llama.cpp-LICENSE.txt",
      licenseExpression: languageRuntime.licenseExpression,
      sourceUrl: runtimeArtifact.sourceUrl,
      revision: languageRuntime.commit,
      redistributionApproved: true,
      required: true,
      platform: "win32",
      arch: "x64",
    })),
  ];
  const manifest = {
    manifestVersion: 1,
    bundleVersion: `development-${new Date().toISOString().slice(0, 10)}`,
    releaseReady: false,
    fixture: false,
    selectionStatus: "development-selected",
    packageProfile: "development-complete",
    repairPolicy: "signed-installer-only",
    assets: manifestAssets,
  };
  if (manifest.releaseReady !== false) throw new Error("Development bundle attempted a release-ready claim");
  const manifestTemporary = path.join(stagingRoot, "manifest.json.part");
  writeFileSync(manifestTemporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  renameSync(manifestTemporary, path.join(stagingRoot, "manifest.json"));

  runVerifier(stagingRoot, false, true);
  runVerifier(stagingRoot, true, false);
  const promotion = promoteBundle(stagingRoot, bundleRoot);
  try {
    runVerifier(bundleRoot, false, true);
    finalizePromotion(promotion);
  } catch (error) {
    rollbackPromotion(promotion);
    throw error;
  }
  rmSync(cacheRoot, { recursive: true, force: true });

  const installedBytes = manifestAssets.reduce((total, asset) => total + asset.bytes, 0);
  process.stdout.write([
    "",
    "Candor local AI development bundle is installed and verified.",
    `Installed assets: ${manifestAssets.length}`,
    `Installed payload: ${formatBytes(installedBytes)}`,
    "Public release readiness remains false by design.",
    "",
  ].join("\n"));
} catch (error) {
  rmSync(stagingRoot, { recursive: true, force: true });
  throw error;
}

function validateLockedModel(candidate) {
  validateDownload({
    filename: candidate.filename ?? `ggml-${candidate.id}.bin`,
    bytes: candidate.bytes,
    sha256: candidate.expectedSha256,
    sourceUrl: candidate.sourceUrl,
  });
  if (!/^[a-f0-9]{40}$/i.test(candidate.revision ?? "")) {
    throw new Error(`Model ${candidate.id} is not pinned to an immutable revision`);
  }
  if (!openLicenses.has(candidate.licenseExpression)) {
    throw new Error(`Model ${candidate.id} does not use an approved open-source license`);
  }
}

function validateDownload(value) {
  if (!Number.isSafeInteger(value.bytes) || value.bytes <= 0) throw new Error("Pinned byte count is invalid");
  if (!/^[a-f0-9]{64}$/i.test(value.sha256 ?? "") || /^0{64}$/i.test(value.sha256)) {
    throw new Error("Pinned SHA-256 is invalid");
  }
  const url = new URL(value.sourceUrl);
  if (url.protocol !== "https:") throw new Error("Asset source must use HTTPS");
  if (!/^[A-Za-z0-9._-]+$/.test(value.filename ?? "")) throw new Error("Asset filename is unsafe");
}

function modelDownloadUrl(candidate, filename) {
  const source = new URL(candidate.sourceUrl);
  if (source.protocol !== "https:" || source.hostname !== "huggingface.co") {
    throw new Error(`Model ${candidate.id} does not use the approved acquisition host`);
  }
  return new URL(`${source.pathname.replace(/\/$/, "")}/resolve/${candidate.revision}/${filename}`, source).href;
}

async function acquireVerifiedFile({ id, url, filename, bytes, sha256 }) {
  const finalPath = path.join(cacheRoot, filename);
  const temporaryPath = `${finalPath}.part`;
  mkdirSync(cacheRoot, { recursive: true });
  if (existsSync(finalPath)) {
    await verifyFile(finalPath, bytes, sha256, id);
    process.stdout.write(`${id}: using verified cache\n`);
    return finalPath;
  }

  let offset = existsSync(temporaryPath) ? statSync(temporaryPath).size : 0;
  if (offset > bytes) {
    rmSync(temporaryPath, { force: true });
    offset = 0;
  }
  process.stdout.write(`${id}: downloading ${formatBytes(bytes)}${offset > 0 ? ` from ${formatBytes(offset)}` : ""}\n`);
  const response = await fetch(url, {
    headers: offset > 0 ? { Range: `bytes=${offset}-` } : {},
    redirect: "follow",
  });
  if (!response.ok || !response.body) throw new Error(`${id} download failed with HTTP ${response.status}`);
  if (new URL(response.url).protocol !== "https:") throw new Error(`${id} followed a non-HTTPS redirect`);
  if (offset > 0 && response.status !== 206) {
    rmSync(temporaryPath, { force: true });
    offset = 0;
  }
  let received = offset;
  let lastReport = Date.now();
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > bytes) return callback(new Error(`${id} exceeded its pinned byte count`));
      if (Date.now() - lastReport >= 10_000) {
        process.stdout.write(`${id}: ${Math.floor((received / bytes) * 100)}% (${formatBytes(received)})\n`);
        lastReport = Date.now();
      }
      callback(null, chunk);
    },
  });
  await pipeline(response.body, meter, createWriteStream(temporaryPath, { flags: offset > 0 ? "a" : "w" }));
  await verifyFile(temporaryPath, bytes, sha256, id);
  renameSync(temporaryPath, finalPath);
  process.stdout.write(`${id}: verified\n`);
  return finalPath;
}

async function verifyFile(filePath, expectedBytes, expectedSha256, id) {
  const state = lstatSync(filePath);
  if (state.isSymbolicLink() || !state.isFile() || state.size !== expectedBytes) {
    throw new Error(`${id} byte count does not match its lock`);
  }
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  if (digest.digest("hex").toLowerCase() !== expectedSha256.toLowerCase()) {
    throw new Error(`${id} SHA-256 does not match its lock`);
  }
}

function extractVerifiedRuntimeArchive(archive) {
  const listed = spawnSync("tar.exe", ["-tf", archive], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
  if (listed.status !== 0) throw new Error(`Unable to inspect llama.cpp archive: ${listed.stderr}`);
  const entries = listed.stdout.split(/\r?\n/).filter(Boolean);
  for (const entry of entries) {
    if (entry !== path.basename(entry) || entry.includes("\\") || entry.includes(":") || entry === "." || entry === "..") {
      throw new Error(`Unsafe llama.cpp archive entry rejected: ${entry}`);
    }
  }
  const selected = entries.filter((entry) => entry === "llama-completion.exe" || entry.toLowerCase().endsWith(".dll"));
  if (!selected.includes("llama-completion.exe") || selected.length < 2) {
    throw new Error("Pinned llama.cpp archive is missing the completion frontend or runtime libraries");
  }
  const runtimeDirectory = path.join(stagingRoot, "assets", "runtime", "llama", "windows-x64");
  mkdirSync(runtimeDirectory, { recursive: true });
  const extracted = spawnSync("tar.exe", ["-xf", archive, "-C", runtimeDirectory, ...selected], {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  if (extracted.status !== 0) throw new Error(`Unable to extract llama.cpp archive: ${extracted.stderr}`);
  return selected.map((name) => {
    const filePath = path.join(runtimeDirectory, name);
    const state = lstatSync(filePath);
    if (state.isSymbolicLink() || !state.isFile() || state.size <= 0) {
      throw new Error(`Extracted llama.cpp file is unsafe: ${name}`);
    }
    return {
      name,
      relativePath: `assets/runtime/llama/windows-x64/${name}`,
      bytes: state.size,
      sha256: sha256File(filePath),
    };
  });
}

async function installNotices() {
  const noticeDirectory = path.join(stagingRoot, "notices");
  mkdirSync(noticeDirectory, { recursive: true });
  for (const notice of notices) {
    const response = await fetch(notice.sourceUrl, { redirect: "follow" });
    if (!response.ok) throw new Error(`Notice download failed for ${notice.filename}: HTTP ${response.status}`);
    if (new URL(response.url).protocol !== "https:") throw new Error(`${notice.filename} followed a non-HTTPS redirect`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const temporaryPath = path.join(noticeDirectory, `${notice.filename}.part`);
    const finalPath = path.join(noticeDirectory, notice.filename);
    writeFileSync(temporaryPath, bytes);
    await verifyFile(temporaryPath, notice.bytes, notice.sha256, notice.id);
    renameSync(temporaryPath, finalPath);
  }
}

function runVerifier(root, strict, shouldPass) {
  const args = [path.join(repoRoot, "scripts", "spec3-verify-ai-bundle.mjs"), "--root", root];
  if (strict) args.push("--require-ready");
  const result = spawnSync(process.execPath, args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  if (shouldPass && result.status !== 0) {
    throw new Error(`Development bundle verification failed:\n${result.stdout}\n${result.stderr}`);
  }
  if (!shouldPass && result.status === 0) {
    throw new Error("Development bundle unexpectedly passed strict release verification");
  }
  process.stdout.write(strict
    ? "Strict release verification remains fail-closed, as expected.\n"
    : "Development bundle verifier passed.\n");
}

function promoteBundle(staging, destination) {
  const backup = path.join(buildRoot, `ai-bundle-local.backup-${process.pid}-${Date.now()}`);
  let previousMoved = false;
  try {
    if (existsSync(destination)) {
      renameSync(destination, backup);
      previousMoved = true;
    }
    renameSync(staging, destination);
    return { destination, backup: previousMoved ? backup : null };
  } catch (error) {
    if (!existsSync(destination) && previousMoved && existsSync(backup)) renameSync(backup, destination);
    throw error;
  }
}

function finalizePromotion({ backup }) {
  if (backup) rmSync(backup, { recursive: true, force: true });
}

function rollbackPromotion({ destination, backup }) {
  rmSync(destination, { recursive: true, force: true });
  if (backup && existsSync(backup)) renameSync(backup, destination);
}

function sha256File(filePath) {
  const digest = createHash("sha256");
  const descriptor = openSync(filePath, "r");
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    while (true) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
    }
    return digest.digest("hex");
  } finally {
    closeSync(descriptor);
  }
}

function safeId(value) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 80);
}

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / (1024 ** 3)).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / (1024 ** 2)).toFixed(1)} MiB`;
  return `${bytes} bytes`;
}
