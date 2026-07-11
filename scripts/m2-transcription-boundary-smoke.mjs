import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const exe = process.platform === "win32" ? "candor-core.exe" : "candor-core";
const realLocalRequested =
  process.argv.includes("--real-local") || process.env.CANDOR_M2_REAL_LOCAL_WHISPER === "1";
const rpcTimeoutMs = realLocalRequested ? 180000 : 5000;
const coreArg = argValue("--core", firstPositional());
const corePath = coreArg
  ? path.resolve(coreArg)
  : path.join(
      repoRoot,
      "crates",
      "candor-core",
      "target",
      realLocalRequested ? "release" : "debug",
      exe,
    );
const outputPath = path.resolve(
  repoRoot,
  argValue(
    "--write",
    path.join(
      "release-v3",
      "proofs",
      realLocalRequested
        ? `m2-transcription-boundary-smoke-real-${process.platform}-${process.arch}.json`
        : `m2-transcription-boundary-smoke-${process.platform}-${process.arch}.json`,
    ),
  ),
);
const defaultAudioFixturePath = path.join(
  repoRoot,
  "release-v3",
  "fixtures",
  `m2-real-whisper-fixture-${process.platform}-${process.arch}.wav`,
);
const realModelPath = argValue("--model", process.env.CANDOR_M2_REAL_MODEL_PATH ?? null);
const realAudioPath = argValue(
  "--audio",
  process.env.CANDOR_M2_REAL_AUDIO_WAV ?? (existsSync(defaultAudioFixturePath) ? defaultAudioFixturePath : null),
);
const realModelId = argValue("--model-id", process.env.CANDOR_M2_REAL_MODEL_ID ?? "base.en");
const realLanguage = argValue("--language", process.env.CANDOR_M2_REAL_LANGUAGE ?? "en");
const realExpectedText = argValue("--expect-text", process.env.CANDOR_M2_REAL_EXPECT_TEXT ?? null);
const minimumExpectedTextTokenCoverage = 0.75;

if (!existsSync(corePath)) {
  throw new Error(`candor-core binary not found: ${corePath}`);
}

const dataDir = mkdtempSync(path.join(tmpdir(), "candor-v3-m2-transcription-"));
const child = spawn(corePath, [], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
  env: {
    ...process.env,
    CANDOR_V3_DATA_DIR: dataDir,
  },
});

const lines = createInterface({ input: child.stdout });
const pending = new Map();
let nextId = 1;

child.stderr.on("data", (chunk) => {
  process.stderr.write(`[candor-core stderr] ${chunk}`);
});

lines.on("line", (line) => {
  const response = JSON.parse(line);
  const entry = pending.get(response.id);
  if (!entry) return;
  pending.delete(response.id);
  if (response.ok) {
    entry.resolve(response.result);
  } else {
    const error = new Error(response.error?.message ?? "RPC failed");
    error.code = response.error?.code;
    error.response = response;
    entry.reject(error);
  }
});

