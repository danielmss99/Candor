import { describe, expect, it } from "vitest";
import { CORE_PROTOCOL_VERSION, createCoreRequest, parseCoreResponseLine } from "./protocol.js";

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
        JSON.stringify({ id: "request-1", protocolVersion: CORE_PROTOCOL_VERSION, ok: true, result: { ready: true } }),
      ),
    ).toMatchObject({ requestId: "request-1", ok: true, result: { ready: true } });
    expect(
      parseCoreResponseLine(
        JSON.stringify({
          id: "request-2",
          protocolVersion: CORE_PROTOCOL_VERSION,
          ok: false,
          error: { code: "NOPE", message: "denied" },
        }),
      ),
    ).toMatchObject({ requestId: "request-2", ok: false, error: { code: "NOPE", retryable: false } });
  });

  it("rejects malformed and incompatible envelopes", () => {
    expect(() => parseCoreResponseLine("not json")).toThrow("malformed JSON");
    expect(() =>
      parseCoreResponseLine(JSON.stringify({ id: "request-1", protocolVersion: "old", ok: true })),
    ).toThrow("incompatible protocol");
    expect(() =>
      parseCoreResponseLine(JSON.stringify({ id: 1, protocolVersion: CORE_PROTOCOL_VERSION, ok: true })),
    ).toThrow("request id");
  });
});
