import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseRoot = path.join(repoRoot, "release-v3");
const proofDir = path.join(releaseRoot, "proofs");
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const packageLock = JSON.parse(readFileSync(path.join(repoRoot, "package-lock.json"), "utf8"));
const cargoLockFiles = [
  "crates/candor-core/Cargo.lock",
  "crates/candor-tools/Cargo.lock",
];
const cargoLocks = cargoLockFiles.map((relativePath) => ({
  relativePath,
  contents: readFileSync(path.join(repoRoot, ...relativePath.split("/")), "utf8"),
}));
const companionManifest = readFileSync(
  path.join(repoRoot, "crates", "candor-tools", "Cargo.toml"),
  "utf8",
);
const aiBundleRoot = path.join(repoRoot, "build", "ai-bundle");
const aiBundleManifestPath = path.join(aiBundleRoot, "manifest.json");
const verifyOnly = process.argv.includes("--verify");
const sbomName = `Candor-${packageJson.version}-SBOM.spdx.json`;
const sbomPath = path.join(releaseRoot, sbomName);
const proofPath = path.join(proofDir, `v3-release-sbom-${process.platform}-${process.arch}.json`);

function gitValue(args) {
  try { return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return null; }
}

function spdxId(ecosystem, name, version, index) {
  const safe = `${ecosystem}-${name}-${version}-${index}`.replace(/[^A-Za-z0-9.-]+/g, "-");
  return `SPDXRef-Package-${safe}`;
}

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

