import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it } from "vitest";
import { CoreClient } from "./core-client.js";
import { CORE_PROTOCOL_VERSION } from "./protocol.js";

const allowedMethods = new Set(["core.version", "core.status", "core.shutdown", "capture.status"]);

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
    const input = readline.createInterface({ input: process.stdin });
    input.on("line", (line) => {
      const request = JSON.parse(line);
      let result = { ready: true, receivedRequestId: request.requestId, idsMatch: request.id === request.requestId };
      if (request.method === "core.version") result = {
        version: "test",
        protocolVersion,
        schemaVersion: 1,
        capabilities: ["stdio-json-lines"],
        build: { target: "test-target", features: [] }
      };
      if (request.method === "capture.status") result = { active: ${String(active)}, rawPathExposed: false };
      process.stdout.write(JSON.stringify({ id: request.id, requestId: request.requestId, protocolVersion, ok: true, result }) + "\\n");
      if (request.method === "core.shutdown") setTimeout(() => process.exit(0), 5);
    });
  `;
}

describe("core client process boundary", () => {
  it("handshakes and correlates UUID requests over JSONL stdio", async () => {
    const client = new CoreClient({
      executablePath: () => process.execPath,
      allowedMethods,
      isDev: false,
      spawnCore: () => spawnNode(responsiveCore()),
    });

    await client.ensureHandshake();
    const response = await client.call("core.status");
    expect(response.ok).toBe(true);
    expect(response.result).toMatchObject({ ready: true, idsMatch: true });
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
    const client = new CoreClient({
      executablePath: () => process.execPath,
      allowedMethods,
      isDev: false,
      spawnCore: () => spawnNode(responsiveCore(true)),
    });

    await client.ensureHandshake();
    await expect(client.exerciseRestartForSmoke()).rejects.toThrow("restart is denied while capture is active");
    expect(client.snapshot()).toMatchObject({ state: "running", captureActive: true, restartCount: 0 });
    await client.shutdown();
  });

  it("bounds a hung request and transitions to a failed supervisor state", async () => {
    const client = new CoreClient({
      executablePath: () => process.execPath,
      allowedMethods,
      isDev: false,
      spawnCore: () => spawnNode("process.stdin.resume(); setInterval(() => {}, 1000);"),
    });

    await expect(client.call("core.status", null, 25)).rejects.toThrow("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(client.snapshot()).toMatchObject({ state: "failed" });
  });
});
