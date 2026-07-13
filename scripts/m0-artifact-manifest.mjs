import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
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

function commandOutput(command, args = []) {
  const commandArgs =
    process.platform === "win32" && command.endsWith(".cmd")
      ? ["/d", "/c", [command, ...args].join(" ")]
      : args;
  const executable =
    process.platform === "win32" && command.endsWith(".cmd")
      ? process.env.ComSpec ?? "cmd.exe"
      : command;
  const result = spawnSync(executable, commandArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    shell: false,
  });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

function sha256(path) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

function fileEntry(path) {
  if (!existsSync(path)) return { path, exists: false };
  const stat = statSync(path);
  return {
    path,
    exists: true,
    bytes: stat.size,
    sha256: sha256(path),
  };
}

function firstExisting(paths) {
  return paths.find((path) => existsSync(path)) ?? paths[0];
}

function ciProvenance() {
  return {
    githubActions: process.env.GITHUB_ACTIONS === "true",
    workflow: process.env.GITHUB_WORKFLOW ?? null,
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    job: process.env.GITHUB_JOB ?? null,
    sha: process.env.GITHUB_SHA ?? null,
    ref: process.env.GITHUB_REF ?? null,
    runnerOs: process.env.RUNNER_OS ?? null,
  };
}

function packagedFiles() {
  if (process.platform === "win32") {
    return {
      appExecutable: join(releaseDir, "win-unpacked", "Candor.exe"),
      coreExecutable: join(releaseDir, "win-unpacked", "resources", "bin", "candor-core.exe"),
      appArchive: join(releaseDir, "win-unpacked", "resources", "app.asar"),
    };
  }
  if (process.platform === "darwin") {
    const appRoot = firstExisting([
      join(releaseDir, "mac", "Candor.app"),
      join(releaseDir, "mac-arm64", "Candor.app"),
    ]);
    return {
      appExecutable: join(appRoot, "Contents", "MacOS", "Candor"),
      coreExecutable: join(appRoot, "Contents", "Resources", "bin", "candor-core"),
      appArchive: join(appRoot, "Contents", "Resources", "app.asar"),
    };
  }
  return {
    appExecutable: firstExisting([
      join(releaseDir, "linux-unpacked", "candor"),
      join(releaseDir, "linux-unpacked", "Candor"),
    ]),
    coreExecutable: join(releaseDir, "linux-unpacked", "resources", "bin", "candor-core"),
    appArchive: join(releaseDir, "linux-unpacked", "resources", "app.asar"),
  };
}

function releaseArtifactFiles() {
  const outputDir = releaseDir;
  if (!existsSync(outputDir)) return [];
  return readdirSync(outputDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(outputDir, entry.name))
    .filter((path) => {
      const name = path.split(/[\\/]/).at(-1) ?? "";
      if (process.platform === "win32") {
        return /\.exe$/i.test(name) && !/.__uninstaller\.exe$/i.test(name);
      }
      if (process.platform === "darwin") {
        return /\.dmg$/i.test(name);
      }
      return /\.AppImage$/i.test(name) || /\.deb$/i.test(name);
    });
}

function expectedReleaseArtifactKinds() {
  if (process.platform === "win32") return ["windows-installer"];
  if (process.platform === "darwin") return ["macos-dmg"];
  return ["linux-appimage", "linux-deb"];
}

function releaseArtifactKind(path) {
  const name = path.split(/[\\/]/).at(-1) ?? "";
  if (/\.AppImage$/i.test(name)) return "linux-appimage";
  if (/\.deb$/i.test(name)) return "linux-deb";
  if (/\.dmg$/i.test(name)) return "macos-dmg";
  if (/\.exe$/i.test(name)) return "windows-installer";
  return "unknown";
}

const proofDir = asPath(argValue("--proof-dir", "release-v3/proofs"));
const outputPath = asPath(
  argValue(
    "--write",
    join(proofDir, `m0-artifact-manifest-${process.platform}-${process.arch}.json`),
  ),
);

