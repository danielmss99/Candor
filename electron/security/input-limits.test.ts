import { describe, expect, it } from "vitest";
import { boundedString, INPUT_LIMITS, validModelId, validRecordingId } from "./input-limits.js";

describe("IPC input limits", () => {
  it("rejects overlong strings instead of truncating them", () => {
    expect(boundedString("  hello  ", 10)).toBe("hello");
    expect(boundedString("x".repeat(INPUT_LIMITS.searchQuery + 1), INPUT_LIMITS.searchQuery)).toBe("");
  });

  it("allows only opaque recording and model identifiers", () => {
    expect(validRecordingId("rec_123-abc")).toBe(true);
    expect(validRecordingId("../recording")).toBe(false);
    expect(validModelId("small.en-tdrz")).toBe(true);
    expect(validModelId("model/path")).toBe(false);
  });
});
