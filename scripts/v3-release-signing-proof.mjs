import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function asPath(pathValue) {
  return resolve(repoRoot, pathValue);
}

const releaseDir = asPath(argValue("--release-dir", "release-v3"));
const proofDir = asPath(argValue("--proof-dir", "release-v3/proofs"));

function rel(pathValue) {
  return relative(repoRoot, pathValue).replaceAll("\\", "/");
}

function sha256(pathValue) {
  const hash = createHash("sha256");
  hash.update(readFileSync(pathValue));
  return hash.digest("hex");
}

function sanitize(value) {
  const repoRootForward = repoRoot.replaceAll("\\", "/");
  return String(value ?? "")
    .replaceAll(repoRoot, ".")
    .replaceAll(repoRootForward, ".")
    .replaceAll("\\", "/");
}

function fileEvidence(pathValue) {
  if (!pathValue || !existsSync(pathValue)) {
    return {
      path: pathValue ? rel(pathValue) : null,
      exists: false,
    };
  }
  const stat = statSync(pathValue);
  const evidence = {
    path: rel(pathValue),
    exists: true,
    bytes: stat.size,
    isDirectory: stat.isDirectory(),
  };
  if (!stat.isDirectory()) {
    evidence.sha256 = sha256(pathValue);
  }
  return evidence;
}

function releaseFilesMatching(predicate) {
  if (!existsSync(releaseDir)) return [];
  return readdirSync(releaseDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && predicate(entry.name))
    .map((entry) => join(releaseDir, entry.name));
}

function currentPlatformReleaseArtifactFiles() {
  if (process.platform === "win32") {
    return releaseFilesMatching((name) => /\.exe$/i.test(name) && /setup|installer|candor/i.test(name));
  }
  if (process.platform === "darwin") {
    return releaseFilesMatching((name) => /\.dmg$/i.test(name));
  }
  return releaseFilesMatching((name) => /\.AppImage$/i.test(name) || /\.deb$/i.test(name));
}

