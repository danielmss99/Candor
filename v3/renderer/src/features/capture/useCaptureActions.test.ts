import { describe, expect, it } from "vitest";
import {
  preferredCaptureAction,
  requireStartedRecordingId,
  shouldDisableRecordControl,
} from "./useCaptureActions";

describe("preferred capture action", () => {
  it("stops an active capture and otherwise prefers consented combined audio", () => {
    expect(preferredCaptureAction(true, true, true)).toBe("stop");
    expect(preferredCaptureAction(false, true, true)).toBe("combined");
    expect(preferredCaptureAction(false, true, false)).toBe("microphone");
    expect(preferredCaptureAction(false, false, true)).toBe("microphone");
  });

  it("keeps Stop available during unrelated local work", () => {
    expect(shouldDisableRecordControl("transcription", true, false)).toBe(false);
    expect(shouldDisableRecordControl("export", true, true)).toBe(false);
    expect(shouldDisableRecordControl("stop", true, false)).toBe(true);
    expect(shouldDisableRecordControl("transcription", false, false)).toBe(true);
    expect(shouldDisableRecordControl("", false, true)).toBe(true);
    expect(shouldDisableRecordControl("", false, false)).toBe(false);
  });

  it("rejects a malformed capture start response instead of inventing an ID", () => {
    expect(requireStartedRecordingId({ capture: { recordingId: "rec-1" } })).toBe("rec-1");
    expect(() => requireStartedRecordingId({ capture: {} })).toThrow(
      "Capture start did not return a durable recording ID.",
    );
  });
});
