import { createHash } from "node:crypto";
import {
  existsSync,
  closeSync,
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultBundleRoot = path.join(repoRoot, "build", "ai-bundle");
const strict = process.argv.includes("--require-ready");
const selfTest = process.argv.includes("--self-test");
const rootArgumentIndex = process.argv.indexOf("--root");
const bundleRoot = rootArgumentIndex >= 0
  ? path.resolve(process.argv[rootArgumentIndex + 1] ?? "")
  : defaultBundleRoot;

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_ASSETS = 64;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,95}$/i;
const CAPABILITIES = new Set(["speech", "language"]);
const KINDS = new Set(["runtime", "library", "model"]);
const MANIFEST_FIELDS = new Set([
  "manifestVersion",
  "bundleVersion",
  "releaseReady",
  "fixture",
  "selectionStatus",
  "repairPolicy",
  "assets",
]);
const ASSET_FIELDS = new Set([
  "id",
  "capability",
  "kind",
  "engine",
  "relativePath",
  "sha256",
  "bytes",
  "licenseFile",
  "licenseExpression",
  "sourceUrl",
  "revision",
  "redistributionApproved",
  "required",
  "platform",
  "arch",
  "modelId",
  "modelCard",
  "contextTokens",
]);

function sha256File(filePath) {
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
  const descriptor = openSync(filePath, "r");
  try {
    for (;;) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(descriptor);
  }
  return digest.digest("hex");
}

function isContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function safeRelativePath(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 240
    && /^[A-Za-z0-9._/-]+$/.test(value)
    && !value.includes("\\")
    && !path.isAbsolute(value)
    && !value.split("/").some((part) => part === "" || part === "." || part === "..");
}

function rejectUnknownFields(value, allowed, label, failures) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) failures.push(`${label}.${key} is not allowed`);
  }
}

function relevantToHost(asset, platform, arch) {
  const platformAliases = platform === "win32"
    ? new Set(["win32", "windows"])
    : platform === "darwin"
      ? new Set(["darwin", "macos"])
      : new Set([platform]);
  const archAliases = arch === "x64"
    ? new Set(["x64", "x86_64"])
    : arch === "arm64"
      ? new Set(["arm64", "aarch64"])
      : new Set([arch]);
  const platformMatches = asset.platform === undefined || platformAliases.has(asset.platform);
  const archMatches = asset.arch === undefined || archAliases.has(asset.arch);
  return platformMatches && archMatches;
}

function verifySelectedAssetBindings(manifest, modelLock, runtimeLock, platform, arch) {
  const failures = [];
  const hostAssets = (manifest?.assets ?? []).filter((asset) => relevantToHost(asset, platform, arch));
  const selectedSpeechId = modelLock?.speech?.selectedModel;
  const speechCandidate = modelLock?.speech?.candidates?.find((candidate) => candidate.id === selectedSpeechId);
  const speechAsset = hostAssets.find((asset) => (
    asset.capability === "speech"
      && asset.kind === "model"
      && asset.required === true
      && asset.modelId === selectedSpeechId
  ));
  if (!speechCandidate) {
    failures.push(`selected speech model ${selectedSpeechId ?? "<missing>"} is absent from model-lock candidates`);
  }
  if (!speechAsset) {
    failures.push(`selected speech model ${selectedSpeechId ?? "<missing>"} is absent from the host bundle`);
  } else {
    if (speechAsset.engine !== "whisper.cpp") {
      failures.push("selected speech model must use whisper.cpp");
    }
    if (speechCandidate && String(speechAsset.sha256).toLowerCase() !== speechCandidate.expectedSha256.toLowerCase()) {
      failures.push(`selected speech model ${selectedSpeechId} does not match its trusted digest`);
    }
  }

  const selectedLanguageId = modelLock?.language?.selectedModel;
  const languageCandidate = modelLock?.language?.candidates?.find((candidate) => candidate.id === selectedLanguageId);
  const languageAsset = hostAssets.find((asset) => (
    asset.capability === "language"
      && asset.kind === "model"
      && asset.required === true
      && asset.modelId === selectedLanguageId
  ));
  if (!languageCandidate) {
    failures.push(`selected language model ${selectedLanguageId ?? "<missing>"} is absent from model-lock candidates`);
  }
  if (!languageAsset) {
    failures.push(`selected language model ${selectedLanguageId ?? "<missing>"} is absent from the host bundle`);
  } else {
    if (languageAsset.engine !== "llama.cpp") {
      failures.push("selected language model must use llama.cpp");
    }
    if (languageCandidate && String(languageAsset.sha256).toLowerCase() !== languageCandidate.expectedSha256.toLowerCase()) {
      failures.push(`selected language model ${selectedLanguageId} does not match its trusted digest`);
    }
  }

  const languageRuntimeLock = runtimeLock?.runtimes?.find((entry) => entry.id === "language-runtime");
  const languageRuntimeAsset = hostAssets.find((asset) => (
    asset.capability === "language" && asset.kind === "runtime" && asset.required === true
  ));
  if (!languageRuntimeAsset) {
    failures.push("selected language runtime is absent from the host bundle");
  } else {
    if (languageRuntimeAsset.engine !== "llama.cpp") {
      failures.push("selected language runtime must use llama.cpp");
    }
    if (languageRuntimeLock && languageRuntimeAsset.revision !== languageRuntimeLock.commit) {
      failures.push("selected language runtime revision does not match runtime-lock.json");
    }
    if (languageRuntimeLock && languageRuntimeAsset.licenseExpression !== languageRuntimeLock.licenseExpression) {
      failures.push("selected language runtime license does not match runtime-lock.json");
    }
  }
  return failures;
}

