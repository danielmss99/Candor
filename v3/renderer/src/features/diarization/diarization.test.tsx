import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  DiarizationSettings,
  parseDiarizationStatus,
  parseSpeakerNames,
  type DiarizationController,
} from "./index";

function controller(overrides: Partial<DiarizationController> = {}): DiarizationController {
  return {
    status: {
      state: "engine-unavailable",
      reasonCode: "DIARIZATION_ENGINE_UNAVAILABLE",
      enabledByUser: true,
      engineAvailable: false,
      diarizationAvailable: false,
      modelVerified: false,
      licenseEvidenceVerified: false,
      redistributionAllowed: false,
      benchmarkPassed: false,
      benchmarkRequired: true,
      encryptedAtRest: true,
    },
    assignments: [{ anonymousSpeakerId: "speaker-1", displayName: "Avery" }],
    loading: false,
    busy: false,
    notice: "",
    error: "",
    setEnabled: vi.fn().mockResolvedValue(undefined),
    assign: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    refreshDiarization: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("diarization settings", () => {
  it("reports an unavailable local engine without claiming speaker identity", () => {
    const markup = renderToStaticMarkup(
      <DiarizationSettings selectedRecordingId="recording_1" controller={controller()} />,
    );
    expect(markup).toContain("No local diarization engine is included yet");
    expect(markup).toContain("Identity inference");
    expect(markup).toContain("Never");
    expect(markup).toContain("Candor does not use them as biometric identity evidence");
    expect(markup).toContain("speaker-1");
    expect(markup).toContain("Avery");
  });

  it("fails closed when status or speaker provenance is malformed", () => {
    expect(parseDiarizationStatus({ state: "ready", enabledByUser: true, engineAvailable: false }))
      .toMatchObject({ state: "engine-unavailable", engineAvailable: false, diarizationAvailable: false });
    expect(parseDiarizationStatus({ state: "cloud-ready" }).state).toBe("unavailable");
    expect(parseSpeakerNames({
      assignments: [{
        anonymousSpeakerId: "speaker-1",
        displayName: "Avery",
        userControlled: true,
        identityInferred: false,
        biometricIdentityClaimed: false,
      }],
    })).toEqual([{ anonymousSpeakerId: "speaker-1", displayName: "Avery" }]);
    expect(parseSpeakerNames({
      assignments: [{
        anonymousSpeakerId: "speaker-1",
        displayName: "Avery",
        userControlled: true,
        identityInferred: true,
        biometricIdentityClaimed: false,
      }],
    })).toEqual([]);
  });

  it("keeps speaker-name controls unavailable until a meeting is selected", () => {
    const markup = renderToStaticMarkup(
      <DiarizationSettings selectedRecordingId="" controller={controller({ assignments: [] })} />,
    );
    expect(markup).toContain("Open a meeting before assigning an anonymous speaker label");
    expect(markup).not.toContain("Save name</button>");
  });
});