const proofScripts = [
  "scripts/generate-v3-icons.mjs",
  "scripts/v3-icon-proof.mjs",
  "scripts/cargo-with-local-perl.mjs",
  "scripts/v3-verify.mjs",
  "scripts/m0-audit-electron.mjs",
  "scripts/m0-build-electron.mjs",
  "scripts/m0-ci-contract-smoke.mjs",
  "scripts/m0-core-smoke.mjs",
  "scripts/m0-local-proof-refresh.mjs",
  "scripts/m0-packaged-smoke.mjs",
  "scripts/m0-proof-audit.mjs",
  "scripts/m0-network-deny-windows.ps1",
  "scripts/m0-network-deny-windows-admin.ps1",
  "scripts/m0-network-deny-linux.mjs",
  "scripts/m0-network-deny-macos.mjs",
  "scripts/m0-verify.ps1",
  "scripts/v3-release-readiness-audit.mjs",
  "scripts/v3-release-artifact-smoke.mjs",
  "scripts/v3-release-signing-proof.mjs",
  "scripts/v3-source-security-proof.mjs",
  "scripts/v3-updater-policy-proof.mjs",
  "scripts/m1-bootstrap-native-perl-windows.ps1",
  "scripts/m1-consent-smoke.mjs",
  "scripts/m1-macos-privacy-contract-smoke.mjs",
  "scripts/m1-capture-crash-recovery-smoke.mjs",
  "scripts/m1-capture-proof-audit.mjs",
  "scripts/m1-capture-service-smoke.mjs",
  "scripts/m1-durable-crash-recovery-smoke.mjs",
  "scripts/m1-durable-recording-smoke.mjs",
  "scripts/m1-vault-smoke.mjs",
  "scripts/m1-real-capture-proof.mjs",
  "scripts/m1-real-capture-readiness-audit.mjs",
  "scripts/m2-audio-replay-smoke.mjs",
  "scripts/m2-local-model-scheduler-smoke.mjs",
  "scripts/m2-local-library-export-smoke.mjs",
  "scripts/m2-local-whisper-preflight.mjs",
  "scripts/m2-local-wav-fixture.mjs",
  "scripts/m2-model-manager-smoke.mjs",
  "scripts/m2-real-whisper-proof.mjs",
  "scripts/m2-real-whisper-inputs.mjs",
  "scripts/m2-transcription-boundary-smoke.mjs",
  "scripts/m2-transcription-proof-audit.mjs",
  "scripts/m3-product-surface-smoke.mjs",
  "scripts/m4-heuristic-recap-smoke.mjs",
  "scripts/m4-instruct-asset-manager-smoke.mjs",
  "scripts/m4-local-instruct-fixture-smoke.mjs",
  "scripts/m4-local-instruct-preflight.mjs",
  "scripts/m4-real-local-instruct-proof.mjs",
  "scripts/m5-v2-import-smoke.mjs",
];

const sourceFiles = [
  "package.json",
  "package-lock.json",
  "electron-builder.v3.yml",
  "THIRD_PARTY_NOTICES.md",
  "vite.v3.config.ts",
  ".github/workflows/v3-m0.yml",
  "electron/main.ts",
  "electron/license-service.ts",
  "electron/preload.cts",
  "electron/tsconfig.json",
  "v3/renderer/index.html",
  "v3/renderer/src/main.tsx",
  "v3/renderer/src/CandorApp.tsx",
  "v3/renderer/src/candor-api.d.ts",
  "v3/renderer/src/meeting-motion.tsx",
  "v3/renderer/src/tokens.css",
  "v3/renderer/src/styles.css",
  "design/figma/style-guide.md",
  "design/figma/token.json",
  "design/brand/CANDOR_PROJECT_BRAND_HANDOFF.md",
  "design/brand/APP_ICON.md",
  "assets/icons/candor-app-icon-master.svg",
  "assets/icons/candor-app-icon-16.png",
  "assets/icons/candor-app-icon-24.png",
  "assets/icons/candor-app-icon-32.png",
  "assets/icons/candor-app-icon-48.png",
  "assets/icons/candor-app-icon-64.png",
  "assets/icons/candor-app-icon-128.png",
  "assets/icons/candor-app-icon-256.png",
  "assets/icons/candor-app-icon-512.png",
  "assets/icons/candor-app-icon-1024.png",
  "assets/platform/candor.ico",
  "assets/platform/candor.icns",
  "build/icon.ico",
  "build/icon.icns",
  "build/icon.png",
  "build/entitlements.mac.plist",
  "build/entitlements.mac.inherit.plist",
  "build/icons/16x16.png",
  "build/icons/20x20.png",
  "build/icons/24x24.png",
  "build/icons/32x32.png",
  "build/icons/40x40.png",
  "build/icons/48x48.png",
  "build/icons/64x64.png",
  "build/icons/128x128.png",
  "build/icons/256x256.png",
  "build/icons/512x512.png",
  "build/icons/1024x1024.png",
  "v3/renderer/public/candor-mark.png",
  "crates/candor-core/Cargo.toml",
  "crates/candor-core/Cargo.lock",
  "crates/candor-core/build.rs",
  "crates/candor-core/src/capture_service.rs",
  "crates/candor-core/src/capture_service_macos.rs",
  "crates/candor-core/src/consent_store.rs",
  "crates/candor-core/src/local_ai_service.rs",
  "crates/candor-core/src/local_instruct_assets.rs",
  "crates/candor-core/src/local_instruct_model.rs",
  "crates/candor-core/src/local_model_scheduler.rs",
  "crates/candor-core/src/main.rs",
  "crates/candor-core/src/model_manager.rs",
  "crates/candor-core/src/os_key_store.rs",
  "crates/candor-core/src/recording_store.rs",
  "crates/candor-core/src/report_export.rs",
  "crates/candor-core/src/transcription_service.rs",
  "crates/candor-core/src/update_policy.rs",
  "crates/candor-core/src/v2_importer.rs",
  "crates/candor-core/src/vault_store.rs",
  "crates/candor-core/assets/fonts/NotoSans-Regular.ttf",
  "crates/candor-core/assets/fonts/NotoSans-Bold.ttf",
  "crates/candor-core/assets/fonts/OFL.txt",
  "docs/proofs/M0_ELECTRON_HARDENING_CHECKLIST.md",
  "docs/proofs/M0_IPC_THREAT_MODEL.md",
  "docs/proofs/M0_NETWORK_PROOF.md",
  "docs/proofs/M0_PACKAGING_PROOF.md",
  "docs/proofs/M0_UPDATER_POLICY_PROOF.md",
  "docs/proofs/V3_STAGED_VERIFICATION_PROOF.md",
  "docs/proofs/V3_RELEASE_READINESS_AUDIT.md",
  "docs/proofs/V3_RELEASE_SIGNING_PROOF.md",
  "docs/proofs/V3_SOURCE_SECURITY_PROOF.md",
  "docs/proofs/V3_APPLICATION_ICON_PROOF.md",
  "docs/proofs/M1_CONSENT_PROOF.md",
  "docs/proofs/M1_CAPTURE_SERVICE_PROOF.md",
  "docs/proofs/M1_DURABLE_RECORDING_PROOF.md",
  "docs/proofs/M1_REAL_CAPTURE_READINESS_PROOF.md",
  "docs/proofs/M1_OS_KEY_STORAGE_PROOF.md",
  "docs/proofs/M1_SQLCIPHER_VAULT_PROOF.md",
  "docs/proofs/M2_AUDIO_REPLAY_PROOF.md",
  "docs/proofs/M2_LOCAL_WHISPER_PREFLIGHT_PROOF.md",
  "docs/proofs/M2_LOCAL_MODEL_SCHEDULER_PROOF.md",
  "docs/proofs/M2_LOCAL_LIBRARY_EXPORT_PROOF.md",
  "docs/proofs/M2_MODEL_MANAGER_PROOF.md",
  "docs/proofs/M2_SYNCED_TRANSCRIPT_PROOF.md",
  "docs/proofs/M2_TRANSCRIPTION_BOUNDARY_PROOF.md",
  "docs/proofs/M3_PRODUCT_SURFACE_PROOF.md",
  "docs/proofs/M4_HEURISTIC_RECAP_PROOF.md",
  "docs/proofs/M4_INSTRUCT_ASSET_MANAGER_PROOF.md",
  "docs/proofs/M4_LOCAL_INSTRUCT_FIXTURE_PROOF.md",
  "docs/proofs/M4_LOCAL_INSTRUCT_PREFLIGHT_PROOF.md",
  "docs/proofs/M4_REAL_LOCAL_INSTRUCT_PROOF.md",
  "docs/proofs/M5_V2_IMPORT_PROOF.md",
  ...proofScripts,
];

