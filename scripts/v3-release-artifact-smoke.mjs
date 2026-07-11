import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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

function rel(pathValue) {
  return relative(repoRoot, pathValue).replaceAll("\\", "/");
}

function sanitize(value) {
  const replacements = [
    repoRoot,
    repoRoot.replaceAll("\\", "/"),
    process.env.USERPROFILE,
    process.env.LOCALAPPDATA,
    process.env.TEMP,
    process.env.TMP,
  ].filter(Boolean);
  let text = String(value ?? "");
  for (const item of replacements) {
    text = text.replaceAll(String(item), ".");
    text = text.replaceAll(String(item).replaceAll("\\", "/"), ".");
  }
  return text.replaceAll("\\", "/");
}

function sha256(pathValue) {
  const hash = createHash("sha256");
  hash.update(readFileSync(pathValue));
  return hash.digest("hex");
}

function fileEvidence(pathValue, baseDir = repoRoot) {
  if (!pathValue || !existsSync(pathValue)) {
    return {
      path: pathValue ? relative(baseDir, pathValue).replaceAll("\\", "/") : null,
      exists: false,
    };
  }
  const stat = statSync(pathValue);
  return {
    path: relative(baseDir, pathValue).replaceAll("\\", "/"),
    exists: true,
    bytes: stat.size,
    sha256: sha256(pathValue),
  };
}

function releaseFilesMatching(predicate) {
  if (!existsSync(releaseDir)) return [];
  return readdirSync(releaseDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && predicate(entry.name))
    .map((entry) => join(releaseDir, entry.name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

function findFiles(root, names) {
  const matches = [];
  if (!existsSync(root)) return matches;
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const pathValue = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(pathValue);
      } else if (entry.isFile() && wanted.has(entry.name.toLowerCase())) {
        matches.push(pathValue);
      }
    }
  }
  return matches;
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

function findSevenZip() {
  if (process.env.CANDOR_7ZA_PATH && existsSync(process.env.CANDOR_7ZA_PATH)) {
    return {
      path: process.env.CANDOR_7ZA_PATH,
      source: "CANDOR_7ZA_PATH",
    };
  }
  const fromPath = commandOnPath(["7za", "7z", "7zz"]);
  if (fromPath) return fromPath;
  const searchRoots = [
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "electron-builder", "Cache") : null,
    join(repoRoot, "node_modules"),
  ].filter(Boolean);
  for (const root of searchRoots) {
    const matches = findFiles(root, ["7za.exe", "7z.exe", "7zz.exe", "7za", "7z", "7zz"]);
    if (matches.length > 0) {
      return {
        path: matches[0],
        source: root.includes("electron-builder") ? "electron-builder-cache" : "node_modules",
      };
    }
  }
  return null;
}

function runTool(toolPath, args, options = {}) {
  const result = spawnSync(toolPath, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    shell: false,
  });
  return {
    exitCode: result.status,
    ok: result.status === 0,
    stdout: sanitize(result.stdout ?? ""),
    stderr: sanitize(result.stderr ?? ""),
    error: result.error ? sanitize(String(result.error)) : null,
  };
}

function macosPlistValue(plutilPath, infoPlistPath, key) {
  const result = runTool(plutilPath, ["-extract", key, "raw", "-o", "-", infoPlistPath]);
  return {
    ...result,
    value: result.ok ? result.stdout.trim() : null,
  };
}

function compareExtracted(extractRoot, extractedRelativePath, unpackedRelativePath) {
  return compareExtractedToAny(extractRoot, extractedRelativePath, [unpackedRelativePath]);
}

function compareExtractedToAny(extractRoot, extractedRelativePath, unpackedRelativePaths) {
  const extractedPath = join(extractRoot, extractedRelativePath);
  const unpackedPath = unpackedRelativePaths.map((pathValue) => join(repoRoot, pathValue)).find((pathValue) =>
    existsSync(pathValue),
  ) ?? join(repoRoot, unpackedRelativePaths[0]);
  const extracted = fileEvidence(extractedPath, extractRoot);
  const unpacked = fileEvidence(unpackedPath);
  return {
    extractedPath: extractedRelativePath.replaceAll("\\", "/"),
    unpackedPath: rel(unpackedPath),
    unpackedCandidates: unpackedRelativePaths.map((pathValue) => pathValue.replaceAll("\\", "/")),
    extracted,
    unpacked,
    exists: extracted.exists === true && unpacked.exists === true,
    hashMatchesUnpacked:
      extracted.exists === true &&
      unpacked.exists === true &&
      extracted.sha256 === unpacked.sha256,
  };
}

