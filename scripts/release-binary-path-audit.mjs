import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function pathVariants(value) {
  if (!isAbsolute(value)) {
    throw new Error("Release binary path audit roots must be absolute.");
  }
  const absolute = resolve(value);
  return [...new Set([
    absolute,
    absolute.replaceAll("\\", "/"),
    absolute.replaceAll("/", "\\"),
  ])];
}

function containsNeedle(bytes, needle) {
  const exactUtf8 = Buffer.from(needle, "utf8");
  const exactUtf16 = Buffer.from(needle, "utf16le");
  if (bytes.indexOf(exactUtf8) >= 0 || bytes.indexOf(exactUtf16) >= 0) {
    return true;
  }

  const foldedNeedle = needle.toLocaleLowerCase("en-US");
  const latin = bytes.toString("latin1").toLocaleLowerCase("en-US");
  if (latin.includes(foldedNeedle)) {
    return true;
  }
  const wide = bytes.toString("utf16le").toLocaleLowerCase("en-US");
  if (wide.includes(foldedNeedle)) {
    return true;
  }
  if (bytes.length > 1) {
    const wideOffset = bytes.subarray(1).toString("utf16le").toLocaleLowerCase("en-US");
    if (wideOffset.includes(foldedNeedle)) {
      return true;
    }
  }
  return false;
}

export function scanReleaseBinary(bytes, { repoRoot, homeDir = homedir() }) {
  const forbidden = [
    { label: "repository checkout path", value: repoRoot },
    { label: "build user home path", value: homeDir },
  ];
  const findings = [];
  for (const entry of forbidden) {
    if (pathVariants(entry.value).some((needle) => containsNeedle(bytes, needle))) {
      findings.push(entry.label);
    }
  }
  return findings;
}

export function assertReleaseBinariesDoNotExposeBuildPaths(
  binaryPaths,
  { repoRoot, homeDir = homedir(), stage },
) {
  if (!Array.isArray(binaryPaths) || binaryPaths.length !== 3) {
    throw new Error("Release binary path audit requires candor-core and both automation companions.");
  }
  const failures = [];
  for (const binaryPath of binaryPaths) {
    const stat = lstatSync(binaryPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) {
      throw new Error(`Release binary path audit requires a non-empty regular file: ${basename(binaryPath)}`);
    }
    for (const finding of scanReleaseBinary(readFileSync(binaryPath), { repoRoot, homeDir })) {
      failures.push(`${basename(binaryPath)} contains ${finding}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Release binary path audit failed for ${stage}: ${failures.join("; ")}`);
  }
  console.log(`Release binary path audit passed for ${stage} (${binaryPaths.length} binaries).`);
}

export function runReleaseBinaryPathAuditSelfTest() {
  const fixtureRepo = resolve("path-audit-fixtures", "repo", "candor");
  const fixtureHome = resolve("path-audit-fixtures", "users", "builder");
  const benign = Buffer.from("candor release binary", "utf8");
  if (scanReleaseBinary(benign, { repoRoot: fixtureRepo, homeDir: fixtureHome }).length !== 0) {
    throw new Error("Release binary path audit self-test rejected a benign fixture.");
  }

  const repoSlashVariant = fixtureRepo.replaceAll("\\", "/").replaceAll("/", "\\");
  const repoFixture = Buffer.from(`prefix ${repoSlashVariant} suffix`, "utf8");
  const repoFindings = scanReleaseBinary(repoFixture, {
    repoRoot: fixtureRepo,
    homeDir: fixtureHome,
  });
  if (!repoFindings.includes("repository checkout path")) {
    throw new Error("Release binary path audit self-test missed a repository path.");
  }

  const wideHomeFixture = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(`prefix ${fixtureHome} suffix`, "utf16le"),
  ]);
  const homeFindings = scanReleaseBinary(wideHomeFixture, {
    repoRoot: fixtureRepo,
    homeDir: fixtureHome,
  });
  if (!homeFindings.includes("build user home path")) {
    throw new Error("Release binary path audit self-test missed a UTF-16 home path.");
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes("--self-test")) {
    throw new Error("Use --self-test, or import this module from the release build.");
  }
  runReleaseBinaryPathAuditSelfTest();
  console.log("Release binary path audit self-test passed.");
}