const packaged = packagedFiles();
const releaseArtifacts = releaseArtifactFiles().map((path) => ({
  kind: releaseArtifactKind(path),
  ...fileEntry(path),
}));
const manifest = {
  ok: true,
  proofKind: "m0-artifact-manifest",
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  repoRoot,
  releaseDir,
  git: {
    head: commandOutput("git", ["rev-parse", "HEAD"]),
    branch: commandOutput("git", ["branch", "--show-current"]),
    dirty: commandOutput("git", ["status", "--short"])?.length > 0,
  },
  ci: ciProvenance(),
  tools: {
    node: process.version,
    npm: commandOutput(process.platform === "win32" ? "npm.cmd" : "npm", ["--version"]),
    rustc: commandOutput("rustc", ["--version"]),
    cargo: commandOutput("cargo", ["--version"]),
  },
  package: {
    name: JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).name,
    version: JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version,
  },
  proofDir,
  packaged: Object.fromEntries(
    Object.entries(packaged).map(([key, path]) => [key, fileEntry(path)]),
  ),
  releaseArtifacts,
  sources: sourceFiles.map((relativePath) => fileEntry(join(repoRoot, relativePath))),
};

const missingPackaged = Object.entries(manifest.packaged)
  .filter(([, entry]) => !entry.exists)
  .map(([name]) => name);
const presentReleaseKinds = new Set(releaseArtifacts.filter((entry) => entry.exists).map((entry) => entry.kind));
const missingReleaseArtifacts = expectedReleaseArtifactKinds().filter((kind) => !presentReleaseKinds.has(kind));
const missingSources = manifest.sources
  .filter((entry) => !entry.exists)
  .map((entry) => entry.path);

manifest.ok = missingPackaged.length === 0 && missingReleaseArtifacts.length === 0 && missingSources.length === 0;
manifest.missing = {
  packaged: missingPackaged,
  releaseArtifacts: missingReleaseArtifacts,
  sources: missingSources,
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(manifest, null, 2), "utf8");

if (!manifest.ok) {
  console.error(`M0 artifact manifest has missing files. Wrote ${outputPath}.`);
  process.exit(1);
}

console.log(`M0 artifact manifest written to ${outputPath}.`);
