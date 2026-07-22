import { createHash } from "node:crypto";
import {
  existsSync,
  closeSync,
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultBundleRoot = path.join(repoRoot, "build", "ai-bundle");
const strict = process.argv.includes("--require-ready");
const requireSourceInterface = process.argv.includes("--require-source-interface");
const selfTest = process.argv.includes("--self-test");
const rootArgumentIndex = process.argv.indexOf("--root");
const profileArgumentIndex = process.argv.indexOf("--profile");
const expectedProfile = profileArgumentIndex >= 0
  ? process.argv[profileArgumentIndex + 1] ?? ""
  : null;
const bundleRoot = rootArgumentIndex >= 0
  ? path.resolve(process.argv[rootArgumentIndex + 1] ?? "")
  : defaultBundleRoot;

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_ASSETS = 64;
const MAX_BUNDLE_TREE_ENTRIES = 1024;
const MAX_CONTROL_NOTICE_BYTES = 128 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,95}$/i;
const CAPABILITIES = new Set(["speech", "language", "terminology"]);
const KINDS = new Set(["runtime", "library", "model", "data", "public-key"]);
const BUNDLE_CONTROL_FILES = new Set([
  "manifest.json",
  "notices/README.md",
]);
const MANIFEST_FIELDS = new Set([
  "manifestVersion",
  "bundleVersion",
  "releaseReady",
  "fixture",
  "selectionStatus",
  "packageProfile",
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

function isProhibitedTransientPath(relativePath) {
  return relativePath.split("/").some((part) => (
    /(?:\.(?:part|partial|tmp|temp|bak|backup|old|orig|save)|~)$/i.test(part)
    || /^~/.test(part)
    || /^#.*#$/.test(part)
  ));
}

function collectBundleTree(root, failures) {
  const files = [];
  const directories = [];
  const caseInsensitivePaths = new Map();
  let entryCount = 0;
  let limitReported = false;

  let rootState;
  try {
    rootState = lstatSync(root);
  } catch {
    failures.push("bundle root is unavailable");
    return { files, directories };
  }
  if (rootState.isSymbolicLink() || !rootState.isDirectory()) {
    failures.push("bundle root must be a regular non-symlink directory");
    return { files, directories };
  }

  function walk(directory, relativeDirectory) {
    let names;
    try {
      names = readdirSync(directory).sort((left, right) => left.localeCompare(right, "en"));
    } catch {
      failures.push(`bundle directory ${relativeDirectory || "."} is unreadable`);
      return;
    }

    for (const name of names) {
      entryCount += 1;
      if (entryCount > MAX_BUNDLE_TREE_ENTRIES) {
        if (!limitReported) {
          failures.push(`bundle tree cannot contain more than ${MAX_BUNDLE_TREE_ENTRIES} entries`);
          limitReported = true;
        }
        return;
      }

      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const target = path.join(directory, name);
      if (!safeRelativePath(relativePath)) {
        failures.push(`bundle tree path ${JSON.stringify(relativePath)} is unsafe`);
      }
      const foldedPath = relativePath.toLowerCase();
      const existingPath = caseInsensitivePaths.get(foldedPath);
      if (existingPath !== undefined && existingPath !== relativePath) {
        failures.push(`bundle tree has a case-insensitive path collision: ${existingPath} and ${relativePath}`);
      } else {
        caseInsensitivePaths.set(foldedPath, relativePath);
      }
      if (isProhibitedTransientPath(relativePath)) {
        failures.push(`bundle tree contains prohibited partial or backup path ${relativePath}`);
      }

      let state;
      try {
        state = lstatSync(target);
      } catch {
        failures.push(`bundle tree entry ${relativePath} is unreadable`);
        continue;
      }
      if (state.isSymbolicLink()) {
        failures.push(`bundle tree entry ${relativePath} must not be a symbolic link or junction`);
        continue;
      }
      if (state.isDirectory()) {
        directories.push(relativePath);
        walk(target, relativePath);
      } else if (state.isFile()) {
        files.push({ relativePath, bytes: state.size });
      } else {
        failures.push(`bundle tree entry ${relativePath} must be a regular file or directory`);
      }
    }
  }

  walk(root, "");
  return { files, directories };
}

function verifyBundleTreeClosure(root, manifest, failures) {
  const allowedFiles = new Set();
  const declaredPaths = new Map();

  function declarePath(relativePath, claim, claimKind) {
    if (!safeRelativePath(relativePath)) return;
    const foldedPath = relativePath.toLowerCase();
    const existing = declaredPaths.get(foldedPath);
    if (existing !== undefined) {
      if (existing.relativePath !== relativePath) {
        failures.push(
          `manifest has a case-insensitive path collision: ${existing.relativePath} and ${relativePath}`,
        );
      } else if (
        claimKind === "asset"
        || existing.claimKind === "asset"
        || existing.claimKind === "control"
        || claimKind === "control"
      ) {
        failures.push(`manifest path ${relativePath} is claimed by both ${existing.claim} and ${claim}`);
      }
    } else {
      declaredPaths.set(foldedPath, { relativePath, claim, claimKind });
    }
    allowedFiles.add(relativePath);
  }

  for (const controlFile of BUNDLE_CONTROL_FILES) {
    declarePath(controlFile, `control file ${controlFile}`, "control");
  }
  for (const [index, asset] of (Array.isArray(manifest?.assets) ? manifest.assets : []).entries()) {
    if (!asset || typeof asset !== "object" || Array.isArray(asset)) continue;
    declarePath(asset.relativePath, `assets[${index}].relativePath`, "asset");
    declarePath(asset.licenseFile, `assets[${index}].licenseFile`, "reference");
    if (asset.modelCard !== undefined) {
      declarePath(asset.modelCard, `assets[${index}].modelCard`, "reference");
    }
  }

  const allowedDirectories = new Set();
  for (const allowedFile of allowedFiles) {
    const parts = allowedFile.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      allowedDirectories.add(parts.slice(0, index).join("/"));
    }
  }
  const allowedFilesByFoldedPath = new Map(
    [...allowedFiles].map((relativePath) => [relativePath.toLowerCase(), relativePath]),
  );
  const allowedDirectoriesByFoldedPath = new Map(
    [...allowedDirectories].map((relativePath) => [relativePath.toLowerCase(), relativePath]),
  );

  const tree = collectBundleTree(root, failures);
  for (const file of tree.files) {
    if (!allowedFiles.has(file.relativePath)) {
      const declaredSpelling = allowedFilesByFoldedPath.get(file.relativePath.toLowerCase());
      if (declaredSpelling !== undefined) {
        failures.push(`bundle file ${file.relativePath} does not match declared path spelling ${declaredSpelling}`);
      } else {
        failures.push(`bundle contains unlisted file ${file.relativePath}`);
      }
    }
    if (file.relativePath === "notices/README.md" && (
      file.bytes <= 0 || file.bytes > MAX_CONTROL_NOTICE_BYTES
    )) {
      failures.push(`notices/README.md must contain 1 to ${MAX_CONTROL_NOTICE_BYTES} bytes`);
    }
  }
  for (const directory of tree.directories) {
    if (!allowedDirectories.has(directory)) {
      const declaredSpelling = allowedDirectoriesByFoldedPath.get(directory.toLowerCase());
      if (declaredSpelling !== undefined) {
        failures.push(`bundle directory ${directory} does not match declared path spelling ${declaredSpelling}`);
      } else {
        failures.push(`bundle contains unlisted directory ${directory}`);
      }
    }
  }
}

function rejectUnknownFields(value, allowed, label, failures) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) failures.push(`${label}.${key} is not allowed`);
  }
}

