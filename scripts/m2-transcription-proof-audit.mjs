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

function requireField(condition, message, failures) {
  if (!condition) failures.push(message);
}

function readJson(pathValue, label, failures) {
  if (!existsSync(pathValue)) {
    failures.push(`${label} artifact not found: ${rel(pathValue)}`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(pathValue, "utf8"));
  } catch (error) {
    failures.push(`${label} artifact is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function stringValues(value, values = []) {
  if (typeof value === "string") {
    values.push(value);
    return values;
  }
  if (Array.isArray(value)) {
    for (const item of value) stringValues(item, values);
    return values;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) stringValues(item, values);
  }
  return values;
}

function validateNoSensitivePaths(payload, label, failures) {
  const strings = stringValues(payload);
  requireField(!strings.some((value) => value.includes(repoRoot)), `${label} must not contain repo root`, failures);
  requireField(!strings.some((value) => /[A-Za-z]:\\/.test(value)), `${label} must not contain Windows absolute paths`, failures);
  requireField(
    !strings.some((value) => value.includes("\\\\?\\") || value.includes("\\\\.\\")),
    `${label} must not contain raw Windows device paths`,
    failures,
  );
}

function runPathScannerSelfTest() {
  const linkerLogFailures = [];
  validateNoSensitivePaths(
    { stderrTail: "duplicate symbol was found in:\nnext linker line" },
    "linker log fixture",
    linkerLogFailures,
  );
  if (linkerLogFailures.length > 0) {
    throw new Error(`path scanner rejected a pathless multiline log: ${linkerLogFailures.join("; ")}`);
  }

  const windowsPathFailures = [];
  validateNoSensitivePaths(
    { modelPath: "C:\\Private\\whisper-model.bin" },
    "Windows path fixture",
    windowsPathFailures,
  );
  if (!windowsPathFailures.some((failure) => failure.includes("Windows absolute paths"))) {
    throw new Error("path scanner accepted a Windows absolute path fixture");
  }
}

runPathScannerSelfTest();

function validateBoundaryProof(payload, failures) {
  requireField(payload?.ok === true, "boundary ok must be true", failures);
  requireField(
    payload?.proofKind === "m2-transcription-boundary-smoke",
    "boundary proofKind must be m2-transcription-boundary-smoke",
    failures,
  );
  requireField(payload?.localOnly === true, "boundary localOnly must be true", failures);
  requireField(payload?.cloudAi === false, "boundary cloudAi must be false", failures);
  requireField(payload?.rawPathExposed === false, "boundary rawPathExposed must be false", failures);
  requireField(
    payload?.keyMaterialExposedToRenderer === false,
    "boundary keyMaterialExposedToRenderer must be false",
    failures,
  );
  requireField(payload?.statusSummary?.engine === "whisper-rs", "statusSummary.engine must be whisper-rs", failures);
  requireField(
    payload?.statusSummary?.modelPathAcceptedFromRenderer === false,
    "statusSummary.modelPathAcceptedFromRenderer must be false",
    failures,
  );
  requireField(
    payload?.statusSummary?.recordingInput === "recordingId+optionalChannel",
    "statusSummary.recordingInput must be recordingId+optionalChannel",
    failures,
  );
  requireField(
    payload?.statusSummary?.schedulerWhisperLlmConcurrent === false,
    "statusSummary.schedulerWhisperLlmConcurrent must be false",
    failures,
  );
  requireField(payload?.synthetic?.statusChecked === true, "synthetic.statusChecked must be true", failures);
  requireField(
    payload?.synthetic?.syncedTranscriptSegments === true,
    "synthetic.syncedTranscriptSegments must be true",
    failures,
  );
  requireField(payload?.synthetic?.replayChunksChecked === true, "synthetic.replayChunksChecked must be true", failures);
  requireField(payload?.synthetic?.searchIndexed === true, "synthetic.searchIndexed must be true", failures);
  requireField(payload?.synthetic?.markdownExported === true, "synthetic.markdownExported must be true", failures);
  requireField(
    payload?.synthetic?.finishedAppendAccepted === true,
    "synthetic.finishedAppendAccepted must be true",
    failures,
  );
  requireField(payload?.synthetic?.transcriptSegmentCount === 2, "synthetic.transcriptSegmentCount must be 2", failures);
  requireField(payload?.synthetic?.audioChunkCount === 2, "synthetic.audioChunkCount must be 2", failures);
  requireField(
    Array.isArray(payload?.synthetic?.tracks) &&
      payload.synthetic.tracks.includes("mic") &&
      payload.synthetic.tracks.includes("system"),
    "synthetic.tracks must include mic and system",
    failures,
  );
  requireField(payload?.modelCustody?.statusChecked === true, "modelCustody.statusChecked must be true", failures);
  requireField(
    payload?.modelCustody?.missingModelFailsClosed === true,
    "modelCustody.missingModelFailsClosed must be true",
    failures,
  );
  requireField(
    payload?.modelCustody?.modelPathAcceptedFromRenderer === false,
    "modelCustody.modelPathAcceptedFromRenderer must be false",
    failures,
  );
  requireField(payload?.modelCustody?.manualInstallOnly === true, "modelCustody.manualInstallOnly must be true", failures);
  requireField(
    payload?.modelCustody?.backgroundDownloads === false,
    "modelCustody.backgroundDownloads must be false",
    failures,
  );
  requireField(
    Number.isInteger(payload?.modelCustody?.supportedModelCount) && payload.modelCustody.supportedModelCount > 0,
    "modelCustody.supportedModelCount must be positive",
    failures,
  );
}

function validateDefaultRunLocalEvidence(payload, failures) {
  if (payload?.realLocalWhisper?.ok === true) return;
  requireField(payload?.realLocalWhisper?.requested === false, "realLocalWhisper.requested must be false", failures);
  requireField(payload?.realLocalWhisper?.attempted === false, "realLocalWhisper.attempted must be false", failures);
  requireField(payload?.closedFailure?.attempted === true, "closedFailure.attempted must be true", failures);
  requireField(payload?.closedFailure?.ok === true, "closedFailure.ok must be true", failures);
  requireField(
    Array.isArray(payload?.closedFailure?.expectedCodes) &&
      payload.closedFailure.expectedCodes.includes(payload?.closedFailure?.code),
    "closedFailure.code must be one of expectedCodes",
    failures,
  );
}

function validateRealLocalWhisper(payload, failures) {
  const branch = payload?.realLocalWhisper;
  const semanticQuality = branch?.semanticQuality;
  requireField(branch?.requested === true, "realLocalWhisper.requested must be true", failures);
  requireField(branch?.attempted === true, "realLocalWhisper.attempted must be true", failures);
  requireField(branch?.ok === true, "realLocalWhisper.ok must be true", failures);
  requireField(branch?.engine === "whisper-rs", "realLocalWhisper.engine must be whisper-rs", failures);
  requireField(
    typeof branch?.modelId === "string" &&
      Array.isArray(payload?.statusSummary?.modelIds) &&
      payload.statusSummary.modelIds.includes(branch.modelId),
    "realLocalWhisper.modelId must be in statusSummary.modelIds",
    failures,
  );
  requireField(
    typeof branch?.modelSha256 === "string" && /^[a-fA-F0-9]{64}$/.test(branch.modelSha256),
    "realLocalWhisper.modelSha256 must be a SHA-256 hex string",
    failures,
  );
  requireField(
    Number.isInteger(branch?.modelBytes) && branch.modelBytes > 0,
    "realLocalWhisper.modelBytes must be positive",
    failures,
  );
  requireField(branch?.channel === "mic", "realLocalWhisper.channel must be mic", failures);
  requireField(branch?.audioFixture?.source === "operator-local-wav", "realLocalWhisper.audioFixture.source must be operator-local-wav", failures);
  requireField(
    branch?.audioFixture?.bitsPerSample === 16 &&
      Number.isInteger(branch?.audioFixture?.sampleRateHz) &&
      branch.audioFixture.sampleRateHz > 0 &&
      Number.isInteger(branch?.audioFixture?.channelCount) &&
      branch.audioFixture.channelCount > 0,
    "realLocalWhisper.audioFixture must describe PCM 16-bit audio",
    failures,
  );
  requireField(
    Number.isInteger(branch?.writtenSegmentCount) && branch.writtenSegmentCount > 0,
    "realLocalWhisper.writtenSegmentCount must be positive",
    failures,
  );
  requireField(
    Number.isInteger(branch?.transcriptSegmentCount) && branch.transcriptSegmentCount > 0,
    "realLocalWhisper.transcriptSegmentCount must be positive",
    failures,
  );
  requireField(
    semanticQuality?.configured === true,
    "realLocalWhisper.semanticQuality must be configured",
    failures,
  );
  requireField(
    Number.isInteger(semanticQuality?.expectedTokenCount) && semanticQuality.expectedTokenCount >= 2,
    "realLocalWhisper.semanticQuality expectedTokenCount must be at least 2",
    failures,
  );
  requireField(
    Number.isInteger(semanticQuality?.matchedTokenCount) &&
      Number.isInteger(semanticQuality?.minimumMatchedTokens) &&
      semanticQuality.matchedTokenCount >= semanticQuality.minimumMatchedTokens,
    "realLocalWhisper.semanticQuality matchedTokenCount must meet the minimum",
    failures,
  );
  requireField(
    typeof semanticQuality?.tokenCoverage === "number" &&
      typeof semanticQuality?.minimumTokenCoverage === "number" &&
      semanticQuality.tokenCoverage >= semanticQuality.minimumTokenCoverage &&
      semanticQuality.minimumTokenCoverage >= 0.75,
    "realLocalWhisper.semanticQuality token coverage must be at least 0.75",
    failures,
  );
  requireField(
    semanticQuality?.passed === true && branch?.expectedTextObserved === true,
    "realLocalWhisper semantic expected-text check must pass",
    failures,
  );
  requireField(
    semanticQuality?.transcriptTextRecorded === false &&
      semanticQuality?.expectedTextRecorded === false,
    "realLocalWhisper semantic proof must not record transcript or expected text",
    failures,
  );
}

function validatePreflightProof(payload, failures) {
  requireField(payload?.ok === true, "preflight ok must be true", failures);
  requireField(
    payload?.proofKind === "m2-local-whisper-preflight",
    "preflight proofKind must be m2-local-whisper-preflight",
    failures,
  );
  requireField(payload?.ready === true, "preflight ready must be true", failures);
  requireField(payload?.localOnly === true, "preflight localOnly must be true", failures);
  requireField(payload?.cloudAi === false, "preflight cloudAi must be false", failures);
  requireField(payload?.rawPathExposed === false, "preflight rawPathExposed must be false", failures);
  requireField(
    payload?.keyMaterialExposedToRenderer === false,
    "preflight keyMaterialExposedToRenderer must be false",
    failures,
  );
  requireField(
    payload?.checks?.localWhisperFeature?.attempted === true &&
      payload.checks.localWhisperFeature.ok === true,
    "preflight localWhisperFeature must pass",
    failures,
  );
  requireField(
    payload?.checks?.localWhisperUnitTests?.attempted === true &&
      payload.checks.localWhisperUnitTests.ok === true,
    "preflight localWhisperUnitTests must pass",
    failures,
  );
}

const requireRealLocal = hasArg("--require-real-local");
const boundaryPath = asPath(
  argValue(
    "--boundary-proof",
    join(
      "release-v3",
      "proofs",
      requireRealLocal
        ? `m2-transcription-boundary-smoke-real-${process.platform}-${process.arch}.json`
        : `m2-transcription-boundary-smoke-${process.platform}-${process.arch}.json`,
    ),
  ),
);
const preflightPath = asPath(
  argValue(
    "--preflight-proof",
    join("release-v3", "proofs", `m2-local-whisper-preflight-${process.platform}-${process.arch}.json`),
  ),
);
const outputPath = asPath(
  argValue(
    "--write",
    join(
      "release-v3",
      "proofs",
      requireRealLocal
        ? `m2-transcription-proof-audit-real-${process.platform}-${process.arch}.json`
        : `m2-transcription-proof-audit-${process.platform}-${process.arch}.json`,
    ),
  ),
);

const failures = [];
const boundary = readJson(boundaryPath, "boundary", failures);
const preflight = readJson(preflightPath, "preflight", failures);

if (boundary) {
  validateBoundaryProof(boundary, failures);
  validateNoSensitivePaths(boundary, "boundary proof", failures);
  if (requireRealLocal) {
    validateRealLocalWhisper(boundary, failures);
  } else {
    validateDefaultRunLocalEvidence(boundary, failures);
  }
}

if (preflight) {
  validatePreflightProof(preflight, failures);
  validateNoSensitivePaths(preflight, "preflight proof", failures);
}

const summary = {
  ok: failures.length === 0,
  proofKind: "m2-transcription-proof-audit",
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  requireRealLocal,
  boundaryProof: rel(boundaryPath),
  preflightProof: rel(preflightPath),
  synthetic: boundary?.synthetic ?? null,
  closedFailure: boundary?.closedFailure ?? null,
  realLocalWhisper: boundary?.realLocalWhisper ?? null,
  preflightReady: preflight?.ready ?? null,
  failures,
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

if (summary.ok) {
  console.log(`M2 transcription proof audit passed. Proof written to ${outputPath}.`);
} else {
  console.error(`M2 transcription proof audit failed. Proof written to ${outputPath}.`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}
