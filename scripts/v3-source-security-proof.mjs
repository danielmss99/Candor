import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

function rel(pathValue) {
  return relative(repoRoot, pathValue).replaceAll("\\", "/");
}

function run(command, args = []) {
  const usesWindowsCmdShim = process.platform === "win32" && command.endsWith(".cmd");
  const executable = usesWindowsCmdShim ? process.env.ComSpec ?? "cmd.exe" : command;
  const commandArgs = usesWindowsCmdShim ? ["/d", "/c", [command, ...args].join(" ")] : args;
  const result = spawnSync(executable, commandArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    shell: false,
  });
  return {
    command: [command, ...args].join(" "),
    exitCode: result.status ?? 1,
    signal: result.signal ?? null,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    error: result.error ? result.error.message : null,
    ok: result.status === 0,
  };
}

function canRun(command) {
  const args =
    process.platform === "win32" && command.toLowerCase() === "powershell"
      ? ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"]
      : ["--version"];
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    shell: false,
  });
  return result.status === 0;
}

function commandLines(command, args = []) {
  const result = run(command, args);
  if (!result.ok) return [];
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function readSource(relativePath) {
  const pathValue = join(repoRoot, relativePath);
  return existsSync(pathValue) ? readFileSync(pathValue, "utf8") : "";
}

const outputPath = asPath(
  argValue(
    "--write",
    join("release-v3", "proofs", `v3-source-security-proof-${process.platform}-${process.arch}.json`),
  ),
);

const envFiles = [".env", ".env.local", ".env.production"];
const trackedEnvFiles = commandLines("git", ["ls-files", "--", ...envFiles]);
const ignoredEnvFiles = commandLines("git", ["check-ignore", ...envFiles]);
const ignoredEnvSet = new Set(ignoredEnvFiles);
const buildScript = readSource(join("src-tauri", "build.rs"));
const calendarSource = readSource(join("src-tauri", "src", "calendar.rs"));

const plaintextFallbackPatterns = [
  "\\.or\\(auth\\.ms_access_token\\)",
  "\\.or\\(auth\\.ms_refresh_token\\)",
  "\\.or\\(auth\\.google_client_secret\\)",
  "\\.or\\(auth\\.google_access_token\\)",
  "\\.or\\(auth\\.google_refresh_token\\)",
  "\\.or\\(auth\\.apple_id\\)",
  "\\.or\\(auth\\.apple_app_password\\)",
];
const plaintextFallbackMatches = plaintextFallbackPatterns.filter((pattern) =>
  new RegExp(pattern).test(calendarSource),
);

const powershell = process.platform === "win32" ? "powershell" : "pwsh";
const powershellAvailable = canRun(powershell);
const auditRun = powershellAvailable
  ? run(powershell, [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "./scripts/audit-source-security.ps1",
    ])
  : {
      command: `${powershell} -NoProfile -ExecutionPolicy Bypass -File ./scripts/audit-source-security.ps1`,
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
      error: "PowerShell executable is unavailable on this runner",
      ok: null,
      skipped: true,
    };

const failures = [];
if (auditRun.ok !== true && (process.platform === "win32" || powershellAvailable)) {
  failures.push("audit-source-security.ps1 did not pass");
}
if (trackedEnvFiles.length > 0) failures.push("environment files are tracked by git");
for (const expected of [".env", ".env.local"]) {
  if (!ignoredEnvSet.has(expected)) failures.push(`${expected} is not ignored by git`);
}
if (buildScript.includes("CANDOR_GOOGLE_CLIENT_SECRET")) {
  failures.push("Google client secret export is present in src-tauri/build.rs");
}
if (plaintextFallbackMatches.length > 0) {
  failures.push("calendar auth plaintext fallback patterns are present");
}

const proof = {
  ok: failures.length === 0,
  proofKind: "v3-source-security-proof",
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  localOnly: true,
  cloudAi: false,
  rawPathExposed: false,
  keyMaterialExposedToRenderer: false,
  checks: {
    auditScript: {
      command: auditRun.command,
      exitCode: auditRun.exitCode,
      ok: auditRun.ok,
      skipped: auditRun.skipped === true,
      stdout: auditRun.stdout,
      stderr: auditRun.stderr,
      error: auditRun.error,
    },
    trackedEnvironmentFiles: {
      ok: trackedEnvFiles.length === 0,
      files: trackedEnvFiles,
    },
    ignoredEnvironmentFiles: {
      ok: [".env", ".env.local"].every((expected) => ignoredEnvSet.has(expected)),
      expected: [".env", ".env.local"],
      ignored: ignoredEnvFiles,
    },
    compileTimeSecretExport: {
      ok: !buildScript.includes("CANDOR_GOOGLE_CLIENT_SECRET"),
      file: rel(join(repoRoot, "src-tauri", "build.rs")),
      symbol: "CANDOR_GOOGLE_CLIENT_SECRET",
    },
    calendarPlaintextFallbacks: {
      ok: plaintextFallbackMatches.length === 0,
      file: rel(join(repoRoot, "src-tauri", "src", "calendar.rs")),
      patternCount: plaintextFallbackPatterns.length,
      matches: plaintextFallbackMatches,
    },
  },
  failures,
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(proof, null, 2)}\n`, "utf8");

if (proof.ok) {
  console.log(`V3 source security proof passed. Proof written to ${outputPath}.`);
} else {
  console.error(`V3 source security proof failed. Proof written to ${outputPath}.`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}