function requiredEntryFromSearch(extractRoot, fileNames, label, unpackedRelativePaths = []) {
  const matches = findFiles(extractRoot, fileNames);
  const extractedPath = matches[0] ?? null;
  const extracted = fileEvidence(extractedPath, extractRoot);
  const unpackedPath = unpackedRelativePaths.length > 0
    ? unpackedRelativePaths.map((pathValue) => join(repoRoot, pathValue)).find((pathValue) => existsSync(pathValue)) ??
      join(repoRoot, unpackedRelativePaths[0])
    : null;
  const unpacked = unpackedPath ? fileEvidence(unpackedPath) : null;
  return {
    extractedPath: label,
    extracted,
    unpacked,
    unpackedCandidates: unpackedRelativePaths.map((pathValue) => pathValue.replaceAll("\\", "/")),
    exists: extracted.exists === true,
    hashMatchesUnpacked:
      extracted.exists === true && unpacked?.exists === true
        ? extracted.sha256 === unpacked.sha256
        : unpackedRelativePaths.length > 0
          ? false
          : null,
  };
}

function windowsNsisSmoke() {
  const candidates = releaseFilesMatching((name) =>
    /\.exe$/i.test(name) && !/.__uninstaller\.exe$/i.test(name) && /setup|installer|candor/i.test(name),
  );
  const installerPath = candidates[0] ?? null;
  const failures = [];
  if (!installerPath) {
    failures.push("Windows NSIS installer artifact is missing");
    return {
      ok: false,
      checked: true,
      extractionAttempted: false,
      installer: fileEvidence(installerPath),
      failures,
    };
  }

  const sevenZip = findSevenZip();
  if (!sevenZip) {
    failures.push("7-Zip executable is required to inspect the NSIS installer");
    return {
      ok: false,
      checked: true,
      extractionAttempted: false,
      installer: fileEvidence(installerPath),
      sevenZip: {
        found: false,
      },
      failures,
    };
  }

  const list = runTool(sevenZip.path, ["l", installerPath]);
  if (!list.ok) {
    failures.push("7-Zip could not list the NSIS installer payload");
  }

  const extractRoot = mkdtempSync(join(tmpdir(), "candor-v3-installer-smoke-"));
  let extract = {
    ok: false,
    exitCode: null,
    stdout: "",
    stderr: "",
    error: null,
  };
  try {
    extract = runTool(sevenZip.path, ["x", "-y", `-o${extractRoot}`, installerPath]);
    if (!extract.ok) {
      failures.push("7-Zip could not extract the NSIS installer payload");
    }

    const requiredEntries = [
      compareExtracted(extractRoot, "Candor v3 M0.exe", rel(join(releaseDir, "win-unpacked", "Candor v3 M0.exe"))),
      compareExtracted(extractRoot, "resources/app.asar", rel(join(releaseDir, "win-unpacked", "resources", "app.asar"))),
      compareExtracted(
        extractRoot,
        "resources/bin/candor-core.exe",
        rel(join(releaseDir, "win-unpacked", "resources", "bin", "candor-core.exe")),
      ),
    ];
    for (const entry of requiredEntries) {
      if (!entry.exists) failures.push(`installer payload missing ${entry.extractedPath}`);
      if (entry.exists && !entry.hashMatchesUnpacked) {
        failures.push(`installer payload hash mismatch for ${entry.extractedPath}`);
      }
    }

    return {
      ok: failures.length === 0,
      checked: true,
      extractionAttempted: true,
      installer: fileEvidence(installerPath),
      sevenZip: {
        found: true,
        source: sevenZip.source,
      },
      list: {
        ok: list.ok,
        exitCode: list.exitCode,
        containsAppExecutable: list.stdout.includes("Candor v3 M0.exe"),
        containsAppArchive: list.stdout.includes("resources/app.asar"),
        containsCoreSidecar: list.stdout.includes("resources/bin/candor-core.exe"),
      },
      extract: {
        ok: extract.ok,
        exitCode: extract.exitCode,
      },
      requiredEntries,
      failures,
    };
  } finally {
    rmSync(extractRoot, { recursive: true, force: true });
  }
}