function loadManifest(root, failures) {
  const manifestPath = path.join(root, "manifest.json");
  if (!existsSync(manifestPath)) {
    failures.push("manifest.json is missing");
    return null;
  }
  const manifestState = lstatSync(manifestPath);
  if (manifestState.isSymbolicLink() || !manifestState.isFile()) {
    failures.push("manifest.json must be a regular non-symlink file");
    return null;
  }
  const bytes = manifestState.size;
  if (bytes <= 0 || bytes > MAX_MANIFEST_BYTES) {
    failures.push(`manifest.json must contain 1 to ${MAX_MANIFEST_BYTES} bytes`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    failures.push("manifest.json is not valid JSON");
    return null;
  }
}

export function verifyBundle(root, options = {}) {
  const failures = [];
  const warnings = [];
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const requireReady = options.requireReady ?? false;
  const manifest = loadManifest(root, failures);
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { ok: false, failures, warnings, manifest: null, verifiedAssets: [] };
  }
  rejectUnknownFields(manifest, MANIFEST_FIELDS, "manifest", failures);

  if (manifest.manifestVersion !== 1) failures.push("manifestVersion must be 1");
  if (typeof manifest.bundleVersion !== "string" || !manifest.bundleVersion.trim()) {
    failures.push("bundleVersion must be a non-empty string");
  }
  if (typeof manifest.releaseReady !== "boolean") failures.push("releaseReady must be boolean");
  if (typeof manifest.fixture !== "boolean") failures.push("fixture must be boolean");
  if (typeof manifest.selectionStatus !== "string" || !manifest.selectionStatus.trim()) {
    failures.push("selectionStatus must be a non-empty string");
  }
  if (manifest.fixture === true && manifest.releaseReady === true) {
    failures.push("a fixture manifest can never be release-ready");
  }
  if (manifest.repairPolicy !== "signed-installer-only") {
    failures.push("repairPolicy must be signed-installer-only");
  }
  if (!Array.isArray(manifest.assets)) failures.push("assets must be an array");
  const assets = Array.isArray(manifest.assets) ? manifest.assets : [];
  if (assets.length > MAX_ASSETS) failures.push(`assets cannot contain more than ${MAX_ASSETS} entries`);
  if (requireReady && manifest.releaseReady !== true) failures.push("releaseReady must be true for a release bundle");
  if (requireReady && manifest.selectionStatus !== "release-selected") {
    failures.push("selectionStatus must be release-selected for a release bundle");
  }
  if (!requireReady && manifest.releaseReady !== true) {
    warnings.push("bundle metadata is valid but no release-ready default is selected");
  }

  let canonicalRoot = null;
  try {
    canonicalRoot = realpathSync.native(root);
  } catch {
    failures.push("bundle root is unavailable");
  }

  const ids = new Set();
  const hostSelectors = new Set();
  const verifiedAssets = [];
  for (const [index, asset] of assets.entries()) {
    const label = `assets[${index}]`;
    if (!asset || typeof asset !== "object" || Array.isArray(asset)) {
      failures.push(`${label} must be an object`);
      continue;
    }
    const failureCountBeforeAsset = failures.length;
    rejectUnknownFields(asset, ASSET_FIELDS, label, failures);
    if (!SAFE_ID_PATTERN.test(asset.id ?? "")) failures.push(`${label}.id is invalid`);
    if (ids.has(asset.id)) failures.push(`${label}.id is duplicated`);
    ids.add(asset.id);
    if (!CAPABILITIES.has(asset.capability)) failures.push(`${label}.capability is invalid`);
    if (!KINDS.has(asset.kind)) failures.push(`${label}.kind is invalid`);
    if (typeof asset.engine !== "string" || !asset.engine.trim()) failures.push(`${label}.engine is required`);
    if (!safeRelativePath(asset.relativePath)) failures.push(`${label}.relativePath is unsafe`);
    if (!SHA256_PATTERN.test(asset.sha256 ?? "") || /^0{64}$/i.test(asset.sha256 ?? "")) {
      failures.push(`${label}.sha256 must be a non-zero SHA-256 digest`);
    }
    if (!Number.isSafeInteger(asset.bytes) || asset.bytes <= 0) failures.push(`${label}.bytes must be positive`);
    if (!safeRelativePath(asset.licenseFile)) failures.push(`${label}.licenseFile is unsafe`);
    if (typeof asset.licenseExpression !== "string" || !asset.licenseExpression.trim()) {
      failures.push(`${label}.licenseExpression is required`);
    }
    if (typeof asset.sourceUrl !== "string" || !/^https:\/\//.test(asset.sourceUrl)) {
      failures.push(`${label}.sourceUrl must use HTTPS`);
    }
    if (typeof asset.revision !== "string" || !asset.revision.trim()) failures.push(`${label}.revision is required`);
    if (asset.redistributionApproved !== true) {
      if (typeof asset.redistributionApproved !== "boolean") {
        failures.push(`${label}.redistributionApproved must be boolean`);
      } else {
        failures.push(`${label} is not approved for redistribution`);
      }
    }
    if (typeof asset.required !== "boolean") {
      failures.push(`${label}.required must be boolean`);
    }
    if (asset.platform !== undefined && (typeof asset.platform !== "string" || !asset.platform.trim())) {
      failures.push(`${label}.platform must be a non-empty string when present`);
    }
    if (asset.arch !== undefined && (typeof asset.arch !== "string" || !asset.arch.trim())) {
      failures.push(`${label}.arch must be a non-empty string when present`);
    }
    if (asset.contextTokens !== undefined && (!Number.isSafeInteger(asset.contextTokens) || asset.contextTokens <= 0)) {
      failures.push(`${label}.contextTokens must be a positive integer when present`);
    }
    if (asset.kind === "model") {
      if (!safeRelativePath(asset.modelCard)) failures.push(`${label}.modelCard is required and must be safe`);
      if (typeof asset.modelId !== "string" || !asset.modelId.trim()) failures.push(`${label}.modelId is required`);
    } else if (asset.modelCard !== undefined || asset.modelId !== undefined) {
      failures.push(`${label} can declare modelId and modelCard only for model assets`);
    }
    if (relevantToHost(asset, platform, arch)) {
      const selector = asset.capability === "language" || (asset.capability === "speech" && asset.kind === "model")
        ? `${asset.capability}:${asset.kind}`
        : `${asset.capability}:${asset.kind}:${asset.modelId ?? ""}`;
      if (hostSelectors.has(selector)) failures.push(`${label} duplicates packaged selector ${selector}`);
      hostSelectors.add(selector);
    }
    if (!canonicalRoot || !safeRelativePath(asset.relativePath)) continue;

    const target = path.resolve(root, asset.relativePath);
    if (!isContained(path.resolve(root), target)) {
      failures.push(`${label}.relativePath escapes the bundle root`);
      continue;
    }
    if (!existsSync(target)) {
      failures.push(`${label} file is missing`);
      continue;
    }
    const linkState = lstatSync(target);
    if (linkState.isSymbolicLink() || !linkState.isFile()) {
      failures.push(`${label} must resolve to a regular non-symlink file`);
      continue;
    }
    if (asset.kind === "runtime" && relevantToHost(asset, platform, arch)) {
      if (platform === "win32" && path.extname(target).toLowerCase() !== ".exe") {
        failures.push(`${label} Windows runtime must be an .exe file`);
      }
      if (platform !== "win32" && (linkState.mode & 0o111) === 0) {
        failures.push(`${label} runtime is not executable on ${platform}`);
      }
    }
    const canonicalTarget = realpathSync.native(target);
    if (!isContained(canonicalRoot, canonicalTarget)) {
      failures.push(`${label} canonical path escapes the bundle root`);
      continue;
    }
    if (linkState.size !== asset.bytes) failures.push(`${label} byte count does not match`);
    const digest = sha256File(target);
    if (!digest.toLowerCase().match(SHA256_PATTERN) || digest.toLowerCase() !== String(asset.sha256).toLowerCase()) {
      failures.push(`${label} SHA-256 does not match`);
    }

    for (const [field, relativePath] of [["licenseFile", asset.licenseFile], ["modelCard", asset.modelCard]]) {
      if (!relativePath) continue;
      if (!safeRelativePath(relativePath)) continue;
      const noticePath = path.resolve(root, relativePath);
      if (!isContained(path.resolve(root), noticePath) || !existsSync(noticePath)) {
        failures.push(`${label}.${field} is missing`);
        continue;
      }
      const noticeState = lstatSync(noticePath);
      if (noticeState.isSymbolicLink() || !noticeState.isFile() || noticeState.size === 0) {
        failures.push(`${label}.${field} must be a non-empty regular file`);
        continue;
      }
      const canonicalNotice = realpathSync.native(noticePath);
      if (!isContained(canonicalRoot, canonicalNotice)) {
        failures.push(`${label}.${field} canonical path escapes the bundle root`);
      }
    }

    if (failures.length === failureCountBeforeAsset) {
      verifiedAssets.push({
        id: asset.id,
        capability: asset.capability,
        kind: asset.kind,
        bytes: linkState.size,
        sha256: digest,
      });
    }
  }

  if (requireReady) {
    const hostAssets = assets.filter((asset) => relevantToHost(asset, platform, arch));
    const requiredPairs = [
      ["speech", "model"],
      ["language", "runtime"],
      ["language", "model"],
    ];
    for (const [capability, kind] of requiredPairs) {
      if (!hostAssets.some((asset) => asset.capability === capability && asset.kind === kind && asset.required === true)) {
        failures.push(`release bundle requires a ${capability} ${kind} for ${platform}-${arch}`);
      }
    }
  }

  return { ok: failures.length === 0, failures, warnings, manifest, verifiedAssets };
}

