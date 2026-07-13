import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectSourceSecurityInput,
  evaluateSourceSecurity,
  requiredSourcePaths,
  runSourceSecuritySelfTest,
} from "./source-security-rules.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const outputPath = resolve(
  repoRoot,
  argValue(
    "--write",
    join("release-v3", "proofs", `v3-source-security-proof-${process.platform}-${process.arch}.json`),
  ),
);
const input = collectSourceSecurityInput(repoRoot);
const evaluation = evaluateSourceSecurity(input);
const selfTest = runSourceSecuritySelfTest(input);
const missingSources = requiredSourcePaths.filter(
  (sourcePath) => typeof input.sources[sourcePath] !== "string",
);
const failures = [
  ...evaluation.failures.map((failure) => `${failure.id}: ${failure.detail}`),
  ...selfTest.results
    .filter((result) => !result.ok)
    .map((result) => `self-test ${result.name} did not detect ${result.expectedFailure}`),
];

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
    requiredSources: {
      ok: missingSources.length === 0,
      expected: requiredSourcePaths,
      missing: missingSources,
    },
    trackedEnvironmentFiles: {
      ok: input.trackedEnvironmentFiles.length === 0,
      files: input.trackedEnvironmentFiles,
    },
    ignoredEnvironmentFiles: {
      ok: [".env", ".env.local"].every((expected) =>
        input.ignoredEnvironmentFiles.includes(expected),
      ),
      expected: [".env", ".env.local"],
      ignored: input.ignoredEnvironmentFiles,
    },
    electronRustRules: {
      ok: evaluation.ok,
      checkCount: evaluation.checks.length,
      checks: evaluation.checks,
      failedIds: evaluation.failures.map((failure) => failure.id),
    },
    mutationTests: selfTest,
  },
  failures,
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(proof, null, 2)}\n`, "utf8");

if (!proof.ok) {
  console.error(`V3 source security proof failed. Proof written to ${outputPath}.`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`V3 source security proof passed. Proof written to ${outputPath}.`);
