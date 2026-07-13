import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..");
const releaseRoot = path.resolve(repoRoot, "release-v3");
const checksumPath = path.join(releaseRoot, "SHA256SUMS");
const artifactManifestPath = path.join(
  releaseRoot,
  "proofs",
  `m0-artifact-manifest-${process.platform}-${process.arch}.json`,
);
const proofPath = path.join(
  releaseRoot,
  "proofs",
  `v3-release-checksums-${process.platform}-${process.arch}.json`,
);
const verifyOnly = process.argv.includes("--verify");

function releaseArtifact(name) {
  if (/^SHA256SUMS(?:\.|$)/i.test(name) || /^builder-/i.test(name)) return false;
  return /(?:\.exe|\.dmg|\.AppImage|\.deb|\.rpm|\.blockmap|\.sig|^latest[^/]*\.ya?ml)$/i.test(name);
}

function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function gitValue(args, fallback) {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return fallback;
  }
}

function atomicWrite(filePath, content) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  writeFileSync(temporaryPath, content, "utf8");
  rmSync(filePath, { force: true });
  renameSync(temporaryPath, filePath);
}

function bindArtifactManifest(artifacts, gitHead) {
  if (!existsSync(artifactManifestPath)) {
    throw new Error("M0 artifact manifest is missing; record package provenance before generating checksums");
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(artifactManifestPath, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("M0 artifact manifest is not valid JSON");
  }
  if (manifest?.ok !== true || manifest?.proofKind !== "m0-artifact-manifest") {
    throw new Error("M0 artifact manifest did not pass");
  }
  if (manifest?.git?.head !== gitHead || manifest?.git?.dirty !== false) {
    throw new Error("M0 artifact manifest does not match the clean committed source revision");
  }

  const releaseArtifacts = Array.isArray(manifest?.releaseArtifacts) ? manifest.releaseArtifacts : [];
  if (!releaseArtifacts.length) throw new Error("M0 artifact manifest has no release packages");

  const matchedArtifactNames = [];
  for (const entry of releaseArtifacts) {
    const name = typeof entry?.path === "string" ? path.basename(entry.path) : "";
    const artifact = artifacts.find((candidate) => candidate.name === name);
    if (!name || entry?.exists !== true || !artifact || artifact.sha256 !== entry?.sha256) {
      throw new Error(`release checksum does not match M0 artifact provenance for ${name || "unknown package"}`);
    }
    matchedArtifactNames.push(name);
  }

  return {
    proofKind: manifest.proofKind,
    gitHead: manifest.git.head,
    dirty: manifest.git.dirty,
    artifactCount: releaseArtifacts.length,
    matchedArtifactNames,
  };
}

if (!existsSync(releaseRoot)) {
  throw new Error("release-v3 does not exist; build release artifacts before generating checksums");
}

const names = readdirSync(releaseRoot, { withFileTypes: true })
  .filter((entry) => entry.isFile() && releaseArtifact(entry.name))
  .map((entry) => entry.name)
  .sort((left, right) => left.localeCompare(right));
if (!names.length) throw new Error("no release packages were found for checksum generation");
if (names.some((name) => /[\r\n]/.test(name))) {
  throw new Error("release package names cannot contain line breaks");
}

const artifacts = [];
for (const name of names) {
  const filePath = path.join(releaseRoot, name);
  artifacts.push({ name, sha256: await sha256(filePath) });
}
const expectedText = `${artifacts.map((artifact) => `${artifact.sha256}  ${artifact.name}`).join("\n")}\n`;
const gitHead = gitValue(["rev-parse", "HEAD"], null);
const gitBranch = gitValue(["branch", "--show-current"], null);
const gitStatus = gitValue(["status", "--porcelain", "--untracked-files=no"], null);
const sourceManifest = bindArtifactManifest(artifacts, gitHead);

if (verifyOnly) {
  if (!existsSync(checksumPath)) throw new Error("SHA256SUMS is missing");
  const actualText = readFileSync(checksumPath, "utf8").replace(/\r\n/g, "\n");
  if (actualText !== expectedText) throw new Error("SHA256SUMS does not match the current release packages");
  if (gitStatus === null) throw new Error("tracked source state could not be verified");
  if (gitStatus.length > 0) throw new Error("tracked source tree must be clean before checksum verification");
  if (typeof gitHead !== "string" || !/^[a-f0-9]{40}$/.test(gitHead)) {
    throw new Error("committed source revision could not be verified");
  }
} else {
  atomicWrite(checksumPath, expectedText);
}

const proof = {
  proofKind: "v3-release-checksums",
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  ok: true,
  mode: verifyOnly ? "verify" : "generate",
  artifactCount: artifacts.length,
  artifacts,
  sourceManifest,
  git: {
    head: gitHead,
    branch: gitBranch,
    dirty: gitStatus === null ? null : gitStatus.length > 0,
  },
  localOnly: true,
  cloudAi: false,
  networkAttempted: false,
  rawPathExposed: false,
  keyMaterialExposed: false,
};
atomicWrite(proofPath, `${JSON.stringify(proof, null, 2)}\n`);
console.log(`V3 release checksums ${verifyOnly ? "verified" : "generated"}: ${path.relative(repoRoot, checksumPath)}`);
console.log(`Proof written to ${path.relative(repoRoot, proofPath)}.`);
