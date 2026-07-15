import { describe, expect, it } from "vitest";

import { jsonObjectResultSchema } from "./runtime-schema.js";

describe("capture session runtime schema", () => {
  const schema = jsonObjectResultSchema("capture.status", {
    activeSession: "capture-session-or-null",
  });

  it("accepts a measured nonnegative capture duration", () => {
    expect(schema.parse({
      activeSession: { recordingId: "recording-1", durationMs: 1_250 },
    })).toEqual({
      activeSession: { recordingId: "recording-1", durationMs: 1_250 },
    });
  });

  it("rejects active sessions without a measured duration", () => {
    expect(() => schema.parse({
      activeSession: { recordingId: "recording-1" },
    })).toThrowError(/invalid activeSession field/);
  });

  it("continues to accept an inactive null session", () => {
    expect(schema.parse({ activeSession: null })).toEqual({ activeSession: null });
  });
});
