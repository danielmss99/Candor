import { describe, expect, it } from "vitest";
import {
  activeMeetingProfile,
  profileCaptureBinding,
  profilePostStartActions,
  preferredCaptureAction,
  preferredCaptureActionForProfile,
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

  it("starts live ASR only for an opted-in profile with its verified local model", () => {
    const profile = {
      id: "interview",
      version: 4,
      captureSource: "microphone" as const,
      localModelTier: "maximum" as const,
      language: "fr",
      dictionaryIds: ["legal"],
      liveTranscription: true,
    };
    expect(profilePostStartActions(profile, false, ["large-v3"])).toEqual([]);
    expect(profilePostStartActions(profile, true, ["small"])).toEqual([]);
    expect(profilePostStartActions(profile, true, ["large-v3"]))
      .toEqual(["live-transcription"]);
    expect(profilePostStartActions(
      { ...profile, liveTranscription: false },
      true,
      ["large-v3"],
    )).toEqual([]);
  });

  it("binds capture requests to the exact active profile version", () => {
    expect(activeMeetingProfile({
      activeProfileId: "interview",
      profiles: [{
        id: "interview",
        version: 4,
        captureSource: "combined",
        localModelTier: "maximum",
        language: "fr",
        dictionaryIds: ["legal"],
        liveTranscription: false,
      }],
    })).toMatchObject({ id: "interview", version: 4, captureSource: "combined" });
    expect(activeMeetingProfile({
      activeProfileId: "interview",
      profiles: [{ id: "interview", captureSource: "combined", localModelTier: "maximum" }],
    })).toBeNull();
    expect(profileCaptureBinding({
      id: "interview",
      version: 4,
      captureSource: "combined",
      localModelTier: "maximum",
      language: "fr",
      dictionaryIds: ["legal"],
      liveTranscription: false,
    })).toEqual({ profileId: "interview", profileVersion: 4 });
    const microphoneProfile = {
      id: "voice-notes",
      version: 2,
      captureSource: "microphone" as const,
      localModelTier: "fast" as const,
      language: "en",
      dictionaryIds: [],
      liveTranscription: true,
    };
    expect(preferredCaptureActionForProfile(microphoneProfile, true, true)).toBe("microphone");
    expect(preferredCaptureActionForProfile(microphoneProfile, false, false)).toBe("microphone");
    expect(preferredCaptureActionForProfile(null, true, true)).toBe("combined");
  });
});