function macosDmgSmoke() {
  const candidates = releaseFilesMatching((name) => /\.dmg$/i.test(name));
  const dmgPath = candidates[0] ?? null;
  const failures = [];
  if (!dmgPath) {
    failures.push("macOS DMG artifact is missing");
    return {
      ok: false,
      checked: true,
      extractionAttempted: false,
      installer: fileEvidence(dmgPath),
      failures,
    };
  }

  const hdiutil = commandOnPath(["hdiutil"]);
  if (!hdiutil) {
    failures.push("hdiutil is required to inspect the macOS DMG");
    return {
      ok: false,
      checked: true,
      extractionAttempted: false,
      installer: fileEvidence(dmgPath),
      hdiutil: {
        found: false,
      },
      failures,
    };
  }

  const mountRoot = mkdtempSync(join(tmpdir(), "candor-v3-dmg-smoke-"));
  const mountPoint = join(mountRoot, "mnt");
  mkdirSync(mountPoint, { recursive: true });
  let attach = {
    ok: false,
    exitCode: null,
  };
  let detach = null;
  try {
    attach = runTool(hdiutil.path, ["attach", dmgPath, "-nobrowse", "-readonly", "-mountpoint", mountPoint]);
    if (!attach.ok) failures.push("hdiutil could not mount the macOS DMG");

    const requiredEntries = [
      compareExtractedToAny(
        mountPoint,
        "Candor v3 M0.app/Contents/MacOS/Candor v3 M0",
        [
          rel(join(releaseDir, "mac", "Candor v3 M0.app", "Contents", "MacOS", "Candor v3 M0")),
          rel(join(releaseDir, "mac-arm64", "Candor v3 M0.app", "Contents", "MacOS", "Candor v3 M0")),
        ],
      ),
      compareExtractedToAny(
        mountPoint,
        "Candor v3 M0.app/Contents/Resources/app.asar",
        [
          rel(join(releaseDir, "mac", "Candor v3 M0.app", "Contents", "Resources", "app.asar")),
          rel(join(releaseDir, "mac-arm64", "Candor v3 M0.app", "Contents", "Resources", "app.asar")),
        ],
      ),
      compareExtractedToAny(
        mountPoint,
        "Candor v3 M0.app/Contents/Resources/bin/candor-core",
        [
          rel(join(releaseDir, "mac", "Candor v3 M0.app", "Contents", "Resources", "bin", "candor-core")),
          rel(join(releaseDir, "mac-arm64", "Candor v3 M0.app", "Contents", "Resources", "bin", "candor-core")),
        ],
      ),
    ];
    for (const entry of requiredEntries) {
      if (!entry.extracted.exists) failures.push(`DMG payload missing ${entry.extractedPath}`);
      if (entry.extracted.exists && !entry.hashMatchesUnpacked) {
        failures.push(`DMG payload hash mismatch for ${entry.extractedPath}`);
      }
    }

    const appPath = join(mountPoint, "Candor v3 M0.app");
    const infoPlistPath = join(appPath, "Contents", "Info.plist");
    const sidecarPath = join(appPath, "Contents", "Resources", "bin", "candor-core");
    const plutil = commandOnPath(["plutil"]);
    const plist = {
      minimumSystemVersion: null,
      microphoneUsage: null,
      screenCaptureUsage: null,
    };
    if (!existsSync(infoPlistPath)) {
      failures.push("DMG app bundle is missing Contents/Info.plist");
    } else if (!plutil) {
      failures.push("plutil is required to inspect the macOS app Info.plist");
    } else {
      plist.minimumSystemVersion = macosPlistValue(
        plutil.path,
        infoPlistPath,
        "LSMinimumSystemVersion",
      );
      plist.microphoneUsage = macosPlistValue(
        plutil.path,
        infoPlistPath,
        "NSMicrophoneUsageDescription",
      );
      plist.screenCaptureUsage = macosPlistValue(
        plutil.path,
        infoPlistPath,
        "NSScreenCaptureUsageDescription",
      );
      if (plist.minimumSystemVersion.value !== "13.0") {
        failures.push("DMG app bundle must declare LSMinimumSystemVersion 13.0");
      }
      if ((plist.microphoneUsage.value ?? "").length < 32) {
        failures.push("DMG app bundle microphone usage description is missing or too short");
      }
      if (
        (plist.screenCaptureUsage.value ?? "").length < 64 ||
        !plist.screenCaptureUsage.value?.includes("Audio stays on this Mac")
      ) {
        failures.push("DMG app bundle Screen & System Audio Recording purpose string is incomplete");
      }
    }

    const codesign = commandOnPath(["codesign"]);
    const signingGaps = [];
    const signing = {
      toolFound: Boolean(codesign),
      appVerified: false,
      appAudioInputEntitlement: false,
      sidecarVerified: false,
      sidecarAudioInputEntitlement: false,
    };
    if (!codesign) {
      signingGaps.push("codesign was unavailable, so macOS signatures and entitlements were not inspected");
    } else {
      const appVerify = runTool(codesign.path, ["--verify", "--deep", "--strict", appPath]);
      const sidecarVerify = runTool(codesign.path, ["--verify", "--strict", sidecarPath]);
      const appEntitlements = runTool(codesign.path, ["--display", "--entitlements", ":-", appPath]);
      const sidecarEntitlements = runTool(codesign.path, [
        "--display",
        "--entitlements",
        ":-",
        sidecarPath,
      ]);
      const entitlementKey = "com.apple.security.device.audio-input";
      signing.appVerified = appVerify.ok;
      signing.sidecarVerified = sidecarVerify.ok;
      signing.appAudioInputEntitlement =
        appEntitlements.ok && `${appEntitlements.stdout}\n${appEntitlements.stderr}`.includes(entitlementKey);
      signing.sidecarAudioInputEntitlement =
        sidecarEntitlements.ok &&
        `${sidecarEntitlements.stdout}\n${sidecarEntitlements.stderr}`.includes(entitlementKey);

      const signaturePresent = signing.appVerified || signing.sidecarVerified;
      if (!signaturePresent) {
        signingGaps.push("M0 app and sidecar are unsigned; production signing remains a release gate");
      } else {
        if (!signing.appVerified) failures.push("signed macOS app bundle failed strict codesign verification");
        if (!signing.sidecarVerified) failures.push("signed candor-core sidecar failed strict codesign verification");
        if (!signing.appAudioInputEntitlement) {
          failures.push("signed macOS app bundle is missing the audio-input entitlement");
        }
        if (!signing.sidecarAudioInputEntitlement) {
          failures.push("signed candor-core sidecar is missing the audio-input entitlement");
        }
      }
    }

    return {
      ok: failures.length === 0,
      checked: true,
      extractionAttempted: true,
      installer: fileEvidence(dmgPath),
      hdiutil: {
        found: true,
        source: hdiutil.source,
      },
      attach: {
        ok: attach.ok,
        exitCode: attach.exitCode,
      },
      detach: null,
      requiredEntries,
      plist,
      signing,
      signingGaps,
      failures,
    };
  } finally {
    detach = runTool(hdiutil.path, ["detach", mountPoint, "-quiet"]);
    rmSync(mountRoot, { recursive: true, force: true });
  }
}

