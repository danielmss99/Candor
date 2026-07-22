import readline from "node:readline";

const protocolVersion = "m0-jsonrpc-stdio-1";
const mode = process.env.CANDOR_TEST_CORE_MODE ?? "normal";
let captureActive = false;
let captureStartedAtMs = null;
let responseCount = 0;

function send(request, result, requestId = request.requestId) {
  const response = {
    id: requestId,
    requestId,
    protocolVersion,
    ok: true,
    result,
  };
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

function handshake() {
  return {
    version: "test-core",
    protocolVersion,
    schemaVersion: 1,
    capabilities: ["stdio-json-lines", "durable-recording"],
    build: { target: "test-target", features: [] },
  };
}

function resultFor(request) {
  switch (request.method) {
    case "core.version":
      return handshake();
    case "core.status":
      return {
        version: "test-core",
        protocolVersion,
        uptimeMs: 1,
        networkPolicy: "disabled-by-default",
        updaterPolicy: "manual-check-only",
        vaultState: "test",
        sidecarTransport: "stdio-json-lines",
        startupRecovery: {},
      };
    case "capture.status":
      return {
        implemented: true,
        active: captureActive,
        activeSession: captureActive ? {
          recordingId: "recording-test-1",
          durationMs: Math.max(0, Date.now() - captureStartedAtMs),
        } : null,
        sources: {},
        rawPathExposed: false,
        keyMaterialExposedToRenderer: false,
      };
    case "capture.startMic":
      captureActive = true;
      captureStartedAtMs = Date.now();
      return {
        recording: { recordingId: "recording-test-1", state: "recording" },
        capture: { recordingId: "recording-test-1" },
        rawPathExposed: false,
      };
    case "capture.stop":
      captureActive = false;
      captureStartedAtMs = null;
      return {
        recording: { recordingId: "recording-test-1", state: "finished" },
        capture: { recordingId: "recording-test-1", integrityStatus: "verified" },
        rawPathExposed: false,
      };
    case "core.shutdown":
      return { shutdown: true };
    default:
      return { rawPathExposed: false };
  }
}

if (mode === "startup-timeout") {
  process.stdin.resume();
} else if (mode === "malformed-json") {
  process.stdout.write("not-json\n");
  process.stdin.resume();
} else if (mode === "oversized-line") {
  process.stdout.write(`${"x".repeat(2 * 1024)}\n`);
  process.stdin.resume();
} else {
  const input = readline.createInterface({ input: process.stdin });
  input.on("line", (line) => {
    const request = JSON.parse(line);
    responseCount += 1;

    if (mode === "hang-before-response" && request.method !== "core.version") return;
    if (mode === "hang-during-capture-start" && request.method === "capture.startMic") {
      captureActive = true;
      return;
    }
    if (mode === "hang-during-capture" && captureActive && request.method !== "core.version") return;
    if (mode === "exit-during-capture" && captureActive && request.method !== "core.version") {
      process.exit(17);
    }
    if (mode === "invalid-handshake" && request.method === "core.version") {
      send(request, { version: "test-core", protocolVersion: "wrong" });
      return;
    }
    if (mode === "unknown-request-id" && request.method !== "core.version") {
      send(request, resultFor(request), "00000000-0000-4000-8000-000000000000");
      return;
    }
    if (mode === "invalid-result-schema" && request.method === "capture.status") {
      send(request, { active: "yes", rawPathExposed: false });
      return;
    }
    if (mode === "stderr-flood" && responseCount === 1) {
      process.stderr.write("diagnostic".repeat(16 * 1024));
    }

    const result = resultFor(request);
    send(request, result);
    if (mode === "duplicate-response" && request.method !== "core.version") send(request, result);
    if (request.method === "core.shutdown") setTimeout(() => process.exit(0), 5);
  });
}
