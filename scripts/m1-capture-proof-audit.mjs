import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

function hasArg(name) {
  return process.argv.includes(name);
}

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

function requiredRealBranches() {
  const values = [];
  for (let index = 2; index < process.argv.length; index += 1) {
    if (process.argv[index] === "--require-real" && process.argv[index + 1]) {
      values.push(...process.argv[index + 1].split(","));
      index += 1;
    }
  }
  return values.map((value) => value.trim()).filter(Boolean);
}

function requireField(condition, message, failures) {
  if (!condition) failures.push(message);
}

function validBoundedDuration(value) {
  return Number.isInteger(value) && value >= 500 && value <= 5000;
}

function validateSyntheticProof(payload, failures) {
  requireField(payload?.ok === true, "ok must be true", failures);
  requireField(payload?.proofKind === "m1-capture-service-smoke", "proofKind must be m1-capture-service-smoke", failures);
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
  requireField(payload?.synthetic?.separatedChunks === true, "synthetic.separatedChunks must be true", failures);
  requireField(payload?.synthetic?.serializedWriter === true, "synthetic.serializedWriter must be true", failures);
  requireField(
    payload?.synthetic?.callbackIntegrityPolicy === true,
    "synthetic.callbackIntegrityPolicy must be true",
    failures,
  );
  requireField(payload?.statusSummary?.micImplemented === true, "statusSummary.micImplemented must be true", failures);
  requireField(
    payload?.statusSummary?.rawPathExposed === false,
    "statusSummary.rawPathExposed must be false",
    failures,
  );
  requireField(
    payload?.statusSummary?.callbackOverflowPolicy === "fail-capture-session",
    "statusSummary.callbackOverflowPolicy must be fail-capture-session",
    failures,
  );
  requireField(
    payload?.statusSummary?.runtimeStreamErrorPolicy === "propagate-to-session",
    "statusSummary.runtimeStreamErrorPolicy must be propagate-to-session",
    failures,
  );
  requireField(
    payload?.statusSummary?.silentCallbackDropsAllowed === false,
    "statusSummary.silentCallbackDropsAllowed must be false",
    failures,
  );
  requireField(
    payload?.deviceSummary?.rawPathExposed === false,
    "deviceSummary.rawPathExposed must be false",
    failures,
  );
}

function validateRealBranch(payload, branchName, failures) {
  const branch = payload?.realDevice?.[branchName];
  requireField(Boolean(branch), `realDevice.${branchName} must exist`, failures);
  if (!branch) return;
  requireField(branch.requested === true, `realDevice.${branchName}.requested must be true`, failures);
  requireField(branch.attempted === true, `realDevice.${branchName}.attempted must be true`, failures);
  requireField(branch.ok === true, `realDevice.${branchName}.ok must be true`, failures);
  requireField(
    Number.isInteger(branch.audioChunkCount) && branch.audioChunkCount > 0,
    `realDevice.${branchName}.audioChunkCount must be positive`,
    failures,
  );
  requireField(
    validBoundedDuration(branch.durationMsRequested),
    `realDevice.${branchName}.durationMsRequested must be between 500 and 5000`,
    failures,
  );
  requireField(
    Number.isFinite(branch.durationMsActual) && branch.durationMsActual >= 0,
    `realDevice.${branchName}.durationMsActual must be recorded`,
    failures,
  );
  requireField(branch.recordingState === "finished", `realDevice.${branchName}.recordingState must be finished`, failures);
  if (branchName === "combined") {
    requireField(
      Array.isArray(branch.tracks) && branch.tracks.includes("mic") && branch.tracks.includes("system"),
      "realDevice.combined.tracks must include mic and system",
      failures,
    );
  }
}

const proofPath = asPath(
  argValue(
    "--proof",
    join("release-v3", "proofs", `m1-capture-service-smoke-${process.platform}-${process.arch}.json`),
  ),
);
const requiredReal = requiredRealBranches();
const strictReal = requiredReal.length > 0;
const outputPath = asPath(
  argValue(
    "--write",
    join(
      "release-v3",
      "proofs",
      strictReal
        ? `m1-capture-proof-audit-real-${process.platform}-${process.arch}.json`
        : `m1-capture-proof-audit-${process.platform}-${process.arch}.json`,
    ),
  ),
);
const failures = [];

if (!existsSync(proofPath)) {
  failures.push(`capture proof artifact not found: ${rel(proofPath)}`);
}

let payload = null;
if (failures.length === 0) {
  payload = JSON.parse(readFileSync(proofPath, "utf8"));
  validateSyntheticProof(payload, failures);
  for (const branch of requiredReal) {
    if (!["mic", "system", "combined"].includes(branch)) {
      failures.push(`unknown real capture branch: ${branch}`);
      continue;
    }
    validateRealBranch(payload, branch, failures);
  }
}

const summary = {
  ok: failures.length === 0,
  proofKind: "m1-capture-proof-audit",
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  strictReal,
  requiredReal,
  captureProof: rel(proofPath),
  synthetic: payload?.synthetic ?? null,
  realDevice: payload?.realDevice ?? null,
  failures,
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

if (summary.ok) {
  console.log(`M1 capture proof audit passed. Proof written to ${outputPath}.`);
} else {
  console.error(`M1 capture proof audit failed. Proof written to ${outputPath}.`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}
