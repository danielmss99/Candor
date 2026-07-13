import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CaptureRecoveryStore } from "../core/capture-recovery-store.js";
import { CoreClient } from "../core/core-client.js";

const harnessPath = fileURLToPath(new URL("./controllable-core.mjs", import.meta.url));
const allowedMethods = new Set([
  "core.version",
  "core.status",
  "core.shutdown",
  "capture.status",
  "capture.startMic",
  "capture.stop",
]);
const children = new Set<ChildProcessWithoutNullStreams>();

function spawnHarness(mode: string): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, [harnessPath], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, CANDOR_TEST_CORE_MODE: mode },
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

function clientFor(mode: string, timeoutMs = 2_000): CoreClient {
  return new CoreClient({
    executablePath: () => process.execPath,
    allowedMethods,
    isDev: false,
    spawnCore: () => spawnHarness(mode),
    timeoutMsForTesting: () => timeoutMs,
    maxResponseLineBytesForTesting: mode === "oversized-line" ? 1_024 : undefined,
  });
}

afterEach(() => {
  for (const child of children) child.kill();
  children.clear();
});

describe("controllable core fault harness", () => {
  it.each([
    ["startup-timeout", "timed out"],
    ["malformed-json", "malformed JSON"],
    ["invalid-handshake", "invalid schemaVersion"],
    ["oversized-line", "boundary limit"],
  ])("fails closed in %s mode", async (mode, message) => {
    const client = clientFor(mode, mode.includes("timeout") || mode.includes("hang") ? 200 : 2_000);
    await expect(client.ensureHandshake()).rejects.toThrow(message);
  });

  it("bounds an ordinary request that hangs before responding", async () => {
    const client = clientFor("hang-before-response", 200);
    await client.ensureHandshake();
    await expect(client.call("core.status")).rejects.toThrow("timed out");
  });

  it.each(["duplicate-response", "unknown-request-id"])("rejects %s protocol output", async (mode) => {
    const client = clientFor(mode);
    await client.ensureHandshake();
    if (mode === "unknown-request-id") await expect(client.call("core.status")).rejects.toThrow();
    else await client.call("core.status");
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(client.snapshot()).toMatchObject({ state: "failed" });
  });

  it("rejects invalid method results before renderer delivery", async () => {
    const client = clientFor("invalid-result-schema");
    await expect(client.call("capture.status")).rejects.toMatchObject({ code: "CORE_RESULT_SCHEMA_INVALID" });
  });

  it("stays responsive while bounded stderr is flooded", async () => {
    const client = clientFor("stderr-flood", 500);
    await expect(client.call("core.status")).resolves.toMatchObject({ ok: true });
    await client.shutdown();
  });

  it("persists recovery metadata when the core hangs during capture", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "candor-hung-core-"));
    try {
      const store = new CaptureRecoveryStore(() => root);
      const child = spawnHarness("hang-during-capture");
      const client = new CoreClient({
        executablePath: () => process.execPath,
        allowedMethods,
        isDev: false,
        spawnCore: () => child,
        timeoutMsForTesting: (method) => method === "capture.status" ? 200 : 2_000,
        onCaptureConnectionDegraded: (metadata) => store.persist(metadata),
        onCaptureRecoveryResolved: () => store.clear(),
      });

      await client.call("capture.startMic", { label: "Test recording" });
      await expect(client.call("capture.status")).rejects.toThrow("timed out");
      await client.waitForRecoveryPersistence();

      expect(child.killed).toBe(false);
      expect(client.rendererSnapshot()).toMatchObject({
        state: "capture-connection-degraded",
        captureActive: true,
        captureRecoveryRequired: true,
      });
      const record = await store.read();
      expect(record).toMatchObject({
        recoveryRequired: true,
        recordingId: "recording-test-1",
        rawPathExposed: false,
      });

      const restarted = clientFor("normal");
      restarted.restoreCaptureRecovery({
        at: record?.recordedAt ?? "2026-07-13T12:00:00.000Z",
        method: record?.method ?? "capture.status",
        recordingId: record?.recordingId ?? null,
      });
      expect(restarted.rendererSnapshot()).toMatchObject({ captureRecoveryRequired: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the core and Stop path available when capture start times out", async () => {
    const child = spawnHarness("hang-during-capture-start");
    const client = new CoreClient({
      executablePath: () => process.execPath,
      allowedMethods,
      isDev: false,
      spawnCore: () => child,
      timeoutMsForTesting: (method) => method === "capture.startMic" ? 200 : 2_000,
    });

    await expect(client.call("capture.startMic", { label: "Slow recording" })).rejects.toThrow("timed out");
    expect(child.killed).toBe(false);
    expect(client.rendererSnapshot()).toMatchObject({
      state: "capture-connection-degraded",
      captureActive: true,
      captureRecoveryRequired: true,
    });

    await expect(client.call("capture.stop")).resolves.toMatchObject({ ok: true });
    expect(client.rendererSnapshot()).toMatchObject({
      state: "running",
      captureActive: false,
      captureRecoveryRequired: false,
    });
  });

  it("marks recovery required when the core exits during capture", async () => {
    const client = clientFor("exit-during-capture", 500);
    await client.call("capture.startMic", { label: "Test recording" });
    await expect(client.call("capture.status")).rejects.toThrow("exited");
    expect(client.rendererSnapshot()).toMatchObject({ captureRecoveryRequired: true });

    await client.retryConnection();
    expect(client.rendererSnapshot()).toMatchObject({
      state: "running",
      captureActive: false,
      captureRecoveryRequired: true,
    });
  });
});
