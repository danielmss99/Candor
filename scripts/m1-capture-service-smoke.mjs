import { createVersionedCoreRequest } from "./core-rpc-envelope.mjs";
import { removeTemporaryDirectory, stopChildProcess } from "./child-process-cleanup.mjs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const exe = process.platform === "win32" ? "candor-core.exe" : "candor-core";
const corePath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(repoRoot, "crates", "candor-core", "target", "debug", exe);
const outputPath = path.resolve(
  repoRoot,
  process.argv.includes("--write") && process.argv[process.argv.indexOf("--write") + 1]
    ? process.argv[process.argv.indexOf("--write") + 1]
    : path.join("release-v3", "proofs", `m1-capture-service-smoke-${process.platform}-${process.arch}.json`),
);

if (!existsSync(corePath)) {
  throw new Error(`candor-core debug binary not found: ${corePath}`);
}

const dataDir = mkdtempSync(path.join(tmpdir(), "candor-v3-m1-capture-"));
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
  const request = createVersionedCoreRequest(method, params);
  const id = request.requestId;
  const payload = JSON.stringify(request);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for ${method}`));
    }, 8000);
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function writeProof(value) {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function realBranch(requested, skippedReason) {
  return {
    requested,
    attempted: false,
    ok: null,
    skippedReason: requested ? null : skippedReason,
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

const proof = {
  ok: false,
  proofKind: "m1-capture-service-smoke",
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  localOnly: true,
  cloudAi: false,
  synthetic: {
    statusChecked: false,
    devicesChecked: false,
    separatedChunks: false,
    serializedWriter: false,
    callbackIntegrityPolicy: false,
  },
  realDevice: {
    mic: realBranch(
      process.env.CANDOR_CAPTURE_REAL_DEVICE === "1",
      "set CANDOR_CAPTURE_REAL_DEVICE=1 to attempt real microphone capture",
    ),
    system: realBranch(
      process.env.CANDOR_CAPTURE_REAL_SYSTEM === "1",
      "set CANDOR_CAPTURE_REAL_SYSTEM=1 to attempt real system-audio capture on this machine",
    ),
    combined: realBranch(
      process.env.CANDOR_CAPTURE_REAL_BOTH === "1",
      "set CANDOR_CAPTURE_REAL_BOTH=1 to attempt real separated mic plus system capture on this machine",
    ),
  },
  realCaptureDuration: {
    env: "CANDOR_M1_REAL_CAPTURE_DURATION_MS",
    requestedMs: realDurationMs,
    defaultMs: realCaptureDurationBoundsMs.default,
    boundsMs: {
      min: realCaptureDurationBoundsMs.min,
      max: realCaptureDurationBoundsMs.max,
    },
  },
  pendingAdapters: {
    macosSystemAudio: false,
  },
  rawPathExposed: false,
  keyMaterialExposedToRenderer: false,
};

try {
  const status = await call("capture.status");
  assertCustody(status, "capture status");
  if (status?.implemented !== true || status?.sources?.mic?.implemented !== true) {
    throw new Error("capture status did not report implemented mic capture service");
  }
  const integrityPolicy = status?.integrityPolicy;
  if (
    integrityPolicy?.callbackQueueCapacity !== 32 ||
    integrityPolicy?.callbackOverflow !== "fail-capture-session" ||
    integrityPolicy?.runtimeStreamErrors !== "propagate-to-session" ||
    integrityPolicy?.silentCallbackDropsAllowed !== false ||
    integrityPolicy?.flushBufferedAudioOnStop !== true ||
    status?.sources?.mic?.integrityPolicy?.silentCallbackDropsAllowed !== false ||
    status?.sources?.system?.integrityPolicy?.silentCallbackDropsAllowed !== false
  ) {
    throw new Error("capture status did not report fail-closed callback integrity policy");
  }
  proof.synthetic.callbackIntegrityPolicy = true;
  if (process.platform === "win32") {
    if (
      status?.sources?.system?.implemented !== true ||
      status?.sources?.system?.backend !== "cpal-wasapi-loopback" ||
      status?.sources?.system?.durableChannel !== "system" ||
      status?.sources?.system?.simultaneousMicAndSystem !== true ||
      status?.sources?.system?.simultaneousMethod !== "capture.startMicAndSystem" ||
      status?.sources?.system?.serializedWriter !== true
    ) {
      throw new Error("Windows capture status did not report implemented WASAPI loopback system and combined capture");
    }
  } else if (process.platform === "linux") {
    if (
      status?.sources?.system?.implemented !== true ||
      status?.sources?.system?.backend !== "cpal-linux-monitor-input" ||
      status?.sources?.system?.durableChannel !== "system" ||
      status?.sources?.system?.simultaneousMicAndSystem !== true ||
      status?.sources?.system?.simultaneousMethod !== "capture.startMicAndSystem" ||
      status?.sources?.system?.serializedWriter !== true ||
      !status?.sources?.system?.plannedAdapters?.includes("pipewire-monitor-input") ||
      !status?.sources?.system?.plannedAdapters?.includes("pulseaudio-monitor-input")
    ) {
      throw new Error("Linux capture status did not report implemented monitor-input system and combined capture");
    }
  } else if (process.platform === "darwin") {
    if (
      status?.sources?.system?.implemented !== true ||
      status?.sources?.system?.backend !== "screencapturekit-system-audio" ||
      status?.sources?.system?.durableChannel !== "system" ||
      status?.sources?.system?.simultaneousMicAndSystem !== true ||
      status?.sources?.system?.simultaneousMethod !== "capture.startMicAndSystem" ||
      status?.sources?.system?.serializedWriter !== true ||
      status?.sources?.system?.requiresOsPermission !== true ||
      status?.sources?.system?.minimumSystemVersion !== "13.0" ||
      status?.sources?.system?.availabilityProbe !== "tcc-gated-at-capture-start" ||
      !status?.sources?.system?.adapters?.includes("screencapturekit-system-audio")
    ) {
      throw new Error("macOS capture status did not report implemented ScreenCaptureKit system and combined capture");
    }
  } else if (status?.sources?.system?.implemented !== false) {
    throw new Error("system capture must remain explicitly pending until the OS adapter lands");
  } else if (status?.sources?.system?.simultaneousMicAndSystem !== false) {
    throw new Error("combined mic and system capture must remain explicitly pending on unsupported platforms");
  }
  proof.synthetic.statusChecked = true;
  proof.statusSummary = {
    micImplemented: status?.sources?.mic?.implemented === true,
    systemImplemented: status?.sources?.system?.implemented === true,
    systemBackend: status?.sources?.system?.backend ?? null,
    simultaneousMicAndSystem: status?.sources?.system?.simultaneousMicAndSystem === true,
    defaultInputAvailable: status?.defaultInputAvailable === true,
    defaultOutputAvailable: status?.defaultOutputAvailable === true,
    defaultSystemDeviceAvailable: status?.sources?.system?.defaultSystemDeviceAvailable === true,
    systemAvailabilityProbe: status?.sources?.system?.availabilityProbe ?? null,
    systemRequiresOsPermission: status?.sources?.system?.requiresOsPermission === true,
    callbackOverflowPolicy: integrityPolicy.callbackOverflow,
    runtimeStreamErrorPolicy: integrityPolicy.runtimeStreamErrors,
    silentCallbackDropsAllowed: integrityPolicy.silentCallbackDropsAllowed,
    rawPathExposed: false,
  };

  const devices = await call("capture.devices");
  assertCustody(devices, "capture devices");
  if (!Array.isArray(devices?.inputs) || !Array.isArray(devices?.outputs) || !Array.isArray(devices?.devices)) {
    throw new Error("capture devices did not return input and output device arrays");
  }
  proof.synthetic.devicesChecked = true;
  proof.deviceSummary = {
    inputCount: devices.inputs.length,
    outputCount: devices.outputs.length,
    rawPathExposed: false,
  };

  const syntheticProof = await call("capture.proofSynthetic");
  assertCustody(syntheticProof, "capture synthetic proof");
  if (
    syntheticProof?.proof?.synthetic !== true ||
    syntheticProof?.proof?.micSystemSeparated !== true ||
    syntheticProof?.replay?.audioChunkCount !== 2 ||
    syntheticProof?.replay?.durationMs !== 200 ||
    !syntheticProof?.replay?.tracks?.includes("mic") ||
    !syntheticProof?.replay?.tracks?.includes("system")
  ) {
    throw new Error("synthetic capture proof did not create separated durable audio chunks");
  }
  proof.synthetic.separatedChunks = true;

  const serializedProof = await call("capture.proofSerializedWriter");
  assertCustody(serializedProof, "capture serialized writer proof");
  if (
    serializedProof?.proof?.synthetic !== true ||
    serializedProof?.proof?.serializedWriter !== true ||
    serializedProof?.proof?.concurrentProducers !== 2 ||
    serializedProof?.proof?.chunksPerProducer !== 6 ||
    serializedProof?.proof?.micSystemSeparated !== true ||
    serializedProof?.replay?.audioChunkCount !== 12 ||
    serializedProof?.replay?.durationMs !== 600 ||
    !serializedProof?.replay?.tracks?.includes("mic") ||
    !serializedProof?.replay?.tracks?.includes("system")
  ) {
    throw new Error("serialized writer proof did not preserve separated durable tracks");
  }
  proof.synthetic.serializedWriter = true;

  if (process.env.CANDOR_CAPTURE_REAL_DEVICE === "1") {
    proof.realDevice.mic.attempted = true;
    if (status?.defaultInputAvailable !== true) {
      throw new Error("CANDOR_CAPTURE_REAL_DEVICE=1 but no default input device is available");
    }
    const consent = await call("consent.acknowledge", {
      items: ["localOnlyStorage", "micRecording"],
    });
    assertCustody(consent, "real capture consent");
    if (consent?.readyForMicRecording !== true) {
      throw new Error("real mic capture consent did not unlock mic recording");
    }
    const started = await call("capture.startMic", {
      label: "real mic capture smoke",
      chunkMs: 250,
    });
    assertCustody(started, "real capture start");
    const captureStartedAt = Date.now();
    const timerProbeDelayMs = Math.min(
      500,
      Math.max(250, Math.floor(realDurationMs / 2)),
    );
    await sleep(timerProbeDelayMs);
    const activeStatus = await call("capture.status");
    assertCustody(activeStatus, "active real capture status");
    const activeDurationMs = activeStatus?.activeSession?.durationMs;
    if (
      activeStatus?.activeSession?.recordingId !== started?.capture?.recordingId ||
      !Number.isSafeInteger(activeDurationMs) ||
      activeDurationMs <= 0
    ) {
      throw new Error("real mic capture status did not report an increasing elapsed duration");
    }
    await sleep(Math.max(0, realDurationMs - timerProbeDelayMs));
    const stopped = await call("capture.stop");
    const captureStoppedAt = Date.now();
    assertCustody(stopped, "real capture stop");
    if (!(stopped?.recording?.audioChunkCount > 0)) {
      throw new Error("real mic capture did not write any durable audio chunks");
    }
    proof.realDevice.mic.ok = true;
    proof.realDevice.mic.durationMsRequested = realDurationMs;
    proof.realDevice.mic.durationMsActual = captureStoppedAt - captureStartedAt;
    proof.realDevice.mic.timerDurationMs = activeDurationMs;
    proof.realDevice.mic.audioChunkCount = stopped.recording.audioChunkCount;
    proof.realDevice.mic.recordingState = stopped.recording.state;
  }

  if (process.env.CANDOR_CAPTURE_REAL_SYSTEM === "1") {
    proof.realDevice.system.attempted = true;
    if (process.platform !== "win32" && process.platform !== "linux") {
      throw new Error("CANDOR_CAPTURE_REAL_SYSTEM=1 is implemented for Windows and Linux monitor-input capture");
    }
    if (
      process.platform === "win32" &&
      status?.sources?.system?.defaultOutputAvailable !== true
    ) {
      throw new Error("CANDOR_CAPTURE_REAL_SYSTEM=1 but no default output device is available");
    }
    if (
      process.platform === "linux" &&
      status?.sources?.system?.defaultSystemDeviceAvailable !== true
    ) {
      throw new Error("CANDOR_CAPTURE_REAL_SYSTEM=1 but no PipeWire or PulseAudio monitor input is available");
    }
    const consent = await call("consent.acknowledge", {
      items: ["localOnlyStorage", "systemAudioRecording"],
    });
    assertCustody(consent, "real system capture consent");
    if (consent?.readyForSystemAudioRecording !== true) {
      throw new Error("system audio consent did not unlock system recording");
    }
    const started = await call("capture.startSystem", {
      label: "real system capture smoke",
      chunkMs: 250,
    });
    assertCustody(started, "real system capture start");
    if (started?.capture?.source !== "system") {
      throw new Error("real system capture did not report system source");
    }
    const captureStartedAt = Date.now();
    await sleep(realDurationMs);
    const stopped = await call("capture.stop");
    const captureStoppedAt = Date.now();
    assertCustody(stopped, "real system capture stop");
    if (!(stopped?.recording?.audioChunkCount > 0)) {
      throw new Error("real system capture did not write any durable audio chunks");
    }
    proof.realDevice.system.ok = true;
    proof.realDevice.system.durationMsRequested = realDurationMs;
    proof.realDevice.system.durationMsActual = captureStoppedAt - captureStartedAt;
    proof.realDevice.system.audioChunkCount = stopped.recording.audioChunkCount;
    proof.realDevice.system.recordingState = stopped.recording.state;
  }

  if (process.env.CANDOR_CAPTURE_REAL_BOTH === "1") {
    proof.realDevice.combined.attempted = true;
    if (process.platform !== "win32" && process.platform !== "linux") {
      throw new Error("CANDOR_CAPTURE_REAL_BOTH=1 is implemented for Windows and Linux monitor-input capture");
    }
    if (status?.defaultInputAvailable !== true) {
      throw new Error("CANDOR_CAPTURE_REAL_BOTH=1 requires a default input device");
    }
    if (
      process.platform === "win32" &&
      status?.sources?.system?.defaultOutputAvailable !== true
    ) {
      throw new Error("CANDOR_CAPTURE_REAL_BOTH=1 requires a default output device");
    }
    if (
      process.platform === "linux" &&
      status?.sources?.system?.defaultSystemDeviceAvailable !== true
    ) {
      throw new Error("CANDOR_CAPTURE_REAL_BOTH=1 requires a PipeWire or PulseAudio monitor input");
    }
    const consentStatus = await call("consent.status");
    const required = Array.isArray(consentStatus?.requiredForMicAndSystemAudio)
      ? consentStatus.requiredForMicAndSystemAudio
      : ["localOnlyStorage", "micRecording", "systemAudioRecording"];
    const consent = await call("consent.acknowledge", { items: required });
    assertCustody(consent, "combined capture consent");
    if (consent?.readyForMicAndSystemAudioRecording !== true) {
      throw new Error("combined capture consent did not unlock mic and system recording");
    }
    const started = await call("capture.startMicAndSystem", {
      label: "real combined capture smoke",
      chunkMs: 250,
    });
    assertCustody(started, "real combined capture start");
    if (
      started?.capture?.source !== "mic+system" ||
      started?.capture?.mode !== "separated" ||
      started?.capture?.serializedWriter !== true ||
      !started?.capture?.tracks?.includes("mic") ||
      !started?.capture?.tracks?.includes("system")
    ) {
      throw new Error("real combined capture did not report separated mic and system tracks");
    }
    const captureStartedAt = Date.now();
    await sleep(realDurationMs);
    const stopped = await call("capture.stop");
    const captureStoppedAt = Date.now();
    assertCustody(stopped, "real combined capture stop");
    if (!(stopped?.recording?.audioChunkCount > 0)) {
      throw new Error("real combined capture did not write any durable audio chunks");
    }
    const replay = await call("recording.durable.replayManifest", {
      recordingId: stopped?.capture?.recordingId,
    });
    assertCustody(replay, "real combined capture replay");
    if (!replay?.tracks?.includes("mic") || !replay?.tracks?.includes("system")) {
      throw new Error("real combined capture replay did not preserve separated tracks");
    }
    proof.realDevice.combined.ok = true;
    proof.realDevice.combined.durationMsRequested = realDurationMs;
    proof.realDevice.combined.durationMsActual = captureStoppedAt - captureStartedAt;
    proof.realDevice.combined.audioChunkCount = stopped.recording.audioChunkCount;
    proof.realDevice.combined.recordingState = stopped.recording.state;
    proof.realDevice.combined.tracks = replay.tracks;
  }

  await call("core.shutdown");
  proof.ok = true;
  proof.finishedAt = new Date().toISOString();
  writeProof(proof);
  console.log("M1 capture service smoke passed.");
  console.log(`M1 capture service proof written to ${outputPath}.`);
} catch (error) {
  proof.ok = false;
  proof.finishedAt = new Date().toISOString();
  proof.error = {
    message: error instanceof Error ? error.message : String(error),
    code: error?.code ?? null,
  };
  writeProof(proof);
  throw error;
} finally {
  lines.close();
  if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
  await stopChildProcess(child);
  removeTemporaryDirectory(dataDir);
}
