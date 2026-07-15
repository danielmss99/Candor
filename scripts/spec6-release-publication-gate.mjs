import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const rootIndex = args.indexOf("--root");
const releaseRoot = rootIndex >= 0
  ? path.resolve(args[rootIndex + 1] ?? "")
  : path.join(repoRoot, "release-v3");
const allowEmpty = args.includes("--allow-empty");
const maximumBytes = 2 * 1024 * 1024 * 1024;
const publishableExtensions = [
  ".exe",
  ".dmg",
  ".appimage",
  ".deb",
  ".rpm",
  ".zip",
  ".7z",
  ".blockmap",
];

if (args.includes("--self-test")) {
  runSelfTest();
  process.exit(0);
}

const failures = [];
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const publicationCommand = packageJson?.scripts?.["release:publication-gate"];
if (
  typeof publicationCommand !== "string"
  || !publicationCommand.includes("v3:release-readiness-audit:strict")
) {
  failures.push("the final publication command must require the strict V3 external-evidence audit");
}
const configPath = path.join(repoRoot, "electron-builder.v3.yml");
const config = yaml.load(readFileSync(configPath, "utf8"));
const windowsTargets = normalizeTargets(config?.win?.target);
if (windowsTargets.length === 0 || !windowsTargets.includes("nsis")) {
  failures.push("the offline Windows release must include the NSIS target");
}
if (windowsTargets.includes("nsis-web")) {
  failures.push("NSIS web installers are prohibited because Candor must install offline");
}

const inspected = inspectReleaseAssets(releaseRoot, allowEmpty);
const assets = inspected.assets;
failures.push(...inspected.failures);

const proofDirectory = path.join(repoRoot, "release-v3", "proofs");
mkdirSync(proofDirectory, { recursive: true });
const proofPath = path.join(
  proofDirectory,
  `spec6-release-publication-${process.platform}-${process.arch}.json`,
);
writeFileSync(proofPath, `${JSON.stringify({
  proofKind: "spec6-release-publication",
  generatedAt: new Date().toISOString(),
  ok: failures.length === 0,
  maximumAssetBytesExclusive: maximumBytes,
  offlineInstallerTarget: "nsis",
  nsisWebAllowed: false,
  assets,
  failures,
}, null, 2)}\n`);

if (failures.length > 0) {
  process.stderr.write(`SPEC-6 release publication gate failed:\n- ${failures.join("\n- ")}\n`);
  process.exit(1);
}
process.stdout.write(`SPEC-6 release publication gate passed for ${assets.length} asset(s).\n`);

function normalizeTargets(value) {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return values.flatMap((entry) => {
    if (typeof entry === "string") return [entry.toLowerCase()];
    if (entry && typeof entry === "object" && typeof entry.target === "string") {
      return [entry.target.toLowerCase()];
    }
    return [];
  });
}

function inspectReleaseAssets(root, permitEmpty) {
  const inspectedAssets = [];
  const inspectedFailures = [];
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const lowerName = entry.name.toLowerCase();
      if (!publishableExtensions.some((extension) => lowerName.endsWith(extension))) continue;
      const assetPath = path.join(root, entry.name);
      const state = lstatSync(assetPath);
      if (state.isSymbolicLink() || !state.isFile()) {
        inspectedFailures.push(`${entry.name} is not a regular release asset`);
        continue;
      }
      inspectedAssets.push({ name: entry.name, bytes: state.size });
      if (state.size >= maximumBytes) {
        inspectedFailures.push(`${entry.name} is not under GitHub's 2 GiB per-asset limit`);
      }
    }
  } catch {
    if (!permitEmpty) inspectedFailures.push("the release output directory is unavailable");
  }
  if (!permitEmpty && inspectedAssets.length === 0) {
    inspectedFailures.push("no publishable release assets were found");
  }
  return { assets: inspectedAssets, failures: inspectedFailures };
}

function runSelfTest() {
  const root = mkdtempSync(path.join(os.tmpdir(), "candor-spec6-publication-"));
  try {
    const acceptable = path.join(root, "Candor Setup.exe");
    writeFileSync(acceptable, "fixture");
    const normal = inspectReleaseAssets(root, false);
    if (normal.failures.length !== 0 || normal.assets.length !== 1) {
      throw new Error("an ordinary release asset did not pass publication inspection");
    }

    const oversized = path.join(root, "Candor Complete Max.zip");
    writeFileSync(oversized, "");
    truncateSync(oversized, maximumBytes);
    const blocked = inspectReleaseAssets(root, false);
    if (!blocked.failures.some((failure) => failure.includes("is not under GitHub's 2 GiB"))) {
      throw new Error("a release asset at GitHub's exclusive limit was not blocked");
    }
    process.stdout.write("SPEC-6 release publication gate self-test passed.\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
