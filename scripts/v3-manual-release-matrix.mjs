import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MANUAL_RELEASE_MATRIX_REQUIREMENTS, validateManualReleaseEvidence } from "./manual-release-matrix-validation.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const strict = process.argv.includes("--strict");

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function gitValue(args) {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const inputPath = path.resolve(repoRoot, argValue("--input", "release-v3/manual-evidence/windows-release-matrix.json"));
const outputPath = path.resolve(repoRoot, argValue("--write", `release-v3/proofs/v3-manual-release-matrix-${process.platform}-${process.arch}.json`));
const inputPresent = existsSync(inputPath);
let evidence = null;
let parseFailure = null;
let inputBytes = null;

if (inputPresent) {
  inputBytes = readFileSync(inputPath);
  try {
    evidence = JSON.parse(inputBytes.toString("utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    parseFailure = `manual release evidence is not valid JSON: ${error instanceof Error ? error.message : String(error)}`;
  }
}

const expected = {
  productName: "Candor",
  version: packageJson.version,
  commit: gitValue(["rev-parse", "HEAD"]),
};
const failures = !inputPresent
  ? ["manual release evidence is missing; run the clean-machine and hardware matrix before release"]
  : parseFailure
    ? [parseFailure]
    : validateManualReleaseEvidence(evidence, expected);

const proof = {
  proofKind: "v3-manual-release-matrix",
  generatedAt: new Date().toISOString(),
  ok: failures.length === 0,
  releaseReady: failures.length === 0,
  inputPresent,
  candidate: {
    productName: evidence?.candidate?.productName ?? null,
    version: evidence?.candidate?.version ?? null,
    commit: evidence?.candidate?.commit ?? null,
    installerFilename: evidence?.candidate?.installer?.filename ?? null,
    installerSha256: evidence?.candidate?.installer?.sha256 ?? null,
  },
  environment: {
    windowsVersion: evidence?.environment?.windowsVersion ?? null,
    architecture: evidence?.environment?.architecture ?? null,
    machineRef: evidence?.environment?.machineRef ?? null,
    testedAt: evidence?.environment?.testedAt ?? null,
  },
  completed: {
    windowsCases: MANUAL_RELEASE_MATRIX_REQUIREMENTS.windowsCases.filter((name) => evidence?.windowsMatrix?.[name]?.passed === true),
    microphoneKinds: MANUAL_RELEASE_MATRIX_REQUIREMENTS.microphoneKinds.filter((kind) => evidence?.hardwareMatrix?.microphones?.some((entry) => entry?.kind === kind && entry?.passed === true)),
    hardwareCases: MANUAL_RELEASE_MATRIX_REQUIREMENTS.hardwareCases.filter((name) => evidence?.hardwareMatrix?.[name]?.passed === true),
    durationTargets: MANUAL_RELEASE_MATRIX_REQUIREMENTS.durationTargets.filter((target) => evidence?.recordings?.some((entry) => entry?.targetMinutes === target && entry?.passed === true)),
  },
  evidenceSha256: inputBytes ? createHash("sha256").update(inputBytes).digest("hex") : null,
  failures,
  localOnly: true,
  cloudAi: false,
  networkAttempted: false,
  rawPathExposed: false,
  keyMaterialExposed: false,
};

mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(proof, null, 2)}\n`, "utf8");

if (failures.length === 0) {
  console.log(`Windows release evidence passed. Proof written to ${path.relative(repoRoot, outputPath)}.`);
} else {
  console.log(`Windows release evidence remains blocked. Proof written to ${path.relative(repoRoot, outputPath)}.`);
  for (const failure of failures) console.log(`- ${failure}`);
  if (strict) process.exitCode = 1;
}
