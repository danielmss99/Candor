import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");
const recordOnly = process.argv.includes("--record-only");

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

function requireField(condition, message, failures) {
  if (!condition) failures.push(message);
}

function readJson(pathValue, failures) {
  if (!existsSync(pathValue)) {
    failures.push(`capture service proof artifact not found: ${rel(pathValue)}`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(pathValue, "utf8"));
  } catch (error) {
    failures.push(`capture service proof artifact is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function validateNoSensitivePaths(payload, failures) {
  const serialized = JSON.stringify(payload);
  requireField(!serialized.includes(repoRoot), "capture readiness input must not contain repo root", failures);
  requireField(!/[A-Za-z]:\\/.test(serialized), "capture readiness input must not contain Windows absolute paths", failures);
}

function validateCommonCaptureProof(payload, failures) {
  requireField(payload?.ok === true, "capture smoke ok must be true", failures);
  requireField(
    payload?.proofKind === "m1-capture-service-smoke",
    "proofKind must be m1-capture-service-smoke",
    failures,
  );
  requireField(payload?.localOnly === true, "localOnly must be true", failures);
  requireField(payload?.cloudAi === false, "cloudAi must be false", failures);
  requireField(payload?.rawPathExposed === false, "rawPathExposed must be false", failures);
  requireField(
    payload?.keyMaterialExposedToRenderer === false,
    "keyMaterialExposedToRenderer must be false",
    failures,
  );
  requireField(payload?.synthetic?.statusChecked === true, "synthetic.statusChecked must be true", failures);
  requireField(payload?.synthetic?.devicesChecked === true, "synthetic.devicesChecked must be true", failures);
  requireField(payload?.statusSummary?.micImplemented === true, "mic capture must be implemented", failures);
  requireField(payload?.statusSummary?.rawPathExposed === false, "statusSummary must be pathless", failures);
  requireField(payload?.deviceSummary?.rawPathExposed === false, "deviceSummary must be pathless", failures);
  requireField(
    Number.isInteger(payload?.deviceSummary?.inputCount) && payload.deviceSummary.inputCount >= 0,
    "deviceSummary.inputCount must be recorded",
    failures,
  );
  requireField(
    Number.isInteger(payload?.deviceSummary?.outputCount) && payload.deviceSummary.outputCount >= 0,
    "deviceSummary.outputCount must be recorded",
    failures,
  );
}

function platformReadiness(payload, failures) {
  const platform = payload?.platform;
  const status = payload?.statusSummary ?? {};
  const ready = {
    platform,
    micAvailable: status.defaultInputAvailable === true,
    systemAvailable: false,
    combinedAvailable: false,
    backend: status.systemBackend ?? null,
    macosSystemAudioPending: payload?.pendingAdapters?.macosSystemAudio === true,
  };

  requireField(ready.micAvailable, "default microphone input is not available", failures);

  if (platform === "win32") {
    ready.systemAvailable =
      status.systemImplemented === true &&
      status.defaultOutputAvailable === true &&
      status.defaultSystemDeviceAvailable === true &&
      status.systemBackend === "cpal-wasapi-loopback";
    ready.combinedAvailable = ready.systemAvailable && status.simultaneousMicAndSystem === true;
    requireField(ready.systemAvailable, "Windows WASAPI loopback system capture is not ready", failures);
    requireField(ready.combinedAvailable, "Windows combined mic plus system capture is not ready", failures);
  } else if (platform === "linux") {
    ready.systemAvailable =
      status.systemImplemented === true &&
      status.defaultSystemDeviceAvailable === true &&
      status.systemBackend === "cpal-linux-monitor-input";
    ready.combinedAvailable = ready.systemAvailable && status.simultaneousMicAndSystem === true;
    requireField(ready.systemAvailable, "Linux monitor-input system capture is not ready", failures);
    requireField(ready.combinedAvailable, "Linux combined mic plus system capture is not ready", failures);
  } else if (platform === "darwin") {
    ready.systemAvailable =
      status.systemImplemented === true &&
      status.defaultSystemDeviceAvailable === true &&
      status.systemBackend === "screencapturekit-system-audio" &&
      status.systemAvailabilityProbe === "tcc-gated-at-capture-start" &&
      status.systemRequiresOsPermission === true;
    ready.combinedAvailable = ready.systemAvailable && status.simultaneousMicAndSystem === true;
    ready.permissionVerifiedByReadiness = false;
    ready.permissionVerification = "real capture start only";
    requireField(ready.systemAvailable, "macOS ScreenCaptureKit system capture is not structurally ready", failures);
    requireField(ready.combinedAvailable, "macOS combined mic plus system capture is not structurally ready", failures);
    requireField(
      payload?.pendingAdapters?.macosSystemAudio === false,
      "macOS ScreenCaptureKit adapter must not be reported as pending",
      failures,
    );
  } else {
    requireField(false, `unsupported capture readiness platform: ${platform ?? "unknown"}`, failures);
  }

  return ready;
}

const proofPath = asPath(
  argValue(
    "--proof",
    join("release-v3", "proofs", `m1-capture-service-smoke-${process.platform}-${process.arch}.json`),
  ),
);
const outputPath = asPath(
  argValue(
    "--write",
    join("release-v3", "proofs", `m1-real-capture-readiness-${process.platform}-${process.arch}.json`),
  ),
);

const failures = [];
const payload = readJson(proofPath, failures);
let readiness = null;
if (payload) {
  validateCommonCaptureProof(payload, failures);
  validateNoSensitivePaths(payload, failures);
  readiness = platformReadiness(payload, failures);
}

const ready = failures.length === 0;
const report = {
  ok: recordOnly || ready,
  proofKind: "m1-real-capture-readiness",
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  recordOnly,
  ready,
  captureProof: rel(proofPath),
  localOnly: true,
  cloudAi: false,
  recordingAttempted: false,
  operatorConsentRequiredForRealCapture: true,
  readiness,
  realDevice: payload?.realDevice ?? null,
  rawPathExposed: false,
  keyMaterialExposedToRenderer: false,
  failures,
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

if (ready) {
  console.log(`M1 real capture readiness passed. Proof written to ${outputPath}.`);
} else {
  console.error(`M1 real capture readiness is not ready. Proof written to ${outputPath}.`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
}

if (!report.ok) {
  process.exit(1);
}