function namespaceFor(version, gitHead) {
  const bytes = Buffer.from(createHash("sha256").update(`candor:${version}:${gitHead ?? "unknown"}`).digest("hex").slice(0, 32));
  const hex = bytes.toString();
  return `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function cargoPackages() {
  const packages = new Map();
  for (const lock of cargoLocks) {
    for (const block of lock.contents.split("[[package]]").slice(1)) {
      const name = block.match(/^name = "([^"]+)"/m)?.[1];
      const version = block.match(/^version = "([^"]+)"/m)?.[1];
      const source = block.match(/^source = "([^"]+)"/m)?.[1] ?? "NOASSERTION";
      if (!name || !version) continue;
      const key = `${name}\u0000${version}\u0000${source}`;
      const existing = packages.get(key);
      if (existing) {
        existing.lockFiles.push(lock.relativePath);
      } else {
        packages.set(key, { name, version, source, lockFiles: [lock.relativePath] });
      }
    }
  }
  return [...packages.values()].sort((left, right) =>
    `${left.name}\u0000${left.version}\u0000${left.source}`.localeCompare(
      `${right.name}\u0000${right.version}\u0000${right.source}`,
    ),
  );
}

function bundledAiAssets() {
  if (!existsSync(aiBundleManifestPath)) return [];
  let manifest;
  try { manifest = JSON.parse(readFileSync(aiBundleManifestPath, "utf8")); }
  catch { throw new Error("build/ai-bundle/manifest.json is not valid JSON"); }
  if (!Array.isArray(manifest.assets)) throw new Error("build/ai-bundle/manifest.json assets must be an array");
  const canonicalRoot = realpathSync.native(aiBundleRoot);
  return manifest.assets.map((asset, index) => {
    if (!asset || typeof asset !== "object" || typeof asset.id !== "string") {
      throw new Error(`AI bundle asset ${index} is invalid`);
    }
    const candidate = path.resolve(aiBundleRoot, String(asset.relativePath ?? ""));
    const relative = path.relative(aiBundleRoot, candidate);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`AI bundle asset ${asset.id} escapes the bundle root`);
    }
    if (!existsSync(candidate)) throw new Error(`AI bundle asset ${asset.id} is missing`);
    const state = lstatSync(candidate);
    if (state.isSymbolicLink() || !state.isFile()) {
      throw new Error(`AI bundle asset ${asset.id} must be a regular non-symlink file`);
    }
    const canonicalCandidate = realpathSync.native(candidate);
    const canonicalRelative = path.relative(canonicalRoot, canonicalCandidate);
    if (!canonicalRelative || canonicalRelative.startsWith("..") || path.isAbsolute(canonicalRelative)) {
      throw new Error(`AI bundle asset ${asset.id} canonical path escapes the bundle root`);
    }
    if (state.size !== asset.bytes) throw new Error(`AI bundle asset ${asset.id} byte count does not match`);
    if (asset.redistributionApproved !== true) {
      throw new Error(`AI bundle asset ${asset.id} is not approved for redistribution`);
    }
    const actual = sha256File(candidate);
    if (actual.toLowerCase() !== String(asset.sha256 ?? "").toLowerCase()) {
      throw new Error(`AI bundle asset ${asset.id} does not match its manifest digest`);
    }
    return { ...asset, actualSha256: actual };
  });
}

const gitHead = gitValue(["rev-parse", "HEAD"]);
const npmEntries = Object.entries(packageLock.packages ?? {}).filter(([location, value]) => location && value && typeof value === "object" && typeof value.version === "string");
const cargoEntries = cargoPackages();
const bundledEntries = bundledAiAssets();
const rootId = "SPDXRef-Package-Candor";
const companionVersion = companionManifest.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const companionLicense = companionManifest.match(/^license\s*=\s*"([^"]+)"/m)?.[1];
if (!companionVersion || !companionLicense) {
  throw new Error("crates/candor-tools/Cargo.toml must declare version and license");
}
const npmPackages = npmEntries.map(([location, value], index) => {
  const name = value.name ?? location.replace(/^node_modules\//, "");
  const id = spdxId("npm", name, value.version, index);
  return {
    SPDXID: id,
    name,
    versionInfo: value.version,
    downloadLocation: typeof value.resolved === "string" ? value.resolved : "NOASSERTION",
    filesAnalyzed: false,
    licenseConcluded: "NOASSERTION",
    licenseDeclared: typeof value.license === "string" ? value.license : "NOASSERTION",
    copyrightText: "NOASSERTION",
    externalRefs: [{ referenceCategory: "PACKAGE-MANAGER", referenceType: "purl", referenceLocator: `pkg:npm/${encodeURIComponent(name)}@${value.version}` }],
    primaryPackagePurpose: "LIBRARY",
  };
});
const rustPackages = cargoEntries.map((value, index) => ({
  SPDXID: spdxId("cargo", value.name, value.version, index),
  name: value.name,
  versionInfo: value.version,
  downloadLocation: value.source,
  filesAnalyzed: false,
  licenseConcluded: "NOASSERTION",
  licenseDeclared: "NOASSERTION",
  copyrightText: "NOASSERTION",
  externalRefs: [{ referenceCategory: "PACKAGE-MANAGER", referenceType: "purl", referenceLocator: `pkg:cargo/${encodeURIComponent(value.name)}@${value.version}` }],
  primaryPackagePurpose: "LIBRARY",
  comment: `Locked by ${value.lockFiles.join(" and ")}.`,
}));
const companionPackages = ["candorctl", "candor-mcp"].map((name) => ({
  SPDXID: `SPDXRef-Package-${name}`,
  name,
  versionInfo: companionVersion,
  downloadLocation: "NOASSERTION",
  filesAnalyzed: false,
  licenseConcluded: companionLicense,
  licenseDeclared: companionLicense,
  copyrightText: "NOASSERTION",
  primaryPackagePurpose: "APPLICATION",
  comment: "Read-only local Candor automation companion packaged beside candor-core.",
}));
const bundledPackages = bundledEntries.map((value, index) => ({
  SPDXID: spdxId("candor-ai", value.id, value.revision, index),
  name: value.id,
  versionInfo: value.revision,
  downloadLocation: value.sourceUrl,
  filesAnalyzed: false,
  checksums: [{ algorithm: "SHA256", checksumValue: value.actualSha256 }],
  licenseConcluded: value.licenseExpression,
  licenseDeclared: value.licenseExpression,
  copyrightText: "NOASSERTION",
  primaryPackagePurpose: "FILE",
  comment: `Candor bundled ${value.capability} ${value.kind}; redistribution approved: ${value.redistributionApproved === true}.`,
}));
const downloadableModelPackages = [
  {
    SPDXID: "SPDXRef-Package-candor-download-parakeet-tdt-0.6b-v3-int8",
    name: "NVIDIA Parakeet TDT 0.6B V3 INT8 sherpa-onnx conversion",
    versionInfo: "876ff91b4ab4b89c328afdb2b27ff879d3e42f87",
    downloadLocation: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2",
    filesAnalyzed: false,
    checksums: [{ algorithm: "SHA256", checksumValue: "5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf" }],
    licenseConcluded: "CC-BY-4.0",
    licenseDeclared: "CC-BY-4.0",
    copyrightText: "Copyright NVIDIA Corporation",
    primaryPackagePurpose: "FILE",
    comment: "Optional local speech model downloaded only after explicit user action. The pinned archive is 487170055 bytes and is not bundled in the installer.",
  },
];
const buildArchivePackages = [
  {
    SPDXID: "SPDXRef-Package-sherpa-onnx-win-x64-static-MT-1.13.4",
    name: "sherpa-onnx Windows x64 static MT runtime archive",
    versionInfo: "1.13.4",
    downloadLocation: "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.4/sherpa-onnx-v1.13.4-win-x64-static-MT-Release-lib.tar.bz2",
    filesAnalyzed: false,
    checksums: [{ algorithm: "SHA256", checksumValue: "d81bd1d25112540862d2387072e76b2b6843ef962918d6b5c7db5a19c6276b4c" }],
    licenseConcluded: "Apache-2.0 AND MIT",
    licenseDeclared: "Apache-2.0 AND MIT",
    copyrightText: "NOASSERTION",
    primaryPackagePurpose: "LIBRARY",
    comment: "Pinned 119847445-byte build input for the statically linked sherpa-onnx and ONNX Runtime Windows CPU runtime.",
  },
];

const document = {
  spdxVersion: "SPDX-2.3",
  dataLicense: "CC0-1.0",
  SPDXID: "SPDXRef-DOCUMENT",
  name: `Candor ${packageJson.version} release SBOM`,
  documentNamespace: namespaceFor(packageJson.version, gitHead),
  creationInfo: { created: new Date().toISOString(), creators: ["Tool: Candor local SBOM generator"] },
  documentDescribes: [rootId],
  packages: [
    {
      SPDXID: rootId,
      name: "Candor",
      versionInfo: packageJson.version,
      downloadLocation: "NOASSERTION",
      filesAnalyzed: false,
      licenseConcluded: packageJson.license ?? "NOASSERTION",
      licenseDeclared: packageJson.license ?? "NOASSERTION",
      copyrightText: "NOASSERTION",
      primaryPackagePurpose: "APPLICATION",
    },
    ...companionPackages,
    ...npmPackages,
    ...rustPackages,
    ...bundledPackages,
    ...downloadableModelPackages,
    ...buildArchivePackages,
  ],
  relationships: [
    { spdxElementId: "SPDXRef-DOCUMENT", relationshipType: "DESCRIBES", relatedSpdxElement: rootId },
    ...companionPackages.map((companion) => ({ spdxElementId: rootId, relationshipType: "CONTAINS", relatedSpdxElement: companion.SPDXID })),
    ...[...npmPackages, ...rustPackages, ...bundledPackages].map((dependency) => ({ spdxElementId: rootId, relationshipType: "DEPENDS_ON", relatedSpdxElement: dependency.SPDXID })),
    ...downloadableModelPackages.map((dependency) => ({ spdxElementId: dependency.SPDXID, relationshipType: "OPTIONAL_COMPONENT_OF", relatedSpdxElement: rootId })),
    ...buildArchivePackages.map((dependency) => ({ spdxElementId: dependency.SPDXID, relationshipType: "BUILD_DEPENDENCY_OF", relatedSpdxElement: rootId })),
  ],
  annotations: [{ annotationDate: new Date().toISOString(), annotationType: "OTHER", annotator: "Tool: Candor local SBOM generator", comment: `Source revision: ${gitHead ?? "unavailable"}. The inventory includes locked JavaScript dependencies, both Rust lockfiles, packaged automation companions, every asset listed in the packaged AI manifest, explicitly downloadable model packages, and pinned native build archives.` }],
};

function validate(value) {
  const failures = [];
  if (value?.spdxVersion !== "SPDX-2.3") failures.push("SPDX version must be 2.3");
  if (value?.dataLicense !== "CC0-1.0") failures.push("SPDX data license must be CC0-1.0");
  if (value?.documentNamespace !== document.documentNamespace) failures.push("SBOM namespace does not match product version and source revision");
  const packages = Array.isArray(value?.packages) ? value.packages : [];
  const root = packages.find((entry) => entry?.SPDXID === rootId);
  if (root?.versionInfo !== packageJson.version) failures.push("SBOM root package version does not match package.json");
  if (packages.length !== document.packages.length) failures.push("SBOM package count does not match current lock files");
  for (const expected of companionPackages) {
    const actual = packages.find((entry) => entry?.SPDXID === expected.SPDXID);
    if (!actual) failures.push(`SBOM is missing companion binary ${expected.name}`);
    else if (
      actual.versionInfo !== companionVersion ||
      actual.licenseDeclared !== companionLicense ||
      actual.primaryPackagePurpose !== "APPLICATION"
    ) {
      failures.push(`SBOM companion metadata is invalid for ${expected.name}`);
    }
  }
  for (const expected of bundledPackages) {
    const actual = packages.find((entry) => entry?.SPDXID === expected.SPDXID);
    if (!actual) failures.push(`SBOM is missing bundled AI asset ${expected.name}`);
    else if (actual.checksums?.[0]?.checksumValue !== expected.checksums[0].checksumValue) {
      failures.push(`SBOM digest does not match bundled AI asset ${expected.name}`);
    }
  }
  for (const expected of [...downloadableModelPackages, ...buildArchivePackages]) {
    const actual = packages.find((entry) => entry?.SPDXID === expected.SPDXID);
    if (!actual) failures.push(`SBOM is missing pinned package ${expected.name}`);
    else if (
      actual.versionInfo !== expected.versionInfo
      || actual.downloadLocation !== expected.downloadLocation
      || actual.licenseDeclared !== expected.licenseDeclared
      || actual.checksums?.[0]?.checksumValue !== expected.checksums[0].checksumValue
    ) {
      failures.push(`SBOM metadata is invalid for pinned package ${expected.name}`);
    }
  }
  if (!Array.isArray(value?.relationships) || value.relationships.length !== document.relationships.length) failures.push("SBOM dependency relationship count is incomplete");
  return failures;
}

mkdirSync(releaseRoot, { recursive: true });
mkdirSync(proofDir, { recursive: true });
let candidate = document;
if (verifyOnly) {
  if (!existsSync(sbomPath)) throw new Error(`${sbomName} is missing`);
  try { candidate = JSON.parse(readFileSync(sbomPath, "utf8")); }
  catch { throw new Error(`${sbomName} is not valid JSON`); }
} else {
  writeFileSync(sbomPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
}
const failures = validate(candidate);
const sbomBytes = readFileSync(sbomPath);
const proof = {
  proofKind: "v3-release-sbom",
  generatedAt: new Date().toISOString(),
  ok: failures.length === 0,
  mode: verifyOnly ? "verify" : "generate",
  file: sbomName,
  sha256: createHash("sha256").update(sbomBytes).digest("hex"),
  bytes: sbomBytes.length,
  packageCount: candidate.packages?.length ?? 0,
  npmPackageCount: npmPackages.length,
  rustPackageCount: rustPackages.length,
  rustLockFileCount: cargoLockFiles.length,
  companionBinaryPackageCount: companionPackages.length,
  bundledAiPackageCount: bundledPackages.length,
  downloadableModelPackageCount: downloadableModelPackages.length,
  buildArchivePackageCount: buildArchivePackages.length,
  git: { head: gitHead, branch: gitValue(["branch", "--show-current"]) },
  failures,
  networkAttempted: false,
  rawPathExposed: false,
};
writeFileSync(proofPath, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
if (failures.length) {
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Candor SPDX SBOM ${verifyOnly ? "verified" : "generated"}: ${path.relative(repoRoot, sbomPath)}`);
  console.log(`Proof written to ${path.relative(repoRoot, proofPath)}.`);
}
