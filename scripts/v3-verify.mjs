import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");
const proofDir = join(repoRoot, "release-v3", "proofs");
const proofPath = join(proofDir, `v3-local-verification-${process.platform}-${process.arch}.json`);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const powershellCommand = process.platform === "win32" ? "powershell" : "pwsh";

function commandOutput(command, args = []) {
  const usesWindowsCmdShim = process.platform === "win32" && command.endsWith(".cmd");
  const executable = usesWindowsCmdShim ? process.env.ComSpec ?? "cmd.exe" : command;
  const commandArgs = usesWindowsCmdShim ? ["/d", "/c", [command, ...args].join(" ")] : args;
  const result = spawnSync(executable, commandArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    shell: false,
  });
  if (result.status !== 0) return null;
  return result.stdout.trim();
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

const steps = [
  { name: "V3 icon reproducibility", command: npmCommand, args: ["run", "v3:icons:check"] },
  { name: "Candor product identity", command: npmCommand, args: ["run", "v3:identity:verify"] },
  { name: "M0 CI contract smoke", command: npmCommand, args: ["run", "m0:ci-contract-smoke"] },
  {
    name: "M0 local verification",
    command: powershellCommand,
    args:
      process.platform === "win32"
        ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "./scripts/m0-verify.ps1"]
        : ["-NoProfile", "-File", "./scripts/m0-verify.ps1"],
  },
  { name: "V3 source security proof", command: npmCommand, args: ["run", "v3:source-security-proof"] },
  { name: "V3 updater policy proof", command: npmCommand, args: ["run", "v3:updater-policy-proof"] },
  { name: "M1 durable capture and consent", command: npmCommand, args: ["run", "m1:verify"] },
  { name: "M1 SQLCipher vault", command: npmCommand, args: ["run", "m1:verify:sqlcipher"] },
  { name: "M2 walking skeleton", command: npmCommand, args: ["run", "m2:verify"] },
  { name: "M3 product surface", command: npmCommand, args: ["run", "m3:verify"] },
  { name: "M4 local AI fallback", command: npmCommand, args: ["run", "m4:verify"] },
  { name: "M5 importer", command: npmCommand, args: ["run", "m5:verify"] },
  { name: "Vitest regression suite", command: npmCommand, args: ["test"] },
];

const report = {
  ok: false,
  proofKind: "v3-local-verification",
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  repoRoot,
  git: {
    head: commandOutput("git", ["rev-parse", "HEAD"]),
    branch: commandOutput("git", ["branch", "--show-current"]),
    dirty: commandOutput("git", ["status", "--short"])?.length > 0,
  },
  ci: ciProvenance(),
  steps: [],
};

function runStep(step) {
  const startedAt = Date.now();
  console.log(`\n== ${step.name} ==`);
  const usesWindowsCmdShim = process.platform === "win32" && step.command.endsWith(".cmd");
  const command = usesWindowsCmdShim ? process.env.ComSpec ?? "cmd.exe" : step.command;
  const args = usesWindowsCmdShim ? ["/d", "/c", [step.command, ...step.args].join(" ")] : step.args;
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: process.env,
    shell: false,
    stdio: "inherit",
  });
  const completedAt = Date.now();
  const record = {
    name: step.name,
    command: [step.command, ...step.args].join(" "),
    exitCode: result.status,
    signal: result.signal ?? null,
    durationMs: completedAt - startedAt,
    ok: result.status === 0,
  };
  report.steps.push(record);
  if (result.error) {
    record.error = result.error.message;
  }
  return record;
}

function writeReport() {
  report.ok = report.steps.length === steps.length && report.steps.every((step) => step.ok);
  report.completedAt = new Date().toISOString();
  mkdirSync(proofDir, { recursive: true });
  writeFileSync(proofPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nV3 verification proof written to ${proofPath}.`);
}

try {
  for (const step of steps) {
    const record = runStep(step);
    if (!record.ok) {
      writeReport();
      process.exit(record.exitCode ?? 1);
    }
  }
  writeReport();
  console.log("V3 staged verification passed.");
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  writeReport();
  throw error;
}
