import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const packageLock = JSON.parse(readFileSync(path.join(repoRoot, "package-lock.json"), "utf8"));
const builder = readFileSync(path.join(repoRoot, "electron-builder.v3.yml"), "utf8");
const rendererHtml = readFileSync(path.join(repoRoot, "v3", "renderer", "index.html"), "utf8");
const mainSource = readFileSync(path.join(repoRoot, "electron", "main.ts"), "utf8");
const coreManifest = readFileSync(path.join(repoRoot, "crates", "candor-core", "Cargo.toml"), "utf8");
const decision = readFileSync(path.join(repoRoot, "docs", "implementation", "spec2", "product-identity-decision.md"), "utf8");
const proofDir = path.join(repoRoot, "release-v3", "proofs");
const proofPath = path.join(proofDir, `product-identity-${process.platform}-${process.arch}.json`);

function gitValue(args) {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function yamlValue(source, key) {
  const match = source.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim().replace(/^['"]|['"]$/g, "") ?? "";
}

const appId = yamlValue(builder, "appId");
const productName = yamlValue(builder, "productName");
const appUserModelId = mainSource.match(/setAppUserModelId\("([^"]+)"\)/)?.[1] ?? "";
const coreVersion = coreManifest.match(/^version\s*=\s*"([^"]+)"/m)?.[1] ?? "";
const failures = [];

if (packageJson.name !== "candor") failures.push("package name must be candor");
if (productName !== "Candor" || packageJson.desktopName !== "Candor") failures.push("desktop and installer names must be Candor");
if (!/^0\.\d+\.\d+$/.test(packageJson.version)) failures.push("product version must use 0.x.y SemVer before beta");
if (packageLock.version !== packageJson.version || packageLock.packages?.[""]?.version !== packageJson.version) failures.push("package lock identity does not match package.json");
if (coreVersion !== packageJson.version) failures.push("Rust core version does not match package.json");
if (/<title>Candor<\/title>/.test(rendererHtml) !== true) failures.push("window title must be Candor");
if (/\b(?:v3|v4|m0)\b/i.test(packageJson.description)) failures.push("public package description contains an internal generation name");
if (!appId || appUserModelId !== appId) failures.push("builder app ID and Windows App User Model ID must match");
if (appId === "com.candor.desktop") {
  if (!/upgrade test.+proved/is.test(decision)) failures.push("stable app ID requires documented upgrade proof");
} else if (appId === "com.candor.v3") {
  if (!/migration is deferred/i.test(decision)) failures.push("legacy app ID requires an explicit deferred migration decision");
} else {
  failures.push(`unsupported app ID strategy: ${appId || "missing"}`);
}

const proof = {
  proofKind: "candor-product-identity",
  generatedAt: new Date().toISOString(),
  ok: failures.length === 0,
  identity: {
    packageName: packageJson.name,
    productName,
    version: packageJson.version,
    coreVersion,
    windowTitle: rendererHtml.includes("<title>Candor</title>") ? "Candor" : null,
    appId,
    appUserModelId,
    appIdMigration: appId === "com.candor.desktop" ? "proven" : "deferred-pending-upgrade-proof",
  },
  git: { head: gitValue(["rev-parse", "HEAD"]), branch: gitValue(["branch", "--show-current"]) },
  failures,
  localOnly: true,
  networkAttempted: false,
};

mkdirSync(proofDir, { recursive: true });
writeFileSync(proofPath, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
if (failures.length) {
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Candor product identity verified at ${packageJson.version}.`);
  console.log(`Proof written to ${path.relative(repoRoot, proofPath)}.`);
}
