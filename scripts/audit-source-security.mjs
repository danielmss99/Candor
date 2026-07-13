import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectSourceSecurityInput,
  evaluateSourceSecurity,
  runSourceSecuritySelfTest,
} from "./source-security-rules.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const input = collectSourceSecurityInput(repoRoot);
const evaluation = evaluateSourceSecurity(input);
const selfTest = runSourceSecuritySelfTest(input);

if (!evaluation.ok || !selfTest.ok) {
  console.error("Source security audit failed.");
  for (const failure of evaluation.failures) {
    console.error(`- ${failure.id}: ${failure.detail}${failure.file ? ` (${failure.file})` : ""}`);
  }
  for (const failedTest of selfTest.results.filter((result) => !result.ok)) {
    console.error(`- self-test ${failedTest.name} did not detect ${failedTest.expectedFailure}`);
  }
  process.exit(1);
}

console.log(`Source security audit passed (${evaluation.checks.length} checks, ${selfTest.results.length} mutation tests).`);
