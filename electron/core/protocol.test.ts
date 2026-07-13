import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CORE_PROTOCOL_VERSION,
  createCoreRequest,
  parseCoreHandshake,
  parseCoreEventLine,
  parseCoreResponseLine,
  privateCoreMethods,
  rendererCoreMethods,
  rendererCoreOperations,
} from "./protocol.js";

describe("core protocol", () => {
  it("creates a versioned request with a UUID correlation id", () => {
    const request = createCoreRequest("core.status", null);
    expect(request.protocolVersion).toBe(CORE_PROTOCOL_VERSION);
    expect(request.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(request.id).toBe(request.requestId);
    expect(Date.parse(request.sentAt)).not.toBeNaN();
  });

  it("validates success and failure envelopes", () => {
    expect(
      parseCoreResponseLine(
        JSON.stringify({ id: "request-1", requestId: "request-1", protocolVersion: CORE_PROTOCOL_VERSION, ok: true, result: { ready: true } }),
      ),
    ).toMatchObject({ requestId: "request-1", ok: true, result: { ready: true } });
    expect(
      parseCoreResponseLine(
        JSON.stringify({
          id: "request-2",
          requestId: "request-2",
          protocolVersion: CORE_PROTOCOL_VERSION,
          ok: false,
          error: { code: "NOPE", message: "denied", retryable: false },
        }),
      ),
    ).toMatchObject({ requestId: "request-2", ok: false, error: { code: "NOPE", retryable: false } });
  });

  it("rejects malformed and incompatible envelopes", () => {
    expect(() => parseCoreResponseLine("not json")).toThrow("malformed JSON");
    expect(() =>
      parseCoreResponseLine(JSON.stringify({ id: "request-1", requestId: "request-1", protocolVersion: "old", ok: true })),
    ).toThrow("incompatible protocol");
    expect(() =>
      parseCoreResponseLine(JSON.stringify({ id: 1, requestId: "1", protocolVersion: CORE_PROTOCOL_VERSION, ok: true })),
    ).toThrow("request id");
  });

  it("validates the complete core handshake", () => {
    expect(parseCoreHandshake({
      version: "0.1.0",
      protocolVersion: CORE_PROTOCOL_VERSION,
      schemaVersion: 1,
      capabilities: ["stdio-json-lines", "durable-recording"],
      build: { commit: null, target: "windows-x64", features: ["sqlcipher-vault"] },
    })).toEqual({
      coreVersion: "0.1.0",
      protocolVersion: CORE_PROTOCOL_VERSION,
      schemaVersion: 1,
      capabilities: ["stdio-json-lines", "durable-recording"],
      build: { target: "windows-x64", features: ["sqlcipher-vault"] },
    });
    expect(() => parseCoreHandshake({
      version: "0.1.0",
      protocolVersion: CORE_PROTOCOL_VERSION,
      schemaVersion: 0,
      capabilities: [],
      build: { target: "windows-x64", features: [] },
    })).toThrow("incompatible handshake");
  });

  it("validates unsolicited job events without treating them as responses", () => {
    expect(parseCoreEventLine(JSON.stringify({
      protocolVersion: CORE_PROTOCOL_VERSION,
      event: "jobs.changed",
      payload: {
        jobId: "a".repeat(32),
        type: "export",
        state: "running",
        terminal: false,
        rawPathExposed: false,
      },
    }))).toMatchObject({ event: "jobs.changed", payload: { state: "running" } });
    expect(() => parseCoreEventLine(JSON.stringify({
      protocolVersion: CORE_PROTOCOL_VERSION,
      event: "jobs.changed",
      payload: { jobId: "not-safe" },
    }))).toThrow("invalid job event payload");
  });

  it("keeps the preload on the exact named core channel allowlist", () => {
    const preloadPath = path.resolve(process.cwd(), "electron", "preload.cts");
    const preload = readFileSync(preloadPath, "utf8");
    const preloadChannels = new Set(
      [...preload.matchAll(/ipcRenderer\.invoke\(\s*"(candor-core:[^"]+)"/g)]
        .map((match) => match[1]),
    );
    const registeredChannels = new Set(rendererCoreOperations.map(({ channel }) => channel));

    expect(preloadChannels).toEqual(registeredChannels);
    expect(rendererCoreOperations.map(({ channel }) => channel).length).toBe(registeredChannels.size);
    expect(rendererCoreOperations.map(({ method }) => method).length).toBe(
      new Set(rendererCoreOperations.map(({ method }) => method)).size,
    );
    expect(preload).not.toContain("candor-core:call");
    expect(preload).not.toContain("callCore");
    expect(preload).not.toContain("allowedMethods");
  });

  it("keeps permanent deletion behind the native confirmation IPC", () => {
    expect(privateCoreMethods.has("recording.durable.delete")).toBe(true);
    expect(rendererCoreMethods.has("recording.durable.delete")).toBe(false);
  });
});