function verifyPublisherKeyFile(target, label, failures) {
  let document;
  try {
    document = JSON.parse(readFileSync(target, "utf8"));
  } catch {
    failures.push(`${label} is not a valid publisher-key document`);
    return;
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    failures.push(`${label} must be a publisher-key object`);
    return;
  }
  rejectUnknownFields(
    document,
    new Set(["schemaVersion", "keyId", "publicKeyBase64", "rotationGeneration"]),
    label,
    failures,
  );
  if (
    document.schemaVersion !== 2
    || !SAFE_ID_PATTERN.test(document.keyId ?? "")
    || !Number.isSafeInteger(document.rotationGeneration)
    || document.rotationGeneration < 1
  ) {
    failures.push(`${label} publisher-key metadata is invalid`);
  }
  if (typeof document.publicKeyBase64 !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(document.publicKeyBase64)) {
    failures.push(`${label}.publicKeyBase64 is invalid`);
    return;
  }
  const publicKey = Buffer.from(document.publicKeyBase64, "base64");
  if (publicKey.length !== 32 || publicKey.toString("base64") !== document.publicKeyBase64) {
    failures.push(`${label}.publicKeyBase64 must encode exactly one 32-byte Ed25519 public key`);
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
    if (speechCandidate && speechAsset.bytes !== speechCandidate.bytes) {
      failures.push(`selected speech model ${selectedSpeechId} does not match its trusted byte count`);
    }
    if (speechCandidate && speechAsset.licenseExpression !== speechCandidate.licenseExpression) {
      failures.push(`selected speech model ${selectedSpeechId} does not match its trusted license`);
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
    if (languageCandidate && languageAsset.bytes !== languageCandidate.bytes) {
      failures.push(`selected language model ${selectedLanguageId} does not match its trusted byte count`);
    }
    if (languageCandidate && languageAsset.licenseExpression !== languageCandidate.licenseExpression) {
      failures.push(`selected language model ${selectedLanguageId} does not match its trusted license`);
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
    if (!/\/llama-completion(?:\.exe)?$/i.test(String(languageRuntimeAsset.relativePath).replaceAll("\\", "/"))) {
      failures.push("selected language runtime must use the llama-completion frontend");
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
  const requireSourceInterfaceMode = options.requireSourceInterface ?? false;
  const requiredProfile = options.requiredProfile ?? null;
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
  if (typeof manifest.packageProfile !== "string" || !manifest.packageProfile.trim()) {
    failures.push("packageProfile must be a non-empty string");
  }
  if (requiredProfile !== null && manifest.packageProfile !== requiredProfile) {
    failures.push(`packageProfile must be ${requiredProfile} for this package command`);
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
  if (manifest.selectionStatus === "no-default-selected" && assets.length !== 0) {
    failures.push("selectionStatus no-default-selected requires an empty asset inventory");
  }
  if (manifest.packageProfile === "source-interface" && assets.length !== 0) {
    failures.push("packageProfile source-interface requires an empty asset inventory");
  }
  if (requireSourceInterfaceMode) {
    if (requireReady) failures.push("source-interface and release-ready modes are mutually exclusive");
    if (manifest.releaseReady !== false) failures.push("source-interface releaseReady must be false");
    if (manifest.fixture !== false) failures.push("source-interface fixture must be false");
    if (manifest.selectionStatus !== "no-default-selected") {
      failures.push("source-interface selectionStatus must be no-default-selected");
    }
    if (manifest.packageProfile !== "source-interface") {
      failures.push("source-interface packageProfile must be source-interface");
    }
    if (assets.length !== 0) failures.push("source-interface asset inventory must be empty");
  }
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
  verifyBundleTreeClosure(root, manifest, failures);

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
    if (asset.kind === "public-key" && (
      asset.capability !== "terminology"
      || asset.engine !== "ed25519"
      || asset.bytes > 64 * 1024
    )) {
      failures.push(`${label} publisher key must be a bounded terminology Ed25519 public key`);
    }
    if (relevantToHost(asset, platform, arch)) {
      const selector = asset.kind === "model"
        ? `${asset.capability}:${asset.kind}:${asset.modelId ?? ""}`
        : asset.kind === "library"
          ? `${asset.capability}:${asset.kind}:${asset.id}`
          : `${asset.capability}:${asset.kind}`;
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
    if (asset.kind === "public-key") {
      verifyPublisherKeyFile(target, label, failures);
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
      ["terminology", "data"],
      ["terminology", "public-key"],
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
    packageProfile: result.manifest?.packageProfile ?? null,
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
  if (languageRuntime?.frontend !== "llama-completion") {
    failures.push("language runtime must pin the llama-completion frontend for strict JSON generation");
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
  if (modelLock.speech?.candidates?.some((candidate) => (
    candidate?.upstreamPublisher !== "OpenAI"
      || candidate?.distributionSource !== "ggerganov/whisper.cpp"
      || !candidate?.distributionRevision?.match(/^[a-f0-9]{40}$/i)
      || candidate?.distributionRevision !== candidate?.revision
      || candidate?.provenanceStatus !== "canonical-whisper-cpp-artifact-pinned"
  ))) {
    failures.push("speech model candidate provenance must distinguish OpenAI from the pinned whisper.cpp distribution");
  }
  if (!Array.isArray(modelLock.language?.candidates)
      || modelLock.language.candidates.some((candidate) => (
        candidate?.expectedSha256 !== null
          && !candidate?.expectedSha256?.match(SHA256_PATTERN)
      ))) {
    failures.push("language model candidate hashes are invalid");
  }
  if (modelLock.language?.candidates?.some((candidate) => (
    candidate?.expectedSha256 === null
      && candidate?.artifactStatus !== "reproducible-conversion-pending"
  ))) {
    failures.push("an undigested language candidate must be explicitly conversion-pending");
  }
  const selectedReleaseClaimed = requireReady
    || manifest?.releaseReady === true
    || manifest?.selectionStatus === "release-selected";
  if (selectedReleaseClaimed) {
    if (!new Set(["complete", "complete-max"]).has(manifest?.packageProfile)) {
      failures.push("release bundle packageProfile must be complete or complete-max");
    }
    if (modelLock.speech?.selectionStatus !== "release-selected" || typeof modelLock.speech?.selectedModel !== "string") {
      failures.push("release bundle requires a benchmarked speech model in model-lock.json");
    }
    if (modelLock.language?.selectionStatus !== "release-selected" || typeof modelLock.language?.selectedModel !== "string") {
      failures.push("release bundle requires a licensed and benchmarked language model in model-lock.json");
    }
    if (languageRuntime?.selectionStatus !== "release-selected") {
      failures.push("release bundle requires a tested language runtime in runtime-lock.json");
    }
    failures.push(...verifyReleaseCandidateEvidence(modelLock, runtimeLock, manifest?.packageProfile));
    const profile = modelLock.packageProfiles?.[manifest?.packageProfile];
    if (!profile || !Array.isArray(profile.speechModelIds)) {
      failures.push("release bundle package profile is absent from model-lock.json");
    } else {
      const hostAssets = (manifest?.assets ?? []).filter((asset) => relevantToHost(asset, process.platform, process.arch));
      for (const modelId of profile.speechModelIds) {
        if (!hostAssets.some((asset) => asset.capability === "speech" && asset.kind === "model" && asset.modelId === modelId)) {
          failures.push(`release profile ${manifest.packageProfile} requires speech model ${modelId}`);
        }
      }
      failures.push(...verifySpeechProfileMembership(manifest, modelLock, hostAssets));
      if (profile.requiresGeneralDictionary !== true) {
        failures.push(`release profile ${manifest.packageProfile} must require a general dictionary`);
      }
      if (!hostAssets.some((asset) => asset.capability === "terminology" && asset.kind === "data" && asset.required === true)) {
        failures.push(`release profile ${manifest.packageProfile} requires a signed general dictionary`);
      }
      if (profile.requiresDictionaryPublisherKey !== true) {
        failures.push(`release profile ${manifest.packageProfile} must require the Candor dictionary publisher key`);
      }
      if (!hostAssets.some((asset) => asset.capability === "terminology" && asset.kind === "public-key" && asset.required === true)) {
        failures.push(`release profile ${manifest.packageProfile} requires the Candor dictionary publisher key`);
      }
    }
    const selectedLanguageCandidate = modelLock.language?.candidates?.find(
      (candidate) => candidate.id === modelLock.language?.selectedModel,
    );
    if (!selectedLanguageCandidate?.expectedSha256?.match(SHA256_PATTERN)) {
      failures.push("release-selected language model must have an exact artifact digest");
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

function verifyReleaseCandidateEvidence(modelLock, runtimeLock, packageProfile) {
  const failures = [];
  const profile = modelLock.packageProfiles?.[packageProfile];
  const speechCandidates = modelLock.speech?.candidates ?? [];

  for (const modelId of profile?.speechModelIds ?? []) {
    const candidate = speechCandidates.find((entry) => entry.id === modelId);
    if (!candidate) {
      failures.push(`release profile ${packageProfile} has no locked speech candidate ${modelId}`);
      continue;
    }
    if (candidate.benchmarkStatus !== "passed") {
      failures.push(`speech model ${modelId} has not passed Candor benchmarks`);
    }
    if (candidate.redistributionReview !== "approved") {
      failures.push(`speech model ${modelId} lacks approved redistribution review`);
    }
    if (candidate.provenanceStatus !== "canonical-whisper-cpp-artifact-pinned"
        || candidate.upstreamPublisher !== "OpenAI"
        || candidate.distributionSource !== "ggerganov/whisper.cpp"
        || candidate.distributionRevision !== candidate.revision) {
      failures.push(`speech model ${modelId} lacks pinned upstream and whisper.cpp distribution provenance`);
    }
    if (!Number.isSafeInteger(candidate.bytes) || candidate.bytes <= 0) {
      failures.push(`speech model ${modelId} lacks an exact positive byte count`);
    }
    if (!candidate.expectedSha256?.match(SHA256_PATTERN)) {
      failures.push(`speech model ${modelId} lacks an exact artifact digest`);
    }
    if (typeof candidate.licenseExpression !== "string" || !candidate.licenseExpression.trim()) {
      failures.push(`speech model ${modelId} lacks a pinned license expression`);
    }
  }

  const selectedLanguageId = modelLock.language?.selectedModel;
  const languageCandidate = modelLock.language?.candidates?.find((entry) => entry.id === selectedLanguageId);
  if (languageCandidate) {
    if (languageCandidate.benchmarkStatus !== "passed") {
      failures.push(`language model ${selectedLanguageId} has not passed Candor benchmarks`);
    }
    if (languageCandidate.redistributionReview !== "approved") {
      failures.push(`language model ${selectedLanguageId} lacks approved redistribution review`);
    }
    if (!new Set(["official-artifact-pinned", "reproducible-conversion-verified"]).has(languageCandidate.artifactStatus)) {
      failures.push(`language model ${selectedLanguageId} lacks approved artifact provenance`);
    }
    if (!Number.isSafeInteger(languageCandidate.bytes) || languageCandidate.bytes <= 0) {
      failures.push(`language model ${selectedLanguageId} lacks an exact positive byte count`);
    }
    if (typeof languageCandidate.licenseExpression !== "string" || !languageCandidate.licenseExpression.trim()) {
      failures.push(`language model ${selectedLanguageId} lacks a pinned license expression`);
    }
  }

  const languageRuntime = runtimeLock.runtimes?.find((entry) => entry.id === "language-runtime");
  if (languageRuntime?.compatibilityStatus !== "passed") {
    failures.push("language runtime has not passed Candor compatibility checks");
  }
  if (languageRuntime?.redistributionReview !== "approved") {
    failures.push("language runtime lacks approved redistribution review");
  }
  return failures;
}

function verifySpeechProfileMembership(manifest, modelLock, hostAssets) {
  const failures = [];
  for (const asset of hostAssets.filter((candidate) => candidate.capability === "speech" && candidate.kind === "model")) {
    const lockedCandidate = modelLock.speech?.candidates?.find((candidate) => candidate.id === asset.modelId);
    if (!lockedCandidate) {
      failures.push(`speech model ${asset.modelId ?? "<missing>"} is not declared in model-lock.json`);
      continue;
    }
    if (!lockedCandidate.packageProfiles?.includes(manifest.packageProfile)) {
      failures.push(`speech model ${asset.modelId} is not approved for profile ${manifest.packageProfile}`);
    }
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
    ["language-runtime", "language", "runtime", `assets/llama-completion${process.platform === "win32" ? ".exe" : ""}`, null],
    ["language-model", "language", "model", "assets/language-model.gguf", "language-default"],
    ["general-dictionary", "terminology", "data", "assets/general.candordict", null],
    ["dictionary-publisher-key", "terminology", "public-key", "assets/dictionary-publisher-key.json", null],
  ];
  const assets = definitions.map(([id, capability, kind, relativePath, modelId]) => {
    const content = kind === "public-key"
      ? Buffer.from(JSON.stringify({
        schemaVersion: 2,
        keyId: "fixture-dictionary-key",
        publicKeyBase64: Buffer.alloc(32, 7).toString("base64"),
        rotationGeneration: 1,
      }))
      : Buffer.from(`fixture:${id}`);
    writeFileSync(path.join(root, relativePath), content);
    if (kind === "runtime" && process.platform !== "win32") {
      chmodSync(path.join(root, relativePath), 0o755);
    }
    return {
      id,
      capability,
      kind,
      engine: capability === "speech"
        ? "whisper.cpp"
        : capability === "language"
          ? "llama.cpp"
          : kind === "public-key"
            ? "ed25519"
            : "candor-dictionary-v1",
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
    packageProfile: "complete",
    repairPolicy: "signed-installer-only",
    assets,
  };
  writeFileSync(path.join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function makeSourceInterfaceFixture(root) {
  mkdirSync(path.join(root, "notices"), { recursive: true });
  writeFileSync(
    path.join(root, "notices", "README.md"),
    "# Candor Local AI Notices\n\nNo default model is selected.\n",
  );
  const manifest = {
    manifestVersion: 1,
    bundleVersion: "source-interface-fixture",
    releaseReady: false,
    fixture: false,
    selectionStatus: "no-default-selected",
    packageProfile: "source-interface",
    repairPolicy: "signed-installer-only",
    assets: [],
  };
  writeFileSync(path.join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function requireFailure(result, expectedFailure, rejectedDescription) {
  if (result.ok || !result.failures.some((failure) => failure.includes(expectedFailure))) {
    throw new Error(`${rejectedDescription} was accepted: ${result.failures.join(", ")}`);
  }
}

function runSelfTest() {
  const root = mkdtempSync(path.join(tmpdir(), "candor-ai-bundle-verifier-"));
  try {
    const sourceRoot = path.join(root, "source-interface");
    const sourceManifest = makeSourceInterfaceFixture(sourceRoot);
    const sourceReady = verifyBundle(sourceRoot, { requireSourceInterface: true });
    if (!sourceReady.ok) {
      throw new Error(`valid source-interface fixture failed: ${sourceReady.failures.join(", ")}`);
    }

    const orphanPath = path.join(sourceRoot, "orphan.bin");
    writeFileSync(orphanPath, "orphan");
    requireFailure(
      verifyBundle(sourceRoot, { requireSourceInterface: true }),
      "bundle contains unlisted file orphan.bin",
      "an unlisted bundle file",
    );
    rmSync(orphanPath, { force: true });

    const partialPath = path.join(sourceRoot, "model.bin.part");
    writeFileSync(partialPath, "partial");
    requireFailure(
      verifyBundle(sourceRoot, { requireSourceInterface: true }),
      "prohibited partial or backup path model.bin.part",
      "a stale partial bundle file",
    );
    rmSync(partialPath, { force: true });

    const backupPath = path.join(sourceRoot, "manifest.json.bak");
    writeFileSync(backupPath, "backup");
    requireFailure(
      verifyBundle(sourceRoot, { requireSourceInterface: true }),
      "prohibited partial or backup path manifest.json.bak",
      "a backup bundle file",
    );
    rmSync(backupPath, { force: true });

    const externalDirectory = path.join(root, "symlink-target");
    const symlinkPath = path.join(sourceRoot, "linked-assets");
    mkdirSync(externalDirectory);
    symlinkSync(externalDirectory, symlinkPath, process.platform === "win32" ? "junction" : "dir");
    requireFailure(
      verifyBundle(sourceRoot, { requireSourceInterface: true }),
      "must not be a symbolic link or junction",
      "a bundle symlink or junction",
    );
    rmSync(symlinkPath, { recursive: true, force: true });

    sourceManifest.assets = [{}];
    writeFileSync(path.join(sourceRoot, "manifest.json"), `${JSON.stringify(sourceManifest, null, 2)}\n`);
    requireFailure(
      verifyBundle(sourceRoot, { requireSourceInterface: true }),
      "selectionStatus no-default-selected requires an empty asset inventory",
      "a no-default-selected manifest with assets",
    );
    sourceManifest.assets = [];
    sourceManifest.selectionStatus = "development-selected";
    writeFileSync(path.join(sourceRoot, "manifest.json"), `${JSON.stringify(sourceManifest, null, 2)}\n`);
    requireFailure(
      verifyBundle(sourceRoot, { requireSourceInterface: true }),
      "source-interface selectionStatus must be no-default-selected",
      "a source-interface package with a selected default",
    );
    sourceManifest.selectionStatus = "no-default-selected";
    writeFileSync(path.join(sourceRoot, "manifest.json"), `${JSON.stringify(sourceManifest, null, 2)}\n`);

    const releaseRoot = path.join(root, "release");
    const manifest = makeFixture(releaseRoot);
    const ready = verifyBundle(releaseRoot, { requireReady: true });
    if (!ready.ok) throw new Error(`valid fixture failed: ${ready.failures.join(", ")}`);

    for (const id of ["language-library-core", "language-library-cpu"]) {
      const relativePath = `assets/${id}.dll`;
      const content = Buffer.from(`fixture:${id}`);
      writeFileSync(path.join(releaseRoot, relativePath), content);
      manifest.assets.push({
        id,
        capability: "language",
        kind: "library",
        engine: "llama.cpp",
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
      });
    }
    writeFileSync(path.join(releaseRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const withLibraries = verifyBundle(releaseRoot, { requireReady: true });
    if (!withLibraries.ok) {
      throw new Error(`multiple verified runtime libraries failed: ${withLibraries.failures.join(", ")}`);
    }

    const duplicateAsset = {
      ...manifest.assets[0],
      id: "speech-duplicate",
      modelId: "speech-duplicate",
    };
    manifest.assets.push(duplicateAsset);
    writeFileSync(path.join(releaseRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    requireFailure(
      verifyBundle(releaseRoot),
      "manifest path assets/speech.bin is claimed by both",
      "an exact asset path collision",
    );
    duplicateAsset.relativePath = "assets/SPEECH.bin";
    writeFileSync(path.join(releaseRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    requireFailure(
      verifyBundle(releaseRoot),
      "manifest has a case-insensitive path collision",
      "a case-insensitive asset path collision",
    );
    manifest.assets.pop();
    writeFileSync(path.join(releaseRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

    const fixtureModelLock = {
      speech: {
        selectedModel: "speech-default",
        candidates: [{
          id: "speech-default",
          expectedSha256: manifest.assets[0].sha256,
          bytes: manifest.assets[0].bytes,
          licenseExpression: "MIT",
          benchmarkStatus: "passed",
          redistributionReview: "approved",
          upstreamPublisher: "OpenAI",
          distributionSource: "ggerganov/whisper.cpp",
          distributionRevision: "a".repeat(40),
          revision: "a".repeat(40),
          provenanceStatus: "canonical-whisper-cpp-artifact-pinned",
        }],
      },
      language: {
        selectedModel: "language-default",
        candidates: [{
          id: "language-default",
          expectedSha256: manifest.assets[2].sha256,
          bytes: manifest.assets[2].bytes,
          licenseExpression: "MIT",
          artifactStatus: "official-artifact-pinned",
          benchmarkStatus: "passed",
          redistributionReview: "approved",
        }],
      },
      packageProfiles: { complete: { speechModelIds: ["speech-default"] } },
    };
    const fixtureRuntimeLock = {
      runtimes: [{
        id: "language-runtime",
        commit: "fixture",
        licenseExpression: "MIT",
        compatibilityStatus: "passed",
        redistributionReview: "approved",
      }],
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

    const evidenceFailures = verifyReleaseCandidateEvidence(fixtureModelLock, fixtureRuntimeLock, "complete");
    if (evidenceFailures.length > 0) {
      throw new Error(`valid release candidate evidence failed: ${evidenceFailures.join(", ")}`);
    }
    fixtureModelLock.language.candidates[0].benchmarkStatus = "pending";
    if (!verifyReleaseCandidateEvidence(fixtureModelLock, fixtureRuntimeLock, "complete")
      .some((failure) => failure.includes("has not passed Candor benchmarks"))) {
      throw new Error("an unbenchmarked language model was accepted");
    }
    fixtureModelLock.language.candidates[0].benchmarkStatus = "passed";

    const profileFailures = verifySpeechProfileMembership(
      { packageProfile: "complete" },
      {
        speech: {
          candidates: [
            { id: "speech-default", packageProfiles: ["complete"] },
            { id: "speech-maximum", packageProfiles: ["complete-max"] },
          ],
        },
      },
      [{ capability: "speech", kind: "model", modelId: "speech-maximum" }],
    );
    if (!profileFailures.some((failure) => failure.includes("not approved for profile complete"))) {
      throw new Error("a maximum-only speech model was accepted in the complete profile");
    }

    manifest.assets[0].sha256 = "0".repeat(64);
    writeFileSync(path.join(releaseRoot, "manifest.json"), JSON.stringify(manifest));
    const zeroDigest = verifyBundle(releaseRoot);
    if (zeroDigest.ok) throw new Error("zero digest was accepted");
    if (zeroDigest.verifiedAssets.some((asset) => asset.id === "speech-model")) {
      throw new Error("failed asset was counted as verified");
    }

    manifest.assets[0].sha256 = createHash("sha256").update("fixture:speech-model").digest("hex");
    manifest.unexpected = true;
    writeFileSync(path.join(releaseRoot, "manifest.json"), JSON.stringify(manifest));
    if (verifyBundle(releaseRoot).ok) throw new Error("unknown manifest field was accepted");
    delete manifest.unexpected;

    manifest.assets[0].redistributionApproved = false;
    writeFileSync(path.join(releaseRoot, "manifest.json"), JSON.stringify(manifest));
    if (verifyBundle(releaseRoot).ok) throw new Error("unapproved asset was accepted");
    manifest.assets[0].redistributionApproved = true;

    manifest.assets[0].relativePath = "../escape.bin";
    writeFileSync(path.join(releaseRoot, "manifest.json"), JSON.stringify(manifest));
    if (verifyBundle(releaseRoot).ok) throw new Error("path traversal was accepted");

    manifest.assets[0].relativePath = "assets/speech.bin";
    manifest.fixture = true;
    writeFileSync(path.join(releaseRoot, "manifest.json"), JSON.stringify(manifest));
    if (verifyBundle(releaseRoot, { requireReady: true }).ok) throw new Error("release-ready fixture was accepted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  console.log("SPEC-3 AI bundle verifier self-test passed.");
}

if (selfTest) {
  runSelfTest();
} else {
  if (strict && requireSourceInterface) {
    throw new Error("--require-ready and --require-source-interface are mutually exclusive");
  }
  if (requireSourceInterface && expectedProfile !== null) {
    throw new Error("--profile cannot be used with --require-source-interface");
  }
  if (expectedProfile !== null && !new Set(["complete", "complete-max"]).has(expectedProfile)) {
    throw new Error("--profile must be complete or complete-max");
  }
  const result = verifyBundle(bundleRoot, {
    requireReady: strict,
    requireSourceInterface,
    requiredProfile: expectedProfile,
  });
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
