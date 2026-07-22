import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { CoreClient } from "../core/core-client.js";
import {
  ModelAcquisitionService,
  type ModelHttpsRequest,
} from "./model-acquisition-service.js";
import type { TrustedModelCatalogEntry } from "./model-catalog.js";

function fixtureEntry(expectedSha256 = createHash("sha256").update("abc").digest("hex")): TrustedModelCatalogEntry {
  return {
    modelId: "fixture-model",
    displayName: "Fixture model",
    capability: "speech",
    engine: "fixture",
    publisher: "Candor tests",
    distributionSource: "fixture",
    revision: "0123456789abcdef0123456789abcdef01234567",
    expectedSha256,
    bytes: 3,
    licenseExpression: "MIT",
    languages: ["English"],
    hardware: "Test only",
    releaseState: "ready",
    releaseNote: "Test model",
    defaultEligible: false,
    download: {
      url: "https://models.example.test/fixture.bin",
      allowedHosts: ["models.example.test"],
    },
  };
}

function responseFrom(source: Readable): IncomingMessage {
  return Object.assign(source, {
    statusCode: 200,
    headers: { "content-length": "3" },
  }) as unknown as IncomingMessage;
}

function requestReturning(response: IncomingMessage): ModelHttpsRequest {
  return (_url, _options, listener) => {
    const request = new EventEmitter() as unknown as ClientRequest;
    request.end = vi.fn(() => {
      queueMicrotask(() => listener(response));
      return request;
    }) as unknown as ClientRequest["end"];
    request.destroy = vi.fn(() => request) as ClientRequest["destroy"];
    request.setTimeout = vi.fn(() => request) as ClientRequest["setTimeout"];
    return request;
  };
}

function coreFixture(
  phase: "idle" | "recording" = "idle",
  models: Array<Record<string, unknown>> = [],
) {
  const call = vi.fn(async (method: string) => {
    if (method === "models.status") return { ok: true, result: { models } };
    if (method === "models.importStart") return { ok: true, result: { importId: "import-1" } };
    if (method === "models.importFinish.start") {
      return { ok: true, result: { jobId: "job-1", type: "speech-model-import", state: "queued", createdAt: "2026-07-21T00:00:00Z" } };
    }
    return { ok: true, result: {} };
  });
  return {
    call,
    core: {
      call,
      captureGuardPhase: () => phase,
    } as unknown as CoreClient,
  };
}

describe("ModelAcquisitionService", () => {
  it("recommends a default-eligible speech model only after core verification", async () => {
    const eligible = { ...fixtureEntry(), defaultEligible: true };
    const { core } = coreFixture("idle", [{ modelId: eligible.modelId, installed: true, verified: true }]);
    const service = new ModelAcquisitionService(core, () => null, { catalog: [eligible] });

    await expect(service.catalog()).resolves.toMatchObject({
      recommendedDefaultModelId: eligible.modelId,
      models: [{ modelId: eligible.modelId, installed: true, verified: true }],
    });
  });

  it("rejects a hash mismatch and aborts the core-owned staging import", async () => {
    const { core, call } = coreFixture();
    const service = new ModelAcquisitionService(core, () => null, {
      catalog: [fixtureEntry("a".repeat(64))],
      requestHttps: requestReturning(responseFrom(Readable.from([Buffer.from("abc")]))),
    });

    await expect(service.download("fixture-model")).rejects.toThrow("integrity check");
    expect(call).toHaveBeenCalledWith("models.importAbort", { importId: "import-1" });
    expect(call).not.toHaveBeenCalledWith("models.importFinish.start", expect.anything());
  });

  it("rejects a response without an explicit content length before importing chunks", async () => {
    const { core, call } = coreFixture();
    const response = responseFrom(Readable.from([Buffer.from("abc")]));
    response.headers = {};
    const service = new ModelAcquisitionService(core, () => null, {
      catalog: [fixtureEntry()],
      requestHttps: requestReturning(response),
    });

    await expect(service.download("fixture-model")).rejects.toThrow("content length");
    expect(call).toHaveBeenCalledWith("models.importAbort", { importId: "import-1" });
    expect(call).not.toHaveBeenCalledWith("models.importChunk", expect.anything());
    expect(call).not.toHaveBeenCalledWith("models.importFinish.start", expect.anything());
  });

  it("refuses an active-recording download before import or network access", async () => {
    const { core, call } = coreFixture("recording");
    const requestHttps = vi.fn(requestReturning(responseFrom(Readable.from([Buffer.from("abc")]))));
    const service = new ModelAcquisitionService(core, () => null, {
      catalog: [fixtureEntry()],
      requestHttps,
    });

    await expect(service.download("fixture-model")).rejects.toThrow("active recording");
    expect(requestHttps).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  it("rejects a concurrent transfer and cleans staging after cancellation", async () => {
    let releaseSecondChunk: () => void = () => {};
    const gate = new Promise<void>((resolve) => { releaseSecondChunk = resolve; });
    async function* chunks() {
      yield Buffer.from("a");
      await gate;
      yield Buffer.from("bc");
    }
    const { core, call } = coreFixture();
    const service = new ModelAcquisitionService(core, () => null, {
      catalog: [fixtureEntry()],
      requestHttps: requestReturning(responseFrom(Readable.from(chunks()))),
    });

    const first = service.download("fixture-model");
    await vi.waitFor(() => {
      expect(call).toHaveBeenCalledWith("models.importChunk", expect.objectContaining({ importId: "import-1" }));
    });
    await expect(service.download("fixture-model")).rejects.toThrow("already active");
    expect(service.cancel("fixture-model")).toMatchObject({ canceled: true });
    releaseSecondChunk();
    await expect(first).rejects.toThrow("canceled");
    expect(call).toHaveBeenCalledWith("models.importAbort", { importId: "import-1" });
    expect(call).not.toHaveBeenCalledWith("models.importFinish.start", expect.anything());
  });

  it("honors cancellation after the final chunk and before verification starts", async () => {
    let service: ModelAcquisitionService;
    const call = vi.fn(async (method: string) => {
      if (method === "models.importStart") return { ok: true, result: { importId: "import-1" } };
      if (method === "models.importChunk") {
        service.cancel("fixture-model");
        return { ok: true, result: {} };
      }
      if (method === "models.importFinish.start") {
        return { ok: true, result: { jobId: "job-1" } };
      }
      return { ok: true, result: {} };
    });
    const core = {
      call,
      captureGuardPhase: () => "idle",
    } as unknown as CoreClient;
    service = new ModelAcquisitionService(core, () => null, {
      catalog: [fixtureEntry()],
      requestHttps: requestReturning(responseFrom(Readable.from([Buffer.from("abc")]))),
    });

    await expect(service.download("fixture-model")).rejects.toThrow("canceled");
    expect(call).toHaveBeenCalledWith("models.importAbort", { importId: "import-1" });
    expect(call).not.toHaveBeenCalledWith("models.importFinish.start", expect.anything());
  });
});