function linuxPackageSmoke() {
  const appImagePath = releaseFilesMatching((name) => /\.AppImage$/i.test(name))[0] ?? null;
  const debPath = releaseFilesMatching((name) => /\.deb$/i.test(name))[0] ?? null;
  const failures = [];
  if (!appImagePath) failures.push("Linux AppImage artifact is missing");
  if (!debPath) failures.push("Linux deb artifact is missing");

  const requiredEntries = [];
  let appImageExtract = null;
  let debExtract = null;
  let extractionAttempted = false;

  if (appImagePath) {
    const appImageRoot = mkdtempSync(join(tmpdir(), "candor-v3-appimage-smoke-"));
    try {
      try {
        chmodSync(appImagePath, 0o755);
      } catch {
        failures.push("Linux AppImage could not be marked executable");
      }
      appImageExtract = runTool(appImagePath, ["--appimage-extract"], { cwd: appImageRoot });
      extractionAttempted = true;
      if (!appImageExtract.ok) failures.push("Linux AppImage extraction failed");
      const squashfsRoot = join(appImageRoot, "squashfs-root");
      requiredEntries.push(
        requiredEntryFromSearch(squashfsRoot, ["app.asar"], "appimage:app.asar", [
          rel(join(releaseDir, "linux-unpacked", "resources", "app.asar")),
        ]),
        requiredEntryFromSearch(squashfsRoot, ["candor-core"], "appimage:candor-core", [
          rel(join(releaseDir, "linux-unpacked", "resources", "bin", "candor-core")),
        ]),
      );
      for (const entry of requiredEntries.filter((entry) => entry.extractedPath.startsWith("appimage:"))) {
        if (!entry.exists) failures.push(`AppImage payload missing ${entry.extractedPath}`);
        if (entry.exists && entry.hashMatchesUnpacked !== true) {
          failures.push(`AppImage payload hash mismatch for ${entry.extractedPath}`);
        }
      }
    } finally {
      rmSync(appImageRoot, { recursive: true, force: true });
    }
  }

  if (debPath) {
    const dpkgDeb = commandOnPath(["dpkg-deb"]);
    if (!dpkgDeb) {
      failures.push("dpkg-deb is required to inspect the Linux deb package");
    } else {
      const debRoot = mkdtempSync(join(tmpdir(), "candor-v3-deb-smoke-"));
      try {
        debExtract = runTool(dpkgDeb.path, ["-x", debPath, debRoot]);
        extractionAttempted = true;
        if (!debExtract.ok) failures.push("Linux deb extraction failed");
        requiredEntries.push(
          requiredEntryFromSearch(debRoot, ["app.asar"], "deb:app.asar", [
            rel(join(releaseDir, "linux-unpacked", "resources", "app.asar")),
          ]),
          requiredEntryFromSearch(debRoot, ["candor-core"], "deb:candor-core", [
            rel(join(releaseDir, "linux-unpacked", "resources", "bin", "candor-core")),
          ]),
        );
        for (const entry of requiredEntries.filter((entry) => entry.extractedPath.startsWith("deb:"))) {
          if (!entry.exists) failures.push(`deb payload missing ${entry.extractedPath}`);
          if (entry.exists && entry.hashMatchesUnpacked !== true) {
            failures.push(`deb payload hash mismatch for ${entry.extractedPath}`);
          }
        }
      } finally {
        rmSync(debRoot, { recursive: true, force: true });
      }
    }
  }

  return {
    ok: failures.length === 0,
    checked: true,
    extractionAttempted,
    appImage: fileEvidence(appImagePath),
    deb: fileEvidence(debPath),
    appImageExtract: appImageExtract
      ? {
          ok: appImageExtract.ok,
          exitCode: appImageExtract.exitCode,
        }
      : null,
    debExtract: debExtract
      ? {
          ok: debExtract.ok,
          exitCode: debExtract.exitCode,
        }
      : null,
    requiredEntries,
    failures,
  };
}