function call(method, params = null) {
  const id = nextId++;
  const payload = JSON.stringify({ id, method, params });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for ${method}`));
    }, rpcTimeoutMs);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      reject: (err) => {
        clearTimeout(timeout);
        reject(err);
      },
    });
    child.stdin.write(`${payload}\n`);
  });
}

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function firstPositional() {
  for (let index = 2; index < process.argv.length; index += 1) {
    const value = process.argv[index];
    if (value.startsWith("--")) {
      if (["--core", "--write"].includes(value)) index += 1;
      continue;
    }
    return value;
  }
  return null;
}

function writeProof(value) {
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function requireLocalFile(pathValue, label) {
  if (!pathValue) {
    throw new Error(`real local Whisper requires ${label}`);
  }
  const resolved = path.resolve(pathValue);
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    throw new Error(`real local Whisper ${label} is not a readable file`);
  }
  return resolved;
}

function parseWavPcm16(pathValue) {
  const bytes = readFileSync(pathValue);
  if (bytes.length < 44 || bytes.subarray(0, 4).toString("ascii") !== "RIFF") {
    throw new Error("real local Whisper audio fixture must be a RIFF WAV file");
  }
  if (bytes.subarray(8, 12).toString("ascii") !== "WAVE") {
    throw new Error("real local Whisper audio fixture must be a WAVE file");
  }

  let offset = 12;
  let format = null;
  let data = null;
  while (offset + 8 <= bytes.length) {
    const id = bytes.subarray(offset, offset + 4).toString("ascii");
    const size = bytes.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + size;
    if (chunkEnd > bytes.length) {
      throw new Error("real local Whisper WAV fixture has a truncated chunk");
    }
    if (id === "fmt ") {
      if (size < 16) throw new Error("real local Whisper WAV fmt chunk is too small");
      format = {
        audioFormat: bytes.readUInt16LE(chunkStart),
        channelCount: bytes.readUInt16LE(chunkStart + 2),
        sampleRateHz: bytes.readUInt32LE(chunkStart + 4),
        bitsPerSample: bytes.readUInt16LE(chunkStart + 14),
      };
    } else if (id === "data") {
      data = bytes.subarray(chunkStart, chunkEnd);
    }
    offset = chunkEnd + (size % 2);
  }

  if (!format) throw new Error("real local Whisper WAV fixture is missing fmt chunk");
  if (!data) throw new Error("real local Whisper WAV fixture is missing data chunk");
  if (format.audioFormat !== 1) {
    throw new Error("real local Whisper WAV fixture must be PCM, not compressed or float audio");
  }
  if (format.bitsPerSample !== 16) {
    throw new Error("real local Whisper WAV fixture must be 16-bit PCM");
  }
  if (format.sampleRateHz <= 0 || format.channelCount <= 0) {
    throw new Error("real local Whisper WAV fixture has an invalid sample rate or channel count");
  }
  const frameBytes = format.channelCount * 2;
  if (data.length === 0 || data.length % frameBytes !== 0) {
    throw new Error("real local Whisper WAV fixture data must align to PCM frames");
  }

  return {
    ...format,
    pcm: Buffer.from(data),
    durationMs: Math.round((data.length / frameBytes / format.sampleRateHz) * 1000),
  };
}

function normalizedWordTokens(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];
}

function transcriptSegmentText(transcript) {
  if (!Array.isArray(transcript?.segments)) return "";
  return transcript.segments
    .map((segment) => (typeof segment?.text === "string" ? segment.text : ""))
    .join(" ");
}

function semanticExpectedTextEvidence(expectedText, transcript) {
  const expectedTokens = [...new Set(normalizedWordTokens(expectedText))];
  const actualTokens = new Set(normalizedWordTokens(transcriptSegmentText(transcript)));
  const matchedTokenCount = expectedTokens.filter((token) => actualTokens.has(token)).length;
  const expectedTokenCount = expectedTokens.length;
  const minimumMatchedTokens = Math.min(
    expectedTokenCount,
    Math.max(2, Math.ceil(expectedTokenCount * minimumExpectedTextTokenCoverage)),
  );
  const tokenCoverage = expectedTokenCount > 0 ? matchedTokenCount / expectedTokenCount : 0;
  return {
    configured: true,
    expectedTokenCount,
    actualTokenCount: actualTokens.size,
    matchedTokenCount,
    minimumMatchedTokens,
    tokenCoverage,
    minimumTokenCoverage: minimumExpectedTextTokenCoverage,
    passed:
      expectedTokenCount >= 2 &&
      matchedTokenCount >= minimumMatchedTokens &&
      tokenCoverage >= minimumExpectedTextTokenCoverage,
    transcriptTextRecorded: false,
    expectedTextRecorded: false,
  };
}

async function importVerifiedModel(modelPath, modelId) {
  const size = statSync(modelPath).size;
  const started = await call("models.importStart", {
    modelId,
    expectedBytes: size,
    replace: true,
  });
  assertCustody(started, "real model import start");
  const chunkBytesMax = started?.chunkBytesMax ?? 512 * 1024;
  let lastChunk = null;
  for await (const chunk of createReadStream(modelPath, { highWaterMark: chunkBytesMax })) {
    lastChunk = await call("models.importChunk", {
      importId: started.importId,
      dataBase64: chunk.toString("base64"),
    });
    assertCustody(lastChunk, "real model import chunk");
  }
  if (lastChunk?.bytesWritten !== size || lastChunk?.complete !== true) {
    throw new Error("real model import did not stream the expected byte count");
  }
  const finished = await call("models.importFinish", { importId: started.importId });
  assertCustody(finished, "real model import finish");
  if (
    finished?.imported !== true ||
    finished?.rejected !== false ||
    finished?.verification?.modelId !== modelId ||
    finished?.verification?.verified !== true
  ) {
    throw new Error("real model import did not verify against the trusted SHA-256 pin");
  }
  return {
    modelId,
    bytes: finished?.verification?.bytes ?? size,
    sha256: finished?.verification?.actualSha256 ?? null,
  };
}

function assertCustody(value, label) {
  const serialized = JSON.stringify(value);
  if (serialized.includes(dataDir)) {
    throw new Error(`${label} exposed the data root path`);
  }
  visit(value, label);
}

function visit(value, label) {
  if (Array.isArray(value)) {
    for (const item of value) visit(item, label);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, childValue] of Object.entries(value)) {
    if (key === "rawPathExposed" && childValue !== false) {
      throw new Error(`${label} reported raw path exposure`);
    }
    if (key === "keyMaterialExposedToRenderer" && childValue !== false) {
      throw new Error(`${label} reported key material exposure`);
    }
    visit(childValue, label);
  }
}

async function expectError(method, params, expectedCodes) {
  try {
    await call(method, params);
  } catch (error) {
    if (!expectedCodes.includes(error.code)) {
      throw new Error(
        `expected ${expectedCodes.join(", ")} from ${method}, got ${error.code ?? "unknown"}`,
      );
    }
    return error.code;
  }
  throw new Error(`expected ${method} to fail with ${expectedCodes.join(", ")}`);
}

const proofReceipt = {
  ok: false,
  proofKind: "m2-transcription-boundary-smoke",
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  localOnly: true,
  cloudAi: false,
  coreBinary: coreArg ? "custom" : realLocalRequested ? "release-default" : "debug-default",
  synthetic: {
    statusChecked: false,
    syncedTranscriptSegments: false,
    replayChunksChecked: false,
    searchIndexed: false,
    markdownExported: false,
    finishedAppendAccepted: false,
  },
  modelCustody: {
    statusChecked: false,
    missingModelFailsClosed: false,
    modelPathAcceptedFromRenderer: false,
    manualInstallOnly: null,
    backgroundDownloads: null,
    supportedModelCount: null,
  },
  closedFailure: {
    attempted: false,
    ok: false,
    code: null,
    expectedCodes: [],
  },
  realLocalWhisper: {
    requested: realLocalRequested,
    attempted: false,
    ok: null,
    skippedReason: realLocalRequested
      ? null
      : "set CANDOR_M2_REAL_LOCAL_WHISPER=1 or pass --real-local to attempt real local Whisper inference",
    modelId: realLocalRequested ? realModelId : null,
    semanticQuality: {
      configured: Boolean(realExpectedText),
      passed: null,
      transcriptTextRecorded: false,
      expectedTextRecorded: false,
    },
  },
  rawPathExposed: false,
  keyMaterialExposedToRenderer: false,
};

try {
  const status = await call("transcription.status");
  assertCustody(status, "transcription status");
  if (
    status?.localOnly !== true ||
    status?.cloudAi !== false ||
    status?.modelPathAcceptedFromRenderer !== false ||
    status?.recordingInput !== "recordingId+optionalChannel" ||
    status?.scheduler?.whisperLlmConcurrent !== false
  ) {
    throw new Error("transcription status did not report the local-only contract");
  }
  proofReceipt.synthetic.statusChecked = true;
  proofReceipt.statusSummary = {
    engine: status?.engine ?? null,
    whisperFeatureEnabled: status?.whisperFeatureEnabled === true,
    defaultModelId: status?.defaultModelId ?? null,
    modelIds: Array.isArray(status?.modelIds) ? status.modelIds : [],
    modelPathAcceptedFromRenderer: status?.modelPathAcceptedFromRenderer === true,
    recordingInput: status?.recordingInput ?? null,
    schedulerWhisperLlmConcurrent: status?.scheduler?.whisperLlmConcurrent === true,
  };

  const modelStatus = await call("models.status");
  assertCustody(modelStatus, "model status");
  if (
    modelStatus?.localOnly !== true ||
    modelStatus?.cloudAi !== false ||
    modelStatus?.modelPathAcceptedFromRenderer !== false ||
    modelStatus?.manualInstallOnly !== true ||
    modelStatus?.backgroundDownloads !== false
  ) {
    throw new Error("model status did not report the local model custody contract");
  }
  proofReceipt.modelCustody.statusChecked = true;
  proofReceipt.modelCustody.manualInstallOnly = modelStatus?.manualInstallOnly === true;
  proofReceipt.modelCustody.backgroundDownloads = modelStatus?.backgroundDownloads === true;
  proofReceipt.modelCustody.supportedModelCount = modelStatus?.supportedModelCount ?? null;

  const missingModel = await call("models.verifyLocal", { modelId: realModelId });
  assertCustody(missingModel, "missing model verification");
  if (
    missingModel?.modelId !== realModelId ||
    missingModel?.installed !== false ||
    missingModel?.verified !== false ||
    missingModel?.failureCode !== "MODEL_NOT_INSTALLED"
  ) {
    throw new Error("missing model verification did not fail closed");
  }
  proofReceipt.modelCustody.missingModelFailsClosed = true;

  const proof = await call("transcription.proofSynthetic", {
    label: "M2 Transcription Boundary",
  });
  assertCustody(proof, "synthetic transcription proof");
  if (
    proof?.proof?.engine !== "synthetic-proof" ||
    proof?.proof?.whisperRan !== false ||
    proof?.proof?.syncedTranscriptSegments !== true ||
    proof?.transcript?.segmentCount !== 2 ||
    proof?.replay?.audioChunkCount !== 2
  ) {
    throw new Error("synthetic transcription proof did not write synced local segments");
  }
  proofReceipt.synthetic.syncedTranscriptSegments = true;
  proofReceipt.synthetic.replayChunksChecked = true;
  proofReceipt.synthetic.transcriptSegmentCount = proof?.transcript?.segmentCount ?? null;
  proofReceipt.synthetic.audioChunkCount = proof?.replay?.audioChunkCount ?? null;
  proofReceipt.synthetic.tracks = Array.isArray(proof?.replay?.tracks) ? proof.replay.tracks : [];

  const recordingId = proof.recording?.recordingId;
  const search = await call("recording.durable.search", { query: "pathless" });
  assertCustody(search, "transcription search");
  if (search?.matchCount !== 1 || search?.matches?.[0]?.recordingId !== recordingId) {
    throw new Error("search did not index the transcription proof output");
  }
  proofReceipt.synthetic.searchIndexed = true;
  proofReceipt.synthetic.searchMatchCount = search?.matchCount ?? null;

  const exportResult = await call("export.create", { recordingId, format: "markdown" });
  assertCustody(exportResult, "transcription export");
  if (
    !exportResult?.markdown?.includes("Local transcription proof created this synced segment.") ||
    !exportResult?.markdown?.includes("System audio stays local and pathless.")
  ) {
    throw new Error("markdown export did not include transcription proof segments");
  }
  proofReceipt.synthetic.markdownExported = true;
  proofReceipt.synthetic.markdownBytes = exportResult?.bytes ?? null;

  const started = await call("recording.durable.start", {
    label: "M2 Transcription Finished Append",
  });
  const appendRecordingId = started.recordingId;
  const audio = Buffer.alloc(9600, 2);
  await call("recording.durable.writeAudioChunk", {
    recordingId: appendRecordingId,
    channel: "mic",
    sampleRateHz: 48000,
    channelCount: 1,
    bitsPerSample: 16,
    dataBase64: audio.toString("base64"),
  });
  await call("recording.durable.finish", { recordingId: appendRecordingId });
  await call("recording.durable.writeTranscriptSegment", {
    recordingId: appendRecordingId,
    channel: "mic",
    speaker: "Me",
    text: "Finished recordings can receive local transcription output.",
    startMs: 0,
    durationMs: 900,
    confidence: 0.97,
  });
  const finishedTranscript = await call("recording.durable.transcript", {
    recordingId: appendRecordingId,
  });
  assertCustody(finishedTranscript, "finished transcript append");
  if (finishedTranscript?.segmentCount !== 1) {
    throw new Error("finished recording did not accept a local transcript segment");
  }
  proofReceipt.synthetic.finishedAppendAccepted = true;
  proofReceipt.synthetic.finishedAppendSegmentCount = finishedTranscript?.segmentCount ?? null;

  const runLocalParams = {
    recordingId: appendRecordingId,
    channel: "mic",
    modelId: "base.en",
    language: "en",
  };

  if (realLocalRequested) {
    if (status.whisperFeatureEnabled !== true) {
      throw new Error("real local Whisper requires a candor-core build with the local-whisper feature");
    }
    const modelFile = requireLocalFile(realModelPath, "--model or CANDOR_M2_REAL_MODEL_PATH");
    const audioFile = requireLocalFile(realAudioPath, "--audio or CANDOR_M2_REAL_AUDIO_WAV");
    const importedModel = await importVerifiedModel(modelFile, realModelId);
    const wav = parseWavPcm16(audioFile);
    const realStarted = await call("recording.durable.start", {
      label: "M2 Real Local Whisper Fixture",
    });
    const realRecordingId = realStarted.recordingId;
    const realWrite = await call("recording.durable.writeAudioChunk", {
      recordingId: realRecordingId,
      channel: "mic",
      sampleRateHz: wav.sampleRateHz,
      channelCount: wav.channelCount,
      bitsPerSample: wav.bitsPerSample,
      dataBase64: wav.pcm.toString("base64"),
    });
    assertCustody(realWrite, "real audio fixture write");
    if (realWrite?.audioChunkCount !== 1) {
      throw new Error("real audio fixture did not write exactly one durable audio chunk");
    }
    await call("recording.durable.finish", { recordingId: realRecordingId });

    proofReceipt.realLocalWhisper.attempted = true;
    const localResult = await call("transcription.runLocal", {
      recordingId: realRecordingId,
      channel: "mic",
      modelId: realModelId,
      language: realLanguage,
    });
    assertCustody(localResult, "real local transcription");
    if (
      localResult?.localOnly !== true ||
      localResult?.cloudAi !== false ||
      localResult?.engine !== "whisper-rs" ||
      !(localResult?.writtenSegmentCount > 0) ||
      !(localResult?.transcript?.segmentCount > 0)
    ) {
      throw new Error("real local Whisper did not return pathless transcript segments");
    }
    proofReceipt.realLocalWhisper.ok = true;
    proofReceipt.realLocalWhisper.engine = localResult.engine;
    proofReceipt.realLocalWhisper.modelId = localResult?.model?.modelId ?? null;
    proofReceipt.realLocalWhisper.modelSha256 = importedModel.sha256;
    proofReceipt.realLocalWhisper.modelBytes = importedModel.bytes;
    proofReceipt.realLocalWhisper.channel = localResult?.channel ?? null;
    proofReceipt.realLocalWhisper.language = localResult?.language ?? null;
    proofReceipt.realLocalWhisper.audioDurationMs = localResult?.audioDurationMs ?? null;
    proofReceipt.realLocalWhisper.audioFixture = {
      source: "operator-local-wav",
      sampleRateHz: wav.sampleRateHz,
      channelCount: wav.channelCount,
      bitsPerSample: wav.bitsPerSample,
      durationMs: wav.durationMs,
      bytes: wav.pcm.length,
    };
    proofReceipt.realLocalWhisper.writtenSegmentCount = localResult?.writtenSegmentCount ?? null;
    proofReceipt.realLocalWhisper.transcriptSegmentCount = localResult?.transcript?.segmentCount ?? null;
    if (!realExpectedText) {
      throw new Error("real local Whisper strict proof requires expected semantic text");
    }
    const semanticQuality = semanticExpectedTextEvidence(realExpectedText, localResult?.transcript);
    proofReceipt.realLocalWhisper.semanticQuality = semanticQuality;
    proofReceipt.realLocalWhisper.expectedTextObserved = semanticQuality.passed;
    if (!semanticQuality.passed) {
      throw new Error("real local Whisper transcript did not meet expected token coverage");
    }
  } else {
    const expectedCodes =
      status.whisperFeatureEnabled === false
        ? ["TRANSCRIPTION_ENGINE_UNAVAILABLE"]
        : ["MODEL_NOT_INSTALLED", "MODEL_HASH_MISMATCH", "MODEL_VERIFY_FAILED"];
    const code = await expectError("transcription.runLocal", runLocalParams, expectedCodes);
    proofReceipt.closedFailure = {
      attempted: true,
      ok: true,
      code,
      expectedCodes,
      whisperFeatureEnabled: status.whisperFeatureEnabled === true,
    };
  }

  await call("core.shutdown");
  proofReceipt.ok = true;
  proofReceipt.finishedAt = new Date().toISOString();
  writeProof(proofReceipt);
  console.log("M2 transcription boundary smoke passed.");
  console.log(`M2 transcription boundary proof written to ${outputPath}.`);
} catch (error) {
  proofReceipt.ok = false;
  proofReceipt.finishedAt = new Date().toISOString();
  proofReceipt.error = {
    message: error instanceof Error ? error.message : String(error),
    code: error?.code ?? null,
  };
  writeProof(proofReceipt);
  throw error;
} finally {
  if (!child.killed) child.kill();
  rmSync(dataDir, { recursive: true, force: true });
}
