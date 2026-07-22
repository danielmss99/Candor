import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonValue } from "./json.js";
import type { CoreResponse } from "./protocol.js";
import { LiveTranscriptEventBridge } from "./live-transcript-event-bridge.js";

function response(result: JsonValue): CoreResponse {
  return {
    id: "request-1",
    requestId: "request-1",
    protocolVersion: "m0-jsonrpc-stdio-1",
    ok: true,
    result,
  };
}

function partialPayload(overrides: Record<string, JsonValue> = {}): JsonValue {
  return {
    event: "transcript.partial",
    schemaVersion: 1,
    recordingId: "recording_1",
    sequence: 1,
    provisional: true,
    isFinal: false,
    startMs: 0,
    endMs: 500,
    text: "local partial",
    segmentCount: 1,
    localOnly: true,
    networkAttempted: false,
    rawPathExposed: false,
    keyMaterialExposedToRenderer: false,
    ...overrides,
  };
}

function drainResult(payload: JsonValue, remainingEventCount = 0): JsonValue {
  return {
    schemaVersion: 1,
    events: [{
      schemaVersion: 1,
      deliverySequence: 1,
      channel: "transcript.partial",
      payload,
      localOnly: true,
      networkAttempted: false,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    }],
    drainedEventCount: 1,
    remainingEventCount,
    localOnly: true,
    networkAttempted: false,
    rawPathExposed: false,
    keyMaterialExposedToRenderer: false,
  };
}

afterEach(() => vi.useRealTimers());

describe("LiveTranscriptEventBridge", () => {
  it("delivers only the fixed canonical partial event while a session is active", async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const call = vi.fn(async () => response(drainResult(partialPayload({ extra: "removed" }))));
    const bridge = new LiveTranscriptEventBridge({
      core: { call },
      getMainWindow: () => ({
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, send },
      }),
    });

    bridge.observeCoreOperation(
      "liveTranscript.start",
      { recordingId: "recording_1" },
      { active: true },
    );
    await bridge.drainOnce();
    bridge.dispose();

    expect(call).toHaveBeenCalledWith("liveTranscript.eventsDrain", null);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toBe("candor-events:transcript-partial");
    expect(send.mock.calls[0]?.[1]).toEqual(partialPayload());
    expect(send.mock.calls[0]?.[1]).not.toHaveProperty("extra");
  });

  it("does not drain without an active session or without a live renderer", async () => {
    vi.useFakeTimers();
    const call = vi.fn(async () => response(drainResult(partialPayload())));
    const bridge = new LiveTranscriptEventBridge({
      core: { call },
      getMainWindow: () => null,
    });

    await bridge.drainOnce();
    bridge.observeCoreOperation(
      "liveTranscript.start",
      { recordingId: "recording_1" },
      { active: true },
    );
    await bridge.drainOnce();
    bridge.dispose();

    expect(call).not.toHaveBeenCalled();
  });

  it("rejects custody violations and stops polling after a successful stop", async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const call = vi.fn(async () => response(drainResult(partialPayload({ networkAttempted: true }))));
    const bridge = new LiveTranscriptEventBridge({
      core: { call },
      getMainWindow: () => ({
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, send },
      }),
    });

    bridge.observeCoreOperation(
      "liveTranscript.start",
      { recordingId: "recording_1" },
      { active: true },
    );
    await bridge.drainOnce();
    expect(send).not.toHaveBeenCalled();

    bridge.observeCoreOperation(
      "liveTranscript.stop",
      { recordingId: "recording_1" },
      { sessionRemoved: true },
    );
    call.mockClear();
    await bridge.drainOnce();
    bridge.dispose();
    expect(call).not.toHaveBeenCalled();
  });

  it("drains the bounded tail and releases its timer after capture stops", async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const call = vi
      .fn()
      .mockResolvedValueOnce(response(drainResult(partialPayload({ sequence: 1 }), 1)))
      .mockResolvedValueOnce(response(drainResult(partialPayload({ sequence: 2 }), 0)));
    const bridge = new LiveTranscriptEventBridge({
      core: { call },
      getMainWindow: () => ({
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, send },
      }),
    });

    bridge.observeCoreOperation(
      "liveTranscript.start",
      { recordingId: "recording_1" },
      { active: true },
    );
    expect(vi.getTimerCount()).toBe(1);

    await bridge.observeCoreOperation(
      "capture.stop",
      null,
      {
        capture: { recordingId: "recording_1" },
        liveTranscriptProducer: { cancellationRequested: true },
      },
    );

    expect(call).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map((item) => (item[1] as Record<string, JsonValue>).sequence))
      .toEqual([1, 2]);
    expect(vi.getTimerCount()).toBe(0);
    await bridge.drainOnce();
    expect(call).toHaveBeenCalledTimes(2);
    bridge.dispose();
  });
});
