import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");
const recordOnly = process.argv.includes("--record-only");
const consentFlag = "--i-understand-this-processes-local-audio";
const consentRequested =
  process.env.CANDOR_M2_REAL_WHISPER_CONSENT === "1" ||
  process.argv.includes(consentFlag);
const consentGranted = !recordOnly && consentRequested;

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

function npmInvocation(scriptName) {
  if (process.platform === "win32") {
    return {
      executable: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/c", `npm run ${scriptName}`],
    };
  }
  return {
    executable: "npm",
    args: ["run", scriptName],
  };
}

function proofPath(name) {
  return join("release-v3", "proofs", `${name}-${process.platform}-${process.arch}.json`);
}

const outputPath = asPath(
  argValue("--write", proofPath("m2-real-whisper-proof")),
);
const inputsPath = asPath(proofPath("m2-real-whisper-inputs"));
const preflightPath = asPath(proofPath("m2-local-whisper-preflight"));
const boundaryPath = asPath(proofPath("m2-transcription-boundary-smoke-real"));
const strictAuditPath = asPath(proofPath("m2-transcription-proof-audit-real"));

function readJsonIfExists(pathValue) {
  if (!existsSync(pathValue)) return null;
  try {
    return JSON.parse(readFileSync(pathValue, "utf8"));
  } catch (error) {
    return {
      ok: false,
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
}

function artifactSummary(pathValue) {
  const payload = readJsonIfExists(pathValue);
  if (!payload) {
    return {
      file: rel(pathValue),
      exists: false,
    };
  }
  return {
    file: rel(pathValue),
    exists: true,
    ok: payload?.ok === true,
    proofKind: payload?.proofKind ?? null,
    generatedAt: payload?.generatedAt ?? null,
    ready: payload?.ready ?? null,
    failures: Array.isArray(payload?.failures) ? payload.failures : [],
  };
}

function baseReport() {
  return {
    ok: false,
    proofKind: "m2-real-whisper-proof",
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    recordOnly,
    consentRequested,
    consentGranted,
    consentRequired: {
      env: "CANDOR_M2_REAL_WHISPER_CONSENT=1",
      cliFlag: consentFlag,
    },
    localOnly: true,
    cloudAi: false,
    downloadsAttempted: false,
    modelDownloadsAttempted: false,
    inputValidationAttempted: false,
    inferenceAttempted: false,
    rawPathExposed: false,
    keyMaterialExposedToRenderer: false,
    steps: [],
    inputProof: rel(inputsPath),
    preflightProof: rel(preflightPath),
    boundaryProof: rel(boundaryPath),
    strictAuditProof: rel(strictAuditPath),
    artifacts: {
      inputs: artifactSummary(inputsPath),
      preflight: artifactSummary(preflightPath),
      boundary: artifactSummary(boundaryPath),
      strictAudit: artifactSummary(strictAuditPath),
    },
    failures: [],
  };
}

function writeReport(report) {
  report.finishedAt = new Date().toISOString();
  report.artifacts = {
    inputs: artifactSummary(inputsPath),
    preflight: artifactSummary(preflightPath),
    boundary: artifactSummary(boundaryPath),
    strictAudit: artifactSummary(strictAuditPath),
  };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function runNpmScript(scriptName) {
  const command = npmInvocation(scriptName);
  const start = Date.now();
  const result = spawnSync(command.executable, command.args, {
    cwd: repoRoot,
    encoding: "utf8",
    shell: false,
    stdio: "inherit",
    windowsHide: true,
    env: process.env,
  });
  return {
    name: scriptName,
    command: `npm run ${scriptName}`,
    exitCode: result.status ?? 1,
    ok: result.status === 0,
    durationMs: Date.now() - start,
    error: result.error ? result.error.message : null,
  };
}

function strictAuditPassed() {
  const payload = readJsonIfExists(strictAuditPath);
  return (
    payload?.ok === true &&
    payload?.requireRealLocal === true &&
    payload?.realLocalWhisper?.ok === true
  );
}

const report = baseReport();

if (recordOnly) {
  report.failures.push(consentRequested ? "recordOnlyNoInference" : "missingConsent");
  writeReport(report);
  console.error(`M2 real Whisper proof was recorded without inference. Proof written to ${rel(outputPath)}.`);
  process.exit(0);
}

if (!consentGranted) {
  report.failures.push("missingConsent");
  writeReport(report);
  console.error(`M2 real Whisper proof requires explicit consent. Proof written to ${rel(outputPath)}.`);
  console.error("Set CANDOR_M2_REAL_WHISPER_CONSENT=1 or pass --i-understand-this-processes-local-audio to process local audio.");
  process.exit(1);
}

report.inputValidationAttempted = true;
const inputsStep = runNpmScript("m2:real-whisper-inputs");
report.steps.push(inputsStep);

if (!inputsStep.ok) {
  report.failures.push("inputValidationFailed");
  writeReport(report);
  console.error(`M2 real Whisper proof stopped before inference. Proof written to ${rel(outputPath)}.`);
  process.exit(1);
}

const preflightStep = runNpmScript("m2:whisper-preflight");
report.steps.push(preflightStep);

if (!preflightStep.ok) {
  report.failures.push("preflightFailed");
  writeReport(report);
  console.error(`M2 real Whisper proof stopped before inference. Proof written to ${rel(outputPath)}.`);
  process.exit(1);
}

report.inferenceAttempted = true;
const boundaryStep = runNpmScript("m2:transcription-boundary-smoke:real");
report.steps.push(boundaryStep);

if (!boundaryStep.ok) {
  report.failures.push("realInferenceFailed");
  writeReport(report);
  console.error(`M2 real Whisper proof failed during inference. Proof written to ${rel(outputPath)}.`);
  process.exit(1);
}

const strictAuditStep = runNpmScript("m2:transcription-proof-audit:real");
report.steps.push(strictAuditStep);

if (!strictAuditStep.ok || !strictAuditPassed()) {
  report.failures.push("strictAuditFailed");
  writeReport(report);
  console.error(`M2 real Whisper proof failed strict audit. Proof written to ${rel(outputPath)}.`);
  process.exit(1);
}

report.ok = true;
writeReport(report);
console.log(`M2 real Whisper proof passed. Proof written to ${rel(outputPath)}.`);
