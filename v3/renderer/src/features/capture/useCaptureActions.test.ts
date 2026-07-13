import { describe, expect, it } from "vitest";
import { preferredCaptureAction } from "./useCaptureActions";

describe("preferred capture action", () => {
  it("stops an active capture and otherwise prefers consented combined audio", () => {
    expect(preferredCaptureAction(true, true, true)).toBe("stop");
    expect(preferredCaptureAction(false, true, true)).toBe("combined");
    expect(preferredCaptureAction(false, true, false)).toBe("microphone");
    expect(preferredCaptureAction(false, false, true)).toBe("microphone");
  });
});