function proofFilesMatching(predicate) {
  if (!existsSync(proofDir)) return [];
  return readdirSync(proofDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && predicate(entry.name))
    .map((entry) => join(proofDir, entry.name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

function readJsonIfPresent(pathValue) {
  if (!pathValue || !existsSync(pathValue)) return null;
  try {
    return JSON.parse(readFileSync(pathValue, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

function hashByPath(entries) {
  const map = new Map();
  for (const entry of entries ?? []) {
    if (entry?.path && entry?.sha256) {
      const normalized = String(entry.path).replaceAll("\\", "/");
      map.set(normalized, entry.sha256);
      map.set(rel(resolve(repoRoot, entry.path)), entry.sha256);
    }
  }
  return map;
}

function artifactConsistency() {
  const manifestPath = proofFilesMatching((name) => new RegExp(`^m0-artifact-manifest-${process.platform}-.+\\.json$`).test(name))[0] ?? null;
  const smokePath = proofFilesMatching((name) => new RegExp(`^v3-release-artifact-smoke-${process.platform}-.+\\.json$`).test(name))[0] ?? null;
  const manifest = readJsonIfPresent(manifestPath);
  const smoke = readJsonIfPresent(smokePath);
  const manifestReleaseHashes = hashByPath(manifest?.releaseArtifacts);
  const failures = [];

  if (!manifestPath || !manifest) failures.push("M0 artifact manifest proof is missing or unreadable");
  if (!smokePath || !smoke) failures.push("release artifact smoke proof is missing or unreadable");
  if (manifest && manifest.ok !== true) failures.push("M0 artifact manifest proof is not passing");
  if (smoke && smoke.ok !== true) failures.push("release artifact smoke proof is not passing");

  const releaseArtifactsMatchManifest = [];
  for (const artifact of currentPlatformReleaseArtifactFiles().map(fileEvidence)) {
    const manifestHash = manifestReleaseHashes.get(artifact.path);
    const matches = Boolean(manifestHash) && manifestHash === artifact.sha256;
    releaseArtifactsMatchManifest.push({
      path: artifact.path,
      sha256: artifact.sha256,
      manifestSha256: manifestHash ?? null,
      matches,
    });
    if (!matches) failures.push(`release artifact does not match M0 artifact manifest: ${artifact.path}`);
  }

  const smokeArtifacts = [
    smoke?.currentPlatform?.installer,
    smoke?.currentPlatform?.appImage,
    smoke?.currentPlatform?.deb,
  ].filter((entry) => entry?.path);
  const smokeArtifactsMatchRelease =
    smokeArtifacts.length > 0 &&
    smokeArtifacts.every((smokeArtifact) =>
      releaseArtifactsMatchManifest.some(
        (entry) => entry.path === smokeArtifact.path && entry.sha256 === smokeArtifact.sha256,
      ),
    );
  if (smoke && smokeArtifactsMatchRelease !== true) {
    failures.push("release artifact smoke hash does not match signing proof release artifact hash");
  }

  const payloadMatches = Array.isArray(smoke?.currentPlatform?.requiredEntries)
    ? smoke.currentPlatform.requiredEntries.map((entry) => ({
        extractedPath: entry?.extractedPath ?? null,
        exists: entry?.exists === true,
        hashMatchesUnpacked: entry?.hashMatchesUnpacked ?? null,
      }))
    : [];
  if (process.platform === "win32") {
    for (const expected of [
      "Candor.exe",
      "resources/app.asar",
      "resources/bin/candor-core.exe",
      "resources/bin/candorctl.exe",
      "resources/bin/candor-mcp.exe",
    ]) {
      const entry = payloadMatches.find((candidate) => candidate.extractedPath === expected);
      if (!entry || entry.hashMatchesUnpacked !== true) {
        failures.push(`release artifact smoke payload is not tied to unpacked output: ${expected}`);
      }
    }
  }

  return {
    ok: failures.length === 0,
    manifest: manifestPath
      ? {
          path: rel(manifestPath),
          ok: manifest?.ok === true,
        }
      : null,
    releaseArtifactSmoke: smokePath
      ? {
          path: rel(smokePath),
          ok: smoke?.ok === true,
        }
      : null,
    releaseArtifactsMatchManifest,
    smokeArtifactsMatchRelease,
    payloadMatches,
    failures,
  };
}

function boolEnv(names) {
  return Object.fromEntries(names.map((name) => [name, Boolean(process.env[name])]));
}

function commandOnPath(names) {
  const command = process.platform === "win32" ? "where.exe" : "which";
  for (const name of names) {
    const result = spawnSync(command, [name], {
      cwd: repoRoot,
      encoding: "utf8",
      shell: false,
    });
    const first = result.stdout?.split(/\r?\n/).find(Boolean);
    if (result.status === 0 && first && existsSync(first.trim())) {
      return {
        path: first.trim(),
        source: "path",
      };
    }
  }
  return null;
}

function detachedSignatureFiles(artifactPath) {
  return [".asc", ".sig", ".gpg", ".minisig"]
    .map((suffix) => `${artifactPath}${suffix}`)
    .filter((pathValue) => existsSync(pathValue));
}

function runSignatureVerification(artifactPath, signaturePath) {
  const signatureName = signaturePath.split(/[\\/]/).at(-1) ?? "";
  const isMinisig = /\.minisig$/i.test(signatureName);
  const tool = isMinisig ? commandOnPath(["minisign"]) : commandOnPath(["gpg", "gpg.exe"]);
  if (!tool) {
    return {
      signature: rel(signaturePath),
      checked: false,
      valid: false,
      reason: isMinisig ? "minisign-not-found" : "gpg-not-found",
    };
  }

  const args = isMinisig
    ? ["-Vm", artifactPath, "-x", signaturePath]
    : ["--batch", "--verify", signaturePath, artifactPath];
  const result = spawnSync(tool.path, args, {
    cwd: repoRoot,
    encoding: "utf8",
    shell: false,
  });
  return {
    signature: rel(signaturePath),
    checked: true,
    valid: result.status === 0,
    tool: isMinisig ? "minisign" : "gpg",
    exitCode: result.status,
    stdout: sanitize(result.stdout),
    stderr: sanitize(result.stderr),
  };
}

function packageSignatureEvidence(artifactPath) {
  const signatures = detachedSignatureFiles(artifactPath).map(fileEvidence);
  const verifications = detachedSignatureFiles(artifactPath).map((signaturePath) =>
    runSignatureVerification(artifactPath, signaturePath),
  );
  return {
    artifact: fileEvidence(artifactPath),
    signatures,
    signaturePresent: signatures.length > 0,
    verificationAttempted: verifications.some((entry) => entry.checked === true),
    verified: verifications.some((entry) => entry.valid === true),
    verifications,
  };
}

function runMacTool(toolName, args) {
  if (process.platform !== "darwin") {
    return {
      checked: false,
      valid: false,
      reason: "not-macos",
      tool: toolName,
      args: args.map(sanitize),
    };
  }

  const tool = commandOnPath([toolName]);
  if (!tool) {
    return {
      checked: false,
      valid: false,
      reason: `${toolName}-not-found`,
      tool: toolName,
      args: args.map(sanitize),
    };
  }

  const result = spawnSync(tool.path, args, {
    cwd: repoRoot,
    encoding: "utf8",
    shell: false,
  });
  return {
    checked: true,
    valid: result.status === 0,
    tool: toolName,
    exitCode: result.status,
    args: args.map(sanitize),
    stdout: sanitize(result.stdout),
    stderr: sanitize(result.stderr),
  };
}

function macosSignatureEvidence(dmgPaths, appBundlePaths) {
  const appBundles = appBundlePaths.map((appPath) => {
    const codesignVerify = runMacTool("codesign", [
      "--verify",
      "--deep",
      "--strict",
      "--verbose=2",
      appPath,
    ]);
    const codesignDisplay = runMacTool("codesign", ["--display", "--verbose=4", appPath]);
    const gatekeeperAssess = runMacTool("spctl", [
      "--assess",
      "--type",
      "execute",
      "--verbose=4",
      appPath,
    ]);
    const staplerValidate = runMacTool("xcrun", ["stapler", "validate", appPath]);
    const companionSignatures = ["candorctl", "candor-mcp"].map((binaryName) => ({
      binaryName,
      ...runMacTool("codesign", [
        "--verify",
        "--strict",
        "--verbose=2",
        join(appPath, "Contents", "Resources", "bin", binaryName),
      ]),
    }));
    return {
      appBundle: fileEvidence(appPath),
      codesignVerify,
      codesignDisplay,
      gatekeeperAssess,
      staplerValidate,
      companionSignatures,
    };
  });

  const dmgs = dmgPaths.map((dmgPath) => {
    const gatekeeperAssess = runMacTool("spctl", [
      "--assess",
      "--type",
      "open",
      "--context",
      "context:primary-signature",
      "--verbose=4",
      dmgPath,
    ]);
    const staplerValidate = runMacTool("xcrun", ["stapler", "validate", dmgPath]);
    return {
      dmg: fileEvidence(dmgPath),
      gatekeeperAssess,
      staplerValidate,
    };
  });

  const allAppBundlesPass =
    appBundles.length > 0 &&
    appBundles.every(
      (entry) => entry.codesignVerify.valid === true && entry.codesignDisplay.valid === true,
    );
  const allAppGatekeeperPass =
    appBundles.length > 0 && appBundles.every((entry) => entry.gatekeeperAssess.valid === true);
  const allDmgGatekeeperPass =
    dmgs.length > 0 && dmgs.every((entry) => entry.gatekeeperAssess.valid === true);
  const allDmgStaplerPass =
    dmgs.length > 0 && dmgs.every((entry) => entry.staplerValidate.valid === true);
  const allAppStaplerPass =
    appBundles.length > 0 && appBundles.every((entry) => entry.staplerValidate.valid === true);
  const allCompanionSignaturesPass =
    appBundles.length > 0 &&
    appBundles.every(
      (entry) =>
        entry.companionSignatures.length === 2 &&
        entry.companionSignatures.every((signature) => signature.valid === true),
    );

  return {
    checked: process.platform === "darwin",
    reason: process.platform === "darwin" ? null : "not-macos",
    appBundles,
    dmgs,
    appCodeSigned: allAppBundlesPass,
    companionBinariesCodeSigned: allCompanionSignaturesPass,
    appGatekeeperAccepted: allAppGatekeeperPass,
    dmgGatekeeperAccepted: allDmgGatekeeperPass,
    notarized: allDmgStaplerPass || (dmgs.length === 0 && allAppStaplerPass),
  };
}

function powershellModulePath() {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const userProfile = process.env.USERPROFILE;
  const inheritedWindowsPowerShellPaths = String(process.env.PSModulePath ?? "")
    .split(";")
    .filter((entry) => /WindowsPowerShell/i.test(entry));
  const candidates = [
    ...inheritedWindowsPowerShellPaths,
    userProfile ? join(userProfile, "Documents", "WindowsPowerShell", "Modules") : null,
    join(programFiles, "WindowsPowerShell", "Modules"),
    join(systemRoot, "system32", "WindowsPowerShell", "v1.0", "Modules"),
  ].filter(Boolean);
  const seen = new Set();
  const paths = [];
  for (const candidate of candidates) {
    const normalized = String(candidate).trim();
    const key = normalized.toLowerCase();
    if (normalized && !seen.has(key)) {
      seen.add(key);
      paths.push(normalized);
    }
  }
  return paths.join(";");
}

function windowsAuthenticode(relativePath) {
  const pathValue = join(repoRoot, relativePath);
  if (process.platform !== "win32") {
    return {
      path: relativePath.replaceAll("\\", "/"),
      checked: false,
      reason: "not-windows",
      valid: false,
    };
  }
  if (!existsSync(pathValue)) {
    return {
      path: relativePath.replaceAll("\\", "/"),
      checked: true,
      exists: false,
      valid: false,
      status: "Missing",
    };
  }

  const quotedPath = pathValue.replaceAll("'", "''");
  const script = [
    `$sig = Get-AuthenticodeSignature -LiteralPath '${quotedPath}'`,
    "[pscustomobject]@{",
    "  Status = $sig.Status.ToString();",
    "  StatusMessage = $sig.StatusMessage;",
    "  SignerSubject = $sig.SignerCertificate.Subject;",
    "  Thumbprint = $sig.SignerCertificate.Thumbprint;",
    "  NotAfter = $sig.SignerCertificate.NotAfter",
    "} | ConvertTo-Json -Compress",
  ].join("\n");
  const result = spawnSync("powershell", ["-NoProfile", "-Command", script], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PSModulePath: powershellModulePath(),
    },
    shell: false,
  });

  if (result.status !== 0) {
    const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
    const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
    return {
      path: relativePath.replaceAll("\\", "/"),
      checked: !result.error,
      exists: true,
      valid: false,
      reason: result.error ? "powershell-unavailable" : "signature-check-failed",
      error: sanitize(stderr || stdout || result.error?.message || "Authenticode check failed"),
    };
  }

  try {
    const parsed = JSON.parse(result.stdout);
    return {
      path: relativePath.replaceAll("\\", "/"),
      checked: true,
      exists: true,
      valid: parsed.Status === "Valid",
      status: parsed.Status ?? null,
      statusMessage: sanitize(parsed.StatusMessage),
      signerSubjectPresent: typeof parsed.SignerSubject === "string" && parsed.SignerSubject.length > 0,
      thumbprintPresent: typeof parsed.Thumbprint === "string" && parsed.Thumbprint.length > 0,
      notAfter: parsed.NotAfter ?? null,
    };
  } catch (error) {
    return {
      path: relativePath.replaceAll("\\", "/"),
      checked: true,
      exists: true,
      valid: false,
      error: `failed to parse Authenticode status: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

const outputPath = asPath(
  argValue(
    "--write",
    join("release-v3", "proofs", `v3-release-signing-proof-${process.platform}-${process.arch}.json`),
  ),
);
const strict = process.argv.includes("--strict");
const windowsInstallerCandidates = releaseFilesMatching((name) =>
  /\.exe$/i.test(name) && /setup|installer|candor/i.test(name),
);
const macDmgCandidates = releaseFilesMatching((name) => /\.dmg$/i.test(name));
const macAppBundleCandidates = [
  join(releaseDir, "mac", "Candor.app"),
  join(releaseDir, "mac-arm64", "Candor.app"),
].filter((pathValue) => existsSync(pathValue));
const linuxAppImageCandidates = releaseFilesMatching((name) => /\.AppImage$/i.test(name));
const linuxDebCandidates = releaseFilesMatching((name) => /\.deb$/i.test(name));

const windows = {
  target: "nsis",
  appExecutable: fileEvidence(join(releaseDir, "win-unpacked", "Candor.exe")),
  coreExecutable: fileEvidence(join(releaseDir, "win-unpacked", "resources", "bin", "candor-core.exe")),
  companionExecutables: ["candorctl.exe", "candor-mcp.exe"].map((binaryName) =>
    fileEvidence(join(releaseDir, "win-unpacked", "resources", "bin", binaryName)),
  ),
  installerCandidates: windowsInstallerCandidates.map(fileEvidence),
  appSignature: windowsAuthenticode(rel(join(releaseDir, "win-unpacked", "Candor.exe"))),
  coreSignature: windowsAuthenticode(rel(join(releaseDir, "win-unpacked", "resources", "bin", "candor-core.exe"))),
  companionSignatures: ["candorctl.exe", "candor-mcp.exe"].map((binaryName) =>
    windowsAuthenticode(rel(join(releaseDir, "win-unpacked", "resources", "bin", binaryName))),
  ),
  installerSignatures: windowsInstallerCandidates.map((pathValue) => windowsAuthenticode(rel(pathValue))),
  signingCredentialPresence: boolEnv([
    "CSC_LINK",
    "CSC_KEY_PASSWORD",
    "WIN_CSC_LINK",
    "WIN_CSC_KEY_PASSWORD",
    "WINDOWS_CERTIFICATE_FILE",
  ]),
};

const macos = {
  target: "dmg",
  dmgCandidates: macDmgCandidates.map(fileEvidence),
  appBundleCandidates: macAppBundleCandidates.map(fileEvidence),
  signature: macosSignatureEvidence(macDmgCandidates, macAppBundleCandidates),
  signingCredentialPresence: boolEnv([
    "CSC_LINK",
    "CSC_KEY_PASSWORD",
    "APPLE_ID",
    "APPLE_TEAM_ID",
    "APPLE_APP_SPECIFIC_PASSWORD",
  ]),
  notarizationConfigured:
    Boolean(process.env.APPLE_ID) &&
    Boolean(process.env.APPLE_TEAM_ID) &&
    Boolean(process.env.APPLE_APP_SPECIFIC_PASSWORD),
};

const linux = {
  targets: ["AppImage", "deb"],
  appImageCandidates: linuxAppImageCandidates.map(fileEvidence),
  debCandidates: linuxDebCandidates.map(fileEvidence),
  appImageSignatures: linuxAppImageCandidates.map(packageSignatureEvidence),
  debSignatures: linuxDebCandidates.map(packageSignatureEvidence),
  signingCredentialPresence: boolEnv(["GPG_PRIVATE_KEY", "GPG_PASSPHRASE", "LINUX_SIGNING_KEY"]),
};

const consistency = artifactConsistency();
const failures = [];
if (consistency.ok !== true) {
  failures.push(...consistency.failures);
}
if (windows.installerCandidates.length === 0) failures.push("Windows NSIS installer artifact is missing");
if (windows.appSignature.valid !== true) failures.push("Windows app executable is not Authenticode-signed");
if (windows.coreSignature.valid !== true) failures.push("Windows sidecar executable is not Authenticode-signed");
if (
  windows.companionExecutables.length !== 2 ||
  !windows.companionExecutables.every((entry) => entry.exists === true)
) {
  failures.push("Windows automation companion executables are missing");
}
if (
  windows.companionSignatures.length !== 2 ||
  !windows.companionSignatures.every((signature) => signature.valid === true)
) {
  failures.push("Windows automation companion executables are not Authenticode-signed");
}
if (!windows.installerSignatures.some((signature) => signature.valid === true)) {
  failures.push("Windows signed installer proof is missing");
}
if (macos.dmgCandidates.length === 0) failures.push("macOS DMG artifact is missing");
if (macos.notarizationConfigured !== true) failures.push("macOS notarization credentials are not configured");
if (macos.appBundleCandidates.length > 0 && macos.signature.appCodeSigned !== true) {
  failures.push("macOS app bundle codesign proof is missing or invalid");
}
if (
  macos.appBundleCandidates.length > 0 &&
  macos.signature.companionBinariesCodeSigned !== true
) {
  failures.push("macOS automation companion codesign proof is missing or invalid");
}
if (macos.appBundleCandidates.length > 0 && macos.signature.appGatekeeperAccepted !== true) {
  failures.push("macOS app bundle Gatekeeper assessment proof is missing or invalid");
}
if (macos.dmgCandidates.length > 0 && macos.signature.notarized !== true) {
  failures.push("macOS notarization/staple proof is missing or invalid");
}
if (macos.dmgCandidates.length > 0 && macos.signature.dmgGatekeeperAccepted !== true) {
  failures.push("macOS DMG Gatekeeper assessment proof is missing or invalid");
}
if (linux.appImageCandidates.length === 0) failures.push("Linux AppImage artifact is missing");
if (linux.debCandidates.length === 0) failures.push("Linux deb artifact is missing");
if (linux.appImageCandidates.length > 0 && !linux.appImageSignatures.every((entry) => entry.verified === true)) {
  failures.push("Linux AppImage detached signature proof is missing or unverified");
}
if (linux.debCandidates.length > 0 && !linux.debSignatures.every((entry) => entry.verified === true)) {
  failures.push("Linux deb detached signature proof is missing or unverified");
}
if (!Object.values(linux.signingCredentialPresence).some(Boolean)) {
  failures.push("Linux package signing credentials are not configured");
}

const proof = {
  ok: true,
  proofKind: "v3-release-signing-proof",
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  releaseDir: rel(releaseDir),
  proofDir: rel(proofDir),
  strict,
  releaseReady: failures.length === 0,
  localOnly: true,
  cloudAi: false,
  networkAttempted: false,
  rawPathExposed: false,
  keyMaterialExposedToRenderer: false,
  targets: {
    windows: "nsis",
    macos: "dmg",
    linux: ["AppImage", "deb"],
  },
  windows,
  macos,
  linux,
  consistency,
  failures,
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(proof, null, 2)}\n`, "utf8");

if (proof.releaseReady) {
  console.log(`V3 release signing proof passed. Proof written to ${outputPath}.`);
} else {
  console.log(`V3 release signing proof recorded gaps. Proof written to ${outputPath}.`);
  for (const failure of failures) {
    console.log(`- ${failure}`);
  }
  if (strict) process.exit(1);
}
