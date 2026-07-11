import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const exe = process.platform === "win32" ? "candor-core.exe" : "candor-core";
const corePath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(repoRoot, "crates", "candor-core", "target", "debug", exe);

if (!existsSync(corePath)) {
  throw new Error(`candor-core debug binary not found: ${corePath}`);
}

const dataDir = mkdtempSync(path.join(tmpdir(), "candor-v3-m2-audio-"));
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
    }, 5000);
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

async function expectError(method, params, expectedCode) {
  try {
    await call(method, params);
  } catch (error) {
    if (error.code !== expectedCode) {
      throw new Error(`expected ${expectedCode} from ${method}, got ${error.code ?? "unknown"}`);
    }
    return;
  }
  throw new Error(`expected ${method} to fail with ${expectedCode}`);
}

try {
  const status = await call("recording.durable.status");
  if (
    status?.durableAudioChunks !== true ||
    status?.acceptedAudioFormat !== "pcm_s16le" ||
    status?.audioChunkReadMethod !== "recording.durable.readAudioChunk"
  ) {
    throw new Error("durable recording status did not report the M2 audio contract");
  }

  const started = await call("recording.durable.start", { label: "M2 Audio Replay" });
  const recordingId = started.recordingId;
  const micAudio = Buffer.alloc(9600, 0);
  const systemAudio = Buffer.alloc(4800, 1);

  const mic = await call("recording.durable.writeAudioChunk", {
    recordingId,
    channel: "mic",
    sampleRateHz: 48000,
    channelCount: 1,
    bitsPerSample: 16,
    dataBase64: micAudio.toString("base64"),
  });
  assertCustody(mic, "mic write");
  if (mic?.audioChunkCount !== 1 || mic?.audioDurationMs !== 100) {
    throw new Error("mic audio write did not report a 100 ms audio chunk");
  }

  const system = await call("recording.durable.writeAudioChunk", {
    recordingId,
    channel: "system",
    sampleRateHz: 48000,
    channelCount: 1,
    bitsPerSample: 16,
    dataBase64: systemAudio.toString("base64"),
  });
  assertCustody(system, "system write");
  if (system?.audioChunkCount !== 2 || system?.audioDurationMs !== 150) {
    throw new Error("system audio write did not extend the replay timeline");
  }

  await call("recording.durable.writeTranscriptSegment", {
    recordingId,
    channel: "mic",
    speaker: "Alex",
    text: "Transcript attached to durable local audio.",
    startMs: 20,
    durationMs: 1200,
    confidence: 0.94,
  });
  const finished = await call("recording.durable.finish", { recordingId });
  assertCustody(finished, "finish");

  const replay = await call("recording.durable.replayManifest", { recordingId });
  assertCustody(replay, "replay");
  if (
    replay?.durationMs !== 150 ||
    replay?.audioChunkCount !== 2 ||
    replay?.audioChunks?.[0]?.readMethod !== "recording.durable.readAudioChunk" ||
    replay?.transcriptReadMethod !== "recording.durable.transcript" ||
    !replay?.tracks?.includes("mic") ||
    !replay?.tracks?.includes("system")
  ) {
    throw new Error("replay manifest did not contain the expected local audio timeline");
  }

  const transcript = await call("recording.durable.transcript", { recordingId });
  assertCustody(transcript, "transcript");
  if (
    transcript?.segmentCount !== 1 ||
    transcript?.segments?.[0]?.speaker !== "Alex" ||
    transcript?.segments?.[0]?.startMs !== 20 ||
    transcript?.segments?.[0]?.endMs !== 1220 ||
    transcript?.segments?.[0]?.text !== "Transcript attached to durable local audio."
  ) {
    throw new Error("synced transcript did not return the expected timed segment");
  }

  const read = await call("recording.durable.read", { recordingId });
  assertCustody(read, "read");
  if (read?.chunks?.[0]?.dataBase64 || read?.chunks?.[0]?.readMethod !== "recording.durable.readAudioChunk") {
    throw new Error("recording read exposed inline audio or missed the chunk read method");
  }
  if (read?.chunks?.[2]?.kind !== "transcriptSegment" || read?.chunks?.[2]?.startMs !== 20) {
    throw new Error("recording read did not include the synced transcript segment metadata");
  }

  const search = await call("recording.durable.search", { query: "durable local audio" });
  assertCustody(search, "search");
  if (search?.matchCount !== 1 || !search?.matches?.[0]?.snippet?.includes("durable local audio")) {
    throw new Error("search did not index the synced transcript segment");
  }

  const micRead = await call("recording.durable.readAudioChunk", { recordingId, index: 0 });
  assertCustody(micRead, "audio read");
  if (micRead?.dataBase64 !== micAudio.toString("base64") || micRead?.durationMs !== 100) {
    throw new Error("audio chunk readback did not match the written mic chunk");
  }

  const exported = await call("export.create", { recordingId, format: "markdown" });
  assertCustody(exported, "export");
  if (
    !exported?.markdown?.includes("Local Audio Replay Chunks") ||
    !exported?.markdown?.includes("Transcript attached to durable local audio.")
  ) {
    throw new Error("markdown export did not include transcript and audio replay metadata");
  }

  const wav = await call("export.create", { recordingId, format: "wav", channel: "mic" });
  assertCustody(wav, "wav export");
  const wavBytes = Buffer.from(wav?.dataBase64 ?? "", "base64");
  if (
    wav?.format !== "wav" ||
    wav?.mimeType !== "audio/wav" ||
    wav?.channel !== "mic" ||
    wav?.durationMs !== 100 ||
    wavBytes.subarray(0, 4).toString("ascii") !== "RIFF" ||
    wavBytes.subarray(8, 12).toString("ascii") !== "WAVE"
  ) {
    throw new Error("wav export did not produce a playable pathless WAV payload");
  }

  await expectError(
    "recording.durable.writeAudioChunk",
    {
      recordingId,
      channel: "mic",
      sampleRateHz: 48000,
      channelCount: 1,
      bitsPerSample: 24,
      dataBase64: micAudio.toString("base64"),
    },
    "RECORDING_AUDIO_BITS_INVALID"
  );

  await call("core.shutdown");
  console.log("M2 audio replay smoke passed.");
} finally {
  if (!child.killed) child.kill();
  rmSync(dataDir, { recursive: true, force: true });
}
