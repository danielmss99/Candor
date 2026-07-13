import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const proofDir = path.join(repoRoot, "release-v3", "proofs");
const proofPath = path.join(proofDir, `main-architecture-${process.platform}-${process.arch}.json`);
const releaseFlagIndex = process.argv.indexOf("--release-commit");
const requestedReleaseCommit = releaseFlagIndex >= 0 ? process.argv[releaseFlagIndex + 1] : null;

function git(args, options = {}) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
}

function gitTry(args) {
  try { return git(args); } catch { return null; }
}

function refFile(ref, file) {
  return gitTry(["show", `${ref}:${file}`]);
}

function refHas(ref, file) {
  return spawnSync("git", ["cat-file", "-e", `${ref}:${file}`], { cwd: repoRoot, stdio: "ignore" }).status === 0;
}

function isAncestor(commit, descendant) {
  return spawnSync("git", ["merge-base", "--is-ancestor", commit, descendant], { cwd: repoRoot, stdio: "ignore" }).status === 0;
}

const failures = [];
const requiredDirectories = ["electron", "crates/candor-core", "v3/renderer"];
const forbiddenActivePaths = ["src-tauri", "src", ".github/workflows/tauri-build.yml", "tauri.conf.json"];
for (const directory of requiredDirectories) {
  if (!existsSync(path.join(repoRoot, directory))) failures.push(`working tree is missing ${directory}`);
}
for (const item of forbiddenActivePaths) {
  if (existsSync(path.join(repoRoot, item))) failures.push(`working tree still has active legacy path ${item}`);
}

const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const readme = readFileSync(path.join(repoRoot, "README.md"), "utf8");
for (const script of ["dev", "build", "dist"]) {
  const value = packageJson.scripts?.[script] ?? "";
  if (!/electron/i.test(value) && !(script === "dev" && /electron-dev/i.test(value))) failures.push(`default ${script} script is not Electron based`);
}
if (!/Electron/i.test(readme) || !/Rust/i.test(readme)) failures.push("README does not describe the Electron and Rust architecture");

const remoteRef = "origin/main";
const remoteHead = gitTry(["rev-parse", remoteRef]);
if (!remoteHead) {
  failures.push("origin/main is unavailable; fetch the remote before verification");
} else {
  for (const file of ["electron/main.ts", "crates/candor-core/Cargo.toml", "v3/renderer/src/main.tsx", "electron-builder.v3.yml"]) {
    if (!refHas(remoteRef, file)) failures.push(`origin/main is missing ${file}`);
  }
  for (const item of ["src-tauri", ".github/workflows/tauri-build.yml"]) {
    if (refHas(remoteRef, item)) failures.push(`origin/main still has active legacy path ${item}`);
  }
  const remoteReadme = refFile(remoteRef, "README.md") ?? "";
  const remotePackageText = refFile(remoteRef, "package.json") ?? "";
  if (!/Electron/i.test(remoteReadme) || !/Rust/i.test(remoteReadme)) failures.push("origin/main README does not describe Electron and Rust");
  try {
    const remotePackage = JSON.parse(remotePackageText);
    for (const script of ["dev", "build", "dist"]) {
      if (!/electron/i.test(remotePackage.scripts?.[script] ?? "")) failures.push(`origin/main ${script} script is not Electron based`);
    }
  } catch {
    failures.push("origin/main package.json could not be parsed");
  }
}

let releaseCommit = null;
let releaseCommitReachable = null;
if (requestedReleaseCommit) {
  releaseCommit = gitTry(["rev-parse", requestedReleaseCommit]);
  if (!releaseCommit) failures.push(`release commit could not be resolved: ${requestedReleaseCommit}`);
  else if (!remoteHead) failures.push("release reachability cannot be checked without origin/main");
  else {
    releaseCommitReachable = isAncestor(releaseCommit, remoteRef);
    if (!releaseCommitReachable) failures.push(`release commit ${releaseCommit} is not reachable from origin/main`);
  }
}

const proof = {
  proofKind: "candor-main-architecture",
  generatedAt: new Date().toISOString(),
  ok: failures.length === 0,
  workingTree: { head: gitTry(["rev-parse", "HEAD"]), branch: gitTry(["branch", "--show-current"]), requiredDirectories, forbiddenActivePaths },
  remoteMain: { ref: remoteRef, head: remoteHead, electronArchitectureVerified: remoteHead !== null && !failures.some((failure) => failure.startsWith("origin/main")) },
  release: { requested: requestedReleaseCommit, commit: releaseCommit, reachableFromOriginMain: releaseCommitReachable },
  failures,
  networkAttempted: false,
};

mkdirSync(proofDir, { recursive: true });
writeFileSync(proofPath, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
if (failures.length) {
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Electron architecture verified in the working tree and ${remoteRef}.`);
  if (releaseCommit) console.log(`Release commit ${releaseCommit} is reachable from ${remoteRef}.`);
  console.log(`Proof written to ${path.relative(repoRoot, proofPath)}.`);
}