function unsupportedCurrentPlatformSmoke() {
  const failures = [`release artifact smoke is not implemented for ${process.platform}`];
  return {
    ok: false,
    checked: true,
    extractionAttempted: false,
    failures,
  };
}

const outputPath = asPath(
  argValue(
    "--write",
    join("release-v3", "proofs", `v3-release-artifact-smoke-${process.platform}-${process.arch}.json`),
  ),
);
const strict = process.argv.includes("--strict");

const currentPlatform =
  process.platform === "win32"
    ? windowsNsisSmoke()
    : process.platform === "darwin"
      ? macosDmgSmoke()
      : process.platform === "linux"
        ? linuxPackageSmoke()
    : unsupportedCurrentPlatformSmoke();

const proof = {
  ok: currentPlatform.ok === true,
  proofKind: "v3-release-artifact-smoke",
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  releaseDir: rel(releaseDir),
  strict,
  localOnly: true,
  cloudAi: false,
  networkAttempted: false,
  rawPathExposed: false,
  keyMaterialExposedToRenderer: false,
  currentPlatform,
  failures: currentPlatform.failures ?? [],
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(proof, null, 2)}\n`, "utf8");

if (proof.ok) {
  console.log(`V3 release artifact smoke passed. Proof written to ${outputPath}.`);
} else {
  console.log(`V3 release artifact smoke recorded gaps. Proof written to ${outputPath}.`);
  for (const failure of proof.failures) {
    console.log(`- ${failure}`);
  }
  if (strict) process.exit(1);
}