function writeProof(result, root) {
  const proofDir = path.join(repoRoot, "release-v3", "proofs");
  mkdirSync(proofDir, { recursive: true });
  const mode = strict ? "release-strict" : "source-interface";
  const proofPath = path.join(
    proofDir,
    `spec3-ai-bundle-${mode}-${process.platform}-${process.arch}.json`,
  );
  const proof = {
    proofKind: "spec3-ai-bundle",
    generatedAt: new Date().toISOString(),
    ok: result.ok,
    mode,
    manifestVersion: result.manifest?.manifestVersion ?? null,
    bundleVersion: result.manifest?.bundleVersion ?? null,
    releaseReady: result.manifest?.releaseReady === true,
    fixture: result.manifest?.fixture === true,
    verifiedAssetCount: result.verifiedAssets.length,
    failures: result.failures,
    warnings: result.warnings,
    networkAttempted: false,
    rawPathExposed: false,
  };
  writeFileSync(proofPath, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
  return proofPath;
}

function verifyDecisionLocks(manifest, requireReady) {
  const failures = [];
  const runtimeLockPath = path.join(repoRoot, "third_party", "runtime-lock.json");
  const modelLockPath = path.join(repoRoot, "third_party", "model-lock.json");
  let runtimeLock;
  let modelLock;
  try { runtimeLock = JSON.parse(readFileSync(runtimeLockPath, "utf8")); }
  catch { failures.push("third_party/runtime-lock.json is missing or invalid"); }
  try { modelLock = JSON.parse(readFileSync(modelLockPath, "utf8")); }
  catch { failures.push("third_party/model-lock.json is missing or invalid"); }
  if (!runtimeLock || !modelLock) return failures;
  if (runtimeLock.schemaVersion !== 1 || !Array.isArray(runtimeLock.runtimes)) {
    failures.push("runtime lock schema is invalid");
  }
  const speechRuntime = runtimeLock.runtimes?.find((entry) => entry.id === "speech-runtime");
  const languageRuntime = runtimeLock.runtimes?.find((entry) => entry.id === "language-runtime");
  if (!speechRuntime?.cargo?.checksum?.match(SHA256_PATTERN) || !speechRuntime?.cargo?.sysChecksum?.match(SHA256_PATTERN)) {
    failures.push("speech runtime Cargo checksums are not pinned");
  }
  if (speechRuntime?.licenseExpression !== "Unlicense AND MIT" || !Array.isArray(speechRuntime?.licenses)) {
    failures.push("speech runtime layered licenses are incomplete");
  }
  if (!languageRuntime?.commit?.match(/^[a-f0-9]{40}$/i)) {
    failures.push("language runtime commit is not pinned");
  }
  if (languageRuntime?.licenseExpression !== "MIT") {
    failures.push("language runtime license is not pinned");
  }
  if (modelLock.schemaVersion !== 1 || typeof modelLock.speech !== "object" || typeof modelLock.language !== "object") {
    failures.push("model lock schema is invalid");
  }
  if (modelLock.language?.selectedModel !== null && typeof modelLock.language?.selectedModel !== "string") {
    failures.push("language selectedModel must be null or a model id");
  }
  if (!Array.isArray(modelLock.speech?.candidates)
      || modelLock.speech.candidates.some((candidate) => !candidate?.expectedSha256?.match(SHA256_PATTERN))) {
    failures.push("speech model candidate hashes are incomplete");
  }
  if (!Array.isArray(modelLock.language?.candidates)
      || modelLock.language.candidates.some((candidate) => !candidate?.expectedSha256?.match(SHA256_PATTERN))) {
    failures.push("language model candidate hashes are incomplete");
  }
  const selectedReleaseClaimed = requireReady
    || manifest?.releaseReady === true
    || manifest?.selectionStatus === "release-selected";
  if (selectedReleaseClaimed) {
    if (modelLock.speech?.selectionStatus !== "release-selected" || typeof modelLock.speech?.selectedModel !== "string") {
      failures.push("release bundle requires a benchmarked speech model in model-lock.json");
    }
    if (modelLock.language?.selectionStatus !== "release-selected" || typeof modelLock.language?.selectedModel !== "string") {
      failures.push("release bundle requires a licensed and benchmarked language model in model-lock.json");
    }
    if (languageRuntime?.selectionStatus !== "release-selected") {
      failures.push("release bundle requires a tested language runtime in runtime-lock.json");
    }
    failures.push(...verifySelectedAssetBindings(
      manifest,
      modelLock,
      runtimeLock,
      process.platform,
      process.arch,
    ));
  }
  return failures;
}

function makeFixture(root) {
  mkdirSync(path.join(root, "notices"), { recursive: true });
  mkdirSync(path.join(root, "assets"), { recursive: true });
  writeFileSync(path.join(root, "notices", "license.txt"), "fixture license\n");
  writeFileSync(path.join(root, "notices", "model-card.md"), "# Fixture model\n");
  const definitions = [
    ["speech-model", "speech", "model", "assets/speech.bin", "speech-default"],
    ["language-runtime", "language", "runtime", `assets/language-runtime.${process.platform === "win32" ? "exe" : "bin"}`, null],
    ["language-model", "language", "model", "assets/language-model.gguf", "language-default"],
  ];
  const assets = definitions.map(([id, capability, kind, relativePath, modelId]) => {
    const content = Buffer.from(`fixture:${id}`);
    writeFileSync(path.join(root, relativePath), content);
    if (kind === "runtime" && process.platform !== "win32") {
      chmodSync(path.join(root, relativePath), 0o755);
    }
    return {
      id,
      capability,
      kind,
      engine: capability === "speech" ? "whisper.cpp" : "llama.cpp",
      relativePath,
      sha256: createHash("sha256").update(content).digest("hex"),
      bytes: content.length,
      licenseFile: "notices/license.txt",
      licenseExpression: "MIT",
      sourceUrl: "https://example.invalid/fixture",
      revision: "fixture",
      redistributionApproved: true,
      required: true,
      platform: process.platform,
      arch: process.arch,
      ...(modelId ? { modelId, modelCard: "notices/model-card.md" } : {}),
    };
  });
  const manifest = {
    manifestVersion: 1,
    bundleVersion: "fixture",
    releaseReady: true,
    fixture: false,
    selectionStatus: "release-selected",
    repairPolicy: "signed-installer-only",
    assets,
  };
  writeFileSync(path.join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function runSelfTest() {
  const root = mkdtempSync(path.join(tmpdir(), "candor-ai-bundle-verifier-"));
  try {
    const manifest = makeFixture(root);
    const ready = verifyBundle(root, { requireReady: true });
    if (!ready.ok) throw new Error(`valid fixture failed: ${ready.failures.join(", ")}`);

    const fixtureModelLock = {
      speech: {
        selectedModel: "speech-default",
        candidates: [{ id: "speech-default", expectedSha256: manifest.assets[0].sha256 }],
      },
      language: {
        selectedModel: "language-default",
        candidates: [{ id: "language-default", expectedSha256: manifest.assets[2].sha256 }],
      },
    };
    const fixtureRuntimeLock = {
      runtimes: [{ id: "language-runtime", commit: "fixture", licenseExpression: "MIT" }],
    };
    const bound = verifySelectedAssetBindings(
      manifest,
      fixtureModelLock,
      fixtureRuntimeLock,
      process.platform,
      process.arch,
    );
    if (bound.length > 0) throw new Error(`valid selected asset bindings failed: ${bound.join(", ")}`);
    fixtureModelLock.speech.candidates[0].expectedSha256 = "f".repeat(64);
    if (!verifySelectedAssetBindings(
      manifest,
      fixtureModelLock,
      fixtureRuntimeLock,
      process.platform,
      process.arch,
    ).some((failure) => failure.includes("trusted digest"))) {
      throw new Error("selected model digest mismatch was accepted");
    }
    fixtureModelLock.speech.candidates[0].expectedSha256 = manifest.assets[0].sha256;

    manifest.assets[0].sha256 = "0".repeat(64);
    writeFileSync(path.join(root, "manifest.json"), JSON.stringify(manifest));
    const zeroDigest = verifyBundle(root);
    if (zeroDigest.ok) throw new Error("zero digest was accepted");
    if (zeroDigest.verifiedAssets.some((asset) => asset.id === "speech-model")) {
      throw new Error("failed asset was counted as verified");
    }

    manifest.assets[0].sha256 = createHash("sha256").update("fixture:speech-model").digest("hex");
    manifest.unexpected = true;
    writeFileSync(path.join(root, "manifest.json"), JSON.stringify(manifest));
    if (verifyBundle(root).ok) throw new Error("unknown manifest field was accepted");
    delete manifest.unexpected;

    manifest.assets[0].redistributionApproved = false;
    writeFileSync(path.join(root, "manifest.json"), JSON.stringify(manifest));
    if (verifyBundle(root).ok) throw new Error("unapproved asset was accepted");
    manifest.assets[0].redistributionApproved = true;

    manifest.assets[0].relativePath = "../escape.bin";
    writeFileSync(path.join(root, "manifest.json"), JSON.stringify(manifest));
    if (verifyBundle(root).ok) throw new Error("path traversal was accepted");

    manifest.assets[0].relativePath = "assets/speech.bin";
    manifest.fixture = true;
    writeFileSync(path.join(root, "manifest.json"), JSON.stringify(manifest));
    if (verifyBundle(root, { requireReady: true }).ok) throw new Error("release-ready fixture was accepted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  console.log("SPEC-3 AI bundle verifier self-test passed.");
}

if (selfTest) {
  runSelfTest();
} else {
  const result = verifyBundle(bundleRoot, { requireReady: strict });
  result.failures.push(...verifyDecisionLocks(result.manifest, strict));
  result.ok = result.failures.length === 0;
  const proofPath = writeProof(result, bundleRoot);
  for (const warning of result.warnings) console.warn(`- ${warning}`);
  if (!result.ok) {
    for (const failure of result.failures) console.error(`- ${failure}`);
    process.exitCode = 1;
  } else {
    console.log(`Candor AI bundle ${strict ? "release" : "source-interface"} verification passed.`);
    console.log(`Proof written to ${path.relative(repoRoot, proofPath)}.`);
  }
}
