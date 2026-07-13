import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseRoot = path.join(repoRoot, "release-v3");
const proofDir = path.join(releaseRoot, "proofs");
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const packageLock = JSON.parse(readFileSync(path.join(repoRoot, "package-lock.json"), "utf8"));
const cargoLock = readFileSync(path.join(repoRoot, "crates", "candor-core", "Cargo.lock"), "utf8");
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

function namespaceFor(version, gitHead) {
  const bytes = Buffer.from(createHash("sha256").update(`candor:${version}:${gitHead ?? "unknown"}`).digest("hex").slice(0, 32));
  const hex = bytes.toString();
  return `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function cargoPackages() {
  return cargoLock.split("[[package]]").slice(1).flatMap((block) => {
    const name = block.match(/^name = "([^"]+)"/m)?.[1];
    const version = block.match(/^version = "([^"]+)"/m)?.[1];
    const source = block.match(/^source = "([^"]+)"/m)?.[1] ?? "NOASSERTION";
    return name && version ? [{ name, version, source }] : [];
  });
}

const gitHead = gitValue(["rev-parse", "HEAD"]);
const npmEntries = Object.entries(packageLock.packages ?? {}).filter(([location, value]) => location && value && typeof value === "object" && typeof value.version === "string");
const cargoEntries = cargoPackages();
const rootId = "SPDXRef-Package-Candor";
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
}));

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
    ...npmPackages,
    ...rustPackages,
  ],
  relationships: [
    { spdxElementId: "SPDXRef-DOCUMENT", relationshipType: "DESCRIBES", relatedSpdxElement: rootId },
    ...[...npmPackages, ...rustPackages].map((dependency) => ({ spdxElementId: rootId, relationshipType: "DEPENDS_ON", relatedSpdxElement: dependency.SPDXID })),
  ],
  annotations: [{ annotationDate: new Date().toISOString(), annotationType: "OTHER", annotator: "Tool: Candor local SBOM generator", comment: `Source revision: ${gitHead ?? "unavailable"}. The inventory includes locked JavaScript and Rust dependencies.` }],
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
