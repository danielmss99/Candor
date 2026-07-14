import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it } from "vitest";
import { CoreClient } from "./core-client.js";
import { CORE_PROTOCOL_VERSION } from "./protocol.js";

const allowedMethods = new Set([
  "core.version",
  "core.status",
  "core.shutdown",
  "capture.status",
  "capture.startMic",
  "capture.stop",
]);

function spawnNode(script: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ["-e", script], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

function responsiveCore(active = false): string {
  return `
    const readline = require("node:readline");
    const protocolVersion = ${JSON.stringify(CORE_PROTOCOL_VERSION)};
    let captureActive = ${String(active)};
    let handshakeCount = 0;
    const input = readline.createInterface({ input: process.stdin });
    input.on("line", (line) => {
      const request = JSON.parse(line);
      let result = {
        version: "test",
        protocolVersion,
        uptimeMs: 1,
        networkPolicy: "disabled-by-default",
        updaterPolicy: "manual-check-only",
        vaultState: "test",
        sidecarTransport: "stdio-json-lines",
        startupRecovery: {},
        handshakeCount
      };
      if (request.method === "core.version") result = {
        version: "test",
        protocolVersion,
        schemaVersion: 1,
        capabilities: ["stdio-json-lines"],
        build: { target: "test-target", features: [] }
      };
      if (request.method === "core.version") handshakeCount += 1;
      if (request.method === "capture.status") result = { implemented: true, active: captureActive, activeSession: captureActive ? { recordingId: "recording-1" } : null, sources: {}, rawPathExposed: false };
      if (request.method === "capture.startMic") {
        captureActive = true;
        result = {
          recording: { recordingId: "recording-1", state: "recording" },
          capture: { recordingId: "recording-1" },
          rawPathExposed: false
        };
      }
      if (request.method === "capture.stop") {
        captureActive = false;
        result = {
          recording: { recordingId: "recording-1", state: "finished" },
          capture: { recordingId: "recording-1", integrityStatus: "verified" },
          rawPathExposed: false
        };
      }
      if (request.method === "core.shutdown") result = { shutdown: true };
      process.stdout.write(JSON.stringify({ id: request.id, requestId: request.requestId, protocolVersion, ok: true, result }) + "\\n");
      if (request.method === "core.shutdown") setTimeout(() => process.exit(0), 5);
    });
  `;
}

function capturingThenSilentCore(): string {
  return `
    const readline = require("node:readline");
    const protocolVersion = ${JSON.stringify(CORE_PROTOCOL_VERSION)};
    const input = readline.createInterface({ input: process.stdin });
    input.on("line", (line) => {
      const request = JSON.parse(line);
      let result = null;
      if (request.method === "core.version") result = {
        version: "test",
        protocolVersion,
        schemaVersion: 1,
        capabilities: ["stdio-json-lines"],
        build: { target: "test-target", features: [] }
      };
      if (request.method === "capture.status") result = { implemented: true, active: true, activeSession: { recordingId: "recording-1" }, sources: {}, rawPathExposed: false };
      if (result !== null) {
        process.stdout.write(JSON.stringify({ id: request.id, requestId: request.requestId, protocolVersion, ok: true, result }) + "\\n");
      }
    });
  `;
}

function capturingCoreWithHungStatus(): string {
  return `
    const readline = require("node:readline");
    const protocolVersion = ${JSON.stringify(CORE_PROTOCOL_VERSION)};
    let active = true;
    const input = readline.createInterface({ input: process.stdin });
    input.on("line", (line) => {
      const request = JSON.parse(line);
      let result = null;
      if (request.method === "core.version") result = {
        version: "test",
        protocolVersion,
        schemaVersion: 1,
        capabilities: ["stdio-json-lines"],
        build: { target: "test-target", features: [] }
      };
      if (request.method === "capture.status") result = {
        implemented: true,
        active,
        activeSession: active ? { recordingId: "recording-1" } : null,
        sources: {},
        rawPathExposed: false
      };
      if (request.method === "capture.stop") {
        active = false;
        result = {
          recording: { recordingId: "recording-1", state: "finished" },
          capture: { recordingId: "recording-1", integrityStatus: "verified" },
          rawPathExposed: false
        };
      }
      if (request.method === "core.shutdown") result = { shutdown: true };
      if (result !== null) {
        process.stdout.write(JSON.stringify({ id: request.id, requestId: request.requestId, protocolVersion, ok: true, result }) + "\\n");
      }
      if (request.method === "core.shutdown") setTimeout(() => process.exit(0), 5);
    });
  `;
}

const settle = (milliseconds = 20) => new Promise((resolve) => setTimeout(resolve, milliseconds));

describe("core client process boundary", () => {
  it("passes the trusted packaged AI root only through the main-process spawn environment", async () => {
    let spawnedEnvironment: NodeJS.ProcessEnv | undefined;
    const client = new CoreClient({
      executablePath: () => process.execPath,
      allowedMethods,
      isDev: false,
      environment: () => ({
        CANDOR_AI_BUNDLE_ROOT: "C:\\Program Files\\Candor\\resources\\ai",
        CANDOR_CORE_TRANSPORT: "untrusted-override",
      }),
      spawnCore: (_executable, environment) => {
        spawnedEnvironment = environment;
        return spawnNode(responsiveCore());
      },
    });

    await client.call("core.status");
    expect(spawnedEnvironment?.CANDOR_AI_BUNDLE_ROOT).toBe("C:\\Program Files\\Candor\\resources\\ai");
    expect(spawnedEnvironment?.CANDOR_CORE_TRANSPORT).toBe("stdio-json-lines");
    await client.shutdown();
  });

  it("handshakes and correlates UUID requests over JSONL stdio", async () => {
    const client = new CoreClient({
      executablePath: () => process.execPath,
      allowedMethods,
      isDev: false,
      spawnCore: () => spawnNode(responsiveCore()),
    });

    const response = await client.call("core.status");
    expect(response.ok).toBe(true);
    expect(response.result).toMatchObject({ protocolVersion: CORE_PROTOCOL_VERSION, handshakeCount: 1 });
    expect(client.snapshot()).toMatchObject({ state: "running", lastHandshake: { ok: true } });
    await client.shutdown();
  });

  it("fails closed on malformed core output", async () => {
    const client = new CoreClient({
      executablePath: () => process.execPath,
      allowedMethods,
      isDev: false,
      spawnCore: () => spawnNode('process.stdout.write("not-json\\n"); setInterval(() => {}, 1000);'),
    });

    await expect(client.ensureHandshake()).rejects.toThrow("malformed JSON");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(client.snapshot()).toMatchObject({ state: "failed" });
  });

  it("does not restart a core while capture is active", async () => {
    const child = spawnNode(responsiveCore(true));
    const client = new CoreClient({
      executablePath: () => process.execPath,
      allowedMethods,
      isDev: false,
      spawnCore: () => child,
    });

    await client.ensureHandshake();
    await expect(client.exerciseRestartForSmoke()).rejects.toThrow("restart is denied while capture is active");
    expect(client.snapshot()).toMatchObject({ state: "running", captureActive: true, restartCount: 0 });
    await expect(client.shutdown()).rejects.toMatchObject({ code: "CORE_CAPTURE_ACTIVE" });
    child.kill();
  });

  it("bounds a hung request and transitions to a failed supervisor state", async () => {
    const client = new CoreClient({
      executablePath: () => process.execPath,
      allowedMethods,
      isDev: false,
      spawnCore: () => spawnNode("process.stdin.resume(); setInterval(() => {}, 1000);"),
      timeoutMsForTesting: () => 25,
    });

    await expect(client.call("core.status")).rejects.toThrow("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(client.snapshot()).toMatchObject({ state: "failed" });
  });

  it("enters a degraded capture state without killing the active core", async () => {
    const child = spawnNode(capturingThenSilentCore());
    const degraded: Array<{ method: string; recordingId: string | null }> = [];
    const client = new CoreClient({
      executablePath: () => process.execPath,
      allowedMethods,
      isDev: false,
      spawnCore: () => child,
      timeoutMsForTesting: (method, configured) => method === "core.status" ? 25 : configured,
      onCaptureConnectionDegraded: (metadata) => {
        degraded.push(metadata);
      },
    });

    await client.ensureHandshake();
    await client.call("capture.status");
    await expect(client.call("core.status")).rejects.toThrow("timed out");
    await settle();
    expect(client.snapshot()).toMatchObject({
      state: "capture-connection-degraded",
      captureActive: true,
      captureRecoveryRequired: true,
    });
    expect(degraded).toHaveLength(1);
    expect(degraded[0]).toMatchObject({ method: "core.status", recordingId: "recording-1" });
    expect(child.killed).toBe(false);
    child.kill();
  });

  it("reconnects or stops from the degraded capture state", async () => {
    const child = spawnNode(capturingCoreWithHungStatus());
    const client = new CoreClient({
      executablePath: () => process.execPath,
      allowedMethods,
      isDev: false,
      spawnCore: () => child,
      timeoutMsForTesting: (method, configured) => method === "core.status" ? 25 : configured,
    });

    await client.call("capture.status");
    await expect(client.call("core.status")).rejects.toThrow("timed out");
    expect(client.snapshot()).toMatchObject({ state: "capture-connection-degraded", captureActive: true });
    await client.retryConnection();
    expect(client.snapshot()).toMatchObject({ state: "running", captureActive: true });
    await client.finalizeCaptureForClose();
    expect(client.captureGuardPhase()).toBe("idle");
    await client.shutdown();
  });

  it("clears stale capture state when the core process exits", async () => {
    const child = spawnNode(responsiveCore(true));
    const degraded: Array<{ method: string; recordingId: string | null }> = [];
    const client = new CoreClient({
      executablePath: () => process.execPath,
      allowedMethods,
      isDev: false,
      spawnCore: () => child,
      onCaptureConnectionDegraded: (metadata) => {
        degraded.push(metadata);
      },
    });

    await client.ensureHandshake();
    await client.call("capture.status");
    expect(client.snapshot()).toMatchObject({ captureActive: true });
    child.kill();
    await settle();
    expect(client.snapshot()).toMatchObject({ captureActive: false, captureRecoveryRequired: true });
    expect(degraded).toEqual([expect.objectContaining({ method: "core.processExit" })]);
  });

  it("hydrates recovery metadata before starting a replacement core", () => {
    const client = new CoreClient({
      executablePath: () => process.execPath,
      allowedMethods,
      isDev: false,
      spawnCore: () => spawnNode(responsiveCore()),
    });

    client.restoreCaptureRecovery({
      at: "2026-07-13T12:00:00.000Z",
      method: "capture.stop",
      recordingId: "recording-1",
    });

    expect(client.rendererSnapshot()).toMatchObject({
      state: "capture-connection-degraded",
      captureRecoveryRequired: true,
      degradedCapture: { method: "capture.stop", recordingId: "recording-1" },
    });
  });

  it("records a safe failed state when process spawn throws synchronously", async () => {
    for (const executablePath of ["C:\\private\\missing-core.exe", "/private/missing-core.exe"]) {
      const client = new CoreClient({
        executablePath: () => executablePath,
        allowedMethods,
        isDev: false,
        spawnCore: () => { throw new Error(`${executablePath} is missing`); },
      });

      await expect(client.call("core.status")).rejects.toMatchObject({ code: "CORE_UNAVAILABLE" });
      expect(client.snapshot()).toMatchObject({ state: "failed", restartCount: 0 });
      expect(client.rendererSnapshot()).toMatchObject({ executableName: "missing-core.exe", rawPathExposed: false });
      expect(JSON.stringify(client.rendererSnapshot())).not.toContain("private");
    }
  });

  it("finalizes an active capture before allowing shutdown", async () => {
    const client = new CoreClient({
      executablePath: () => process.execPath,
      allowedMethods,
      isDev: false,
      spawnCore: () => spawnNode(responsiveCore(true)),
    });

    await client.ensureHandshake();
    await client.call("capture.status");
    expect(client.captureGuardPhase()).toBe("recording");
    await client.finalizeCaptureForClose();
    expect(client.captureGuardPhase()).toBe("idle");
    await client.shutdown();
    expect(client.snapshot()).toMatchObject({ state: "stopped", captureActive: false });
  });

  it("shares one handshake across concurrent initial calls", async () => {
    const client = new CoreClient({
      executablePath: () => process.execPath,
      allowedMethods,
      isDev: false,
      spawnCore: () => spawnNode(responsiveCore()),
    });

    const [first, second] = await Promise.all([
      client.call("core.status"),
      client.call("core.status"),
    ]);
    expect(first.result).toMatchObject({ handshakeCount: 1 });
    expect(second.result).toMatchObject({ handshakeCount: 1 });
    await client.shutdown();
  });

  it("rejects a malformed successful result before delivery", async () => {
    const script = responsiveCore().replace(
      'if (request.method === "capture.status") result = { implemented: true, active: captureActive, activeSession: captureActive ? { recordingId: "recording-1" } : null, sources: {}, rawPathExposed: false };',
      'if (request.method === "capture.status") result = { active: "yes" };',
    );
    const client = new CoreClient({
      executablePath: () => process.execPath,
      allowedMethods,
      isDev: false,
      spawnCore: () => spawnNode(script),
    });

    await expect(client.call("capture.status")).rejects.toMatchObject({ code: "CORE_RESULT_SCHEMA_INVALID" });
    await settle();
    expect(client.snapshot()).toMatchObject({ state: "failed" });
  });

  it("delivers validated job events independently from request responses", async () => {
    const script = responsiveCore().replace(
      'if (request.method === "core.shutdown") result = { shutdown: true };',
      `if (request.method === "core.status") {
        process.stdout.write(JSON.stringify({
          protocolVersion,
          event: "jobs.changed",
          payload: {
            jobId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            type: "export",
            state: "running",
            terminal: false,
            rawPathExposed: false
          }
        }) + "\\n");
      }
      if (request.method === "core.shutdown") result = { shutdown: true };`,
    );
    const client = new CoreClient({
      executablePath: () => process.execPath,
      allowedMethods,
      isDev: false,
      spawnCore: () => spawnNode(script),
    });
    const events: string[] = [];
    const unsubscribe = client.subscribe((event) => events.push(event.event));

    await client.call("core.status");
    expect(events).toEqual(["jobs.changed"]);
    unsubscribe();
    await client.shutdown();
  });
});
