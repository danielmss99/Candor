import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");
const proofDir = join(repoRoot, "release-v3", "proofs");
const skipV3Verify = process.argv.includes("--skip-v3-verify");
const skipPack = process.argv.includes("--skip-pack");
const skipNetworkValidate = process.argv.includes("--skip-network-validate");

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function rel(path) {
  return relative(repoRoot, path).replaceAll("\\", "/");
}

function quoteCommandArg(value) {
  if (/^[\w:./\\=-]+$/.test(value)) return value;
  return `"${value.replaceAll('"', '\\"')}"`;
}

function npmInvocation(args) {
  if (process.platform === "win32") {
    return {
      command: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", ["npm", ...args].map(quoteCommandArg).join(" ")],
    };
  }
  return {
    command: "npm",
    args,
  };
}

function runInherited(label, command, args, options = {}) {
  console.log(`\n== ${label} ==`);
  const startedAt = new Date().toISOString();
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: false,
  });
  const entry = {
    label,
    command: [command, ...args],
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode: result.status,
    signal: result.signal,
    ok: result.status === 0,
    error: result.error ? String(result.error) : undefined,
  };
  if (!entry.ok && options.allowFailure !== true) {
    throw new Error(`${label} failed with exit code ${result.status ?? "unknown"}`);
  }
  return entry;
}

function runCaptured(label, command, args) {
  console.log(`\n== ${label} ==`);
  const startedAt = new Date().toISOString();
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const entry = {
    label,
    command: [command, ...args],
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode: result.status,
    signal: result.signal,
    ok: result.status === 0,
    error: result.error ? String(result.error) : undefined,
    stdout: result.stdout,
    stderr: result.stderr,
  };
  if (!entry.ok) {
    throw new Error(`${label} failed with exit code ${result.status ?? "unknown"}`);
  }
  return entry;
}

function parseJsonFromOutput(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return JSON.parse(text.slice(start, end + 1));
}

function networkValidateCommand() {
  if (process.platform === "win32") {
    return {
      command: "powershell",
      args: [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "./scripts/m0-network-deny-windows.ps1",
        "-ValidateOnly",
      ],
    };
  }
  if (process.platform === "darwin") {
    return {
      command: process.execPath,
      args: ["scripts/m0-network-deny-macos.mjs", "--validate-only"],
    };
  }
  if (process.platform === "linux") {
    return {
      command: process.execPath,
      args: ["scripts/m0-network-deny-linux.mjs", "--validate-only"],
    };
  }
  return null;
}

mkdirSync(proofDir, { recursive: true });

const steps = [];
if (!skipV3Verify) {
  const invocation = npmInvocation(["run", "v3:verify"]);
  steps.push(runInherited("Run staged v3 verification", invocation.command, invocation.args));
}
if (!skipPack) {
  const invocation = npmInvocation(["run", "electron:v3:dist"]);
  steps.push(runInherited("Package M0 release artifacts", invocation.command, invocation.args));
}
{
  const invocation = npmInvocation(["run", "v3:release-artifact-smoke"]);
  steps.push(runInherited("Smoke release artifact contents", invocation.command, invocation.args));
}
{
  const invocation = npmInvocation(["run", "m0:packaged-smoke"]);
  steps.push(runInherited("Smoke packaged M0 app", invocation.command, invocation.args));
}
{
  const invocation = npmInvocation(["run", "m0:artifact-manifest"]);
  steps.push(runInherited("Write M0 artifact manifest", invocation.command, invocation.args));
}

let networkValidation = null;
if (!skipNetworkValidate) {
  const command = networkValidateCommand();
  if (command) {
    const validationStep = runCaptured("Validate platform network proof runner inputs", command.command, command.args);
    steps.push({
      ...validationStep,
      stdout: undefined,
      stderr: undefined,
    });
    networkValidation = parseJsonFromOutput(validationStep.stdout);
  } else {
    networkValidation = {
      ok: false,
      mode: "unsupported-platform",
      platform: process.platform,
    };
  }
}

const auditPath = join(proofDir, "m0-proof-audit-summary.json");
steps.push(
  runInherited("Write M0 proof audit summary", process.execPath, [
    "scripts/m0-proof-audit.mjs",
    "--write",
    rel(auditPath),
  ], { allowFailure: true }),
);

const proofAudit = existsSync(auditPath) ? JSON.parse(readFileSync(auditPath, "utf8")) : null;
const outputPath = resolve(
  repoRoot,
  argValue(
    "--write",
    join("release-v3", "proofs", `m0-local-proof-refresh-${process.platform}-${process.arch}.json`),
  ),
);

const summary = {
  ok: steps.every((step) => step.ok),
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  proofDir: rel(proofDir),
  steps,
  networkValidation,
  networkBoundaryProofAttempted: false,
  networkBoundaryProofSatisfied: false,
  validateOnlyIsNotNetworkProof: true,
  proofAuditSummary: proofAudit
    ? {
        path: rel(auditPath),
        exitReady: proofAudit.exitReady === true,
        missing: proofAudit.missing ?? [],
        failed: proofAudit.failed ?? [],
      }
    : null,
};

writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(`\nM0 local proof refresh written to ${outputPath}.`);
if (summary.proofAuditSummary?.exitReady !== true) {
  console.log("M0 exit is still not ready. Missing proof is recorded in the audit summary.");
}
