import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");
const recordOnly = process.argv.includes("--record-only");
const consentFlag = "--i-understand-this-records-local-audio";
const consentRequested =
  process.env.CANDOR_M1_REAL_CAPTURE_CONSENT === "1" ||
  process.argv.includes(consentFlag);
const consentGranted = !recordOnly && consentRequested;
const realCaptureDurationBoundsMs = {
  min: 500,
  max: 5000,
  default: 1200,
};

function realCaptureDurationMs() {
  const raw = process.env.CANDOR_M1_REAL_CAPTURE_DURATION_MS;
  if (raw === undefined || raw === "") return realCaptureDurationBoundsMs.default;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return realCaptureDurationBoundsMs.default;
  return Math.min(realCaptureDurationBoundsMs.max, Math.max(realCaptureDurationBoundsMs.min, parsed));
}

const realDurationMs = realCaptureDurationMs();

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
  argValue("--write", proofPath("m1-real-capture-proof")),
);
const readinessPath = asPath(proofPath("m1-real-capture-readiness"));
const capturePath = asPath(proofPath("m1-capture-service-smoke"));
const strictAuditPath = asPath(proofPath("m1-capture-proof-audit-real"));

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
    failures: Array.isArray(payload?.failures) ? payload.failures : [],
  };
}

function baseReport() {
  return {
    ok: false,
    proofKind: "m1-real-capture-proof",
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    recordOnly,
    consentRequested,
    consentGranted,
    consentRequired: {
      env: "CANDOR_M1_REAL_CAPTURE_CONSENT=1",
      cliFlag: consentFlag,
    },
    localOnly: true,
    cloudAi: false,
    recordingAttempted: false,
    realCaptureDuration: {
      env: "CANDOR_M1_REAL_CAPTURE_DURATION_MS",
      requestedMs: realDurationMs,
      defaultMs: realCaptureDurationBoundsMs.default,
      boundsMs: {
        min: realCaptureDurationBoundsMs.min,
        max: realCaptureDurationBoundsMs.max,
      },
    },
    rawPathExposed: false,
    keyMaterialExposedToRenderer: false,
    steps: [],
    readinessProof: rel(readinessPath),
    captureProof: rel(capturePath),
    strictAuditProof: rel(strictAuditPath),
    artifacts: {
      readiness: artifactSummary(readinessPath),
      capture: artifactSummary(capturePath),
      strictAudit: artifactSummary(strictAuditPath),
    },
    failures: [],
  };
}

function writeReport(report) {
  report.finishedAt = new Date().toISOString();
  report.artifacts = {
    readiness: artifactSummary(readinessPath),
    capture: artifactSummary(capturePath),
    strictAudit: artifactSummary(strictAuditPath),
  };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function runNpmScript(scriptName, extraEnv = {}) {
  const command = npmInvocation(scriptName);
  const start = Date.now();
  const result = spawnSync(command.executable, command.args, {
    cwd: repoRoot,
    encoding: "utf8",
    shell: false,
    stdio: "inherit",
    windowsHide: true,
    env: {
      ...process.env,
      ...extraEnv,
    },
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
  return payload?.ok === true && payload?.strictReal === true;
}

const report = baseReport();

if (!consentGranted) {
  report.failures.push("missingConsent");
  report.ready = false;
  report.recordingAttempted = false;
  writeReport(report);
  console.error(`M1 real capture proof requires explicit consent. Proof written to ${rel(outputPath)}.`);
  console.error("Set CANDOR_M1_REAL_CAPTURE_CONSENT=1 or pass --i-understand-this-records-local-audio to record local audio.");
  if (!recordOnly) process.exit(1);
  process.exit(0);
}

const readinessStep = runNpmScript("m1:real-capture-readiness");
report.steps.push(readinessStep);

if (!readinessStep.ok) {
  report.failures.push("readinessFailed");
  report.ready = false;
  writeReport(report);
  console.error(`M1 real capture proof stopped before recording. Proof written to ${rel(outputPath)}.`);
  if (!recordOnly) process.exit(1);
  process.exit(0);
}

report.ready = true;
report.recordingAttempted = true;
const captureStep = runNpmScript("m1:capture-service-smoke", {
  CANDOR_CAPTURE_REAL_DEVICE: "1",
  CANDOR_CAPTURE_REAL_SYSTEM: "1",
  CANDOR_CAPTURE_REAL_BOTH: "1",
  CANDOR_M1_REAL_CAPTURE_DURATION_MS: String(realDurationMs),
});
report.steps.push(captureStep);

if (!captureStep.ok) {
  report.failures.push("realCaptureFailed");
  writeReport(report);
  console.error(`M1 real capture proof failed during recording. Proof written to ${rel(outputPath)}.`);
  if (!recordOnly) process.exit(1);
  process.exit(0);
}

const strictAuditStep = runNpmScript("m1:capture-proof-audit:real");
report.steps.push(strictAuditStep);

if (!strictAuditStep.ok || !strictAuditPassed()) {
  report.failures.push("strictAuditFailed");
  writeReport(report);
  console.error(`M1 real capture proof failed strict audit. Proof written to ${rel(outputPath)}.`);
  if (!recordOnly) process.exit(1);
  process.exit(0);
}

report.ok = true;
report.ready = true;
writeReport(report);
console.log(`M1 real capture proof passed. Proof written to ${rel(outputPath)}.`);
