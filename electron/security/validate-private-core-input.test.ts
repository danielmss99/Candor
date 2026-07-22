import { describe, expect, it } from "vitest";
import { validatePrivateCoreParams } from "./validate-private-core-input.js";

describe("private core input validation", () => {
  it("accepts a bounded recap template and trims only outer whitespace", () => {
    expect(validatePrivateCoreParams("ai.recap.start", {
      recordingId: "recording_1",
      recapTemplate: "  Focus on decisions, owners, and blockers.  ",
      intent: "default",
    })).toEqual({
      recordingId: "recording_1",
      recapTemplate: "Focus on decisions, owners, and blockers.",
      intent: "default",
    });
  });

  it("rejects oversized, unsafe, and misplaced recap templates", () => {
    expect(() => validatePrivateCoreParams("ai.recap.start", {
      recordingId: "recording_1",
      recapTemplate: "é".repeat(2_049),
    })).toThrow(/recapTemplate/i);
    expect(() => validatePrivateCoreParams("ai.recap.start", {
      recordingId: "recording_1",
      recapTemplate: "unsafe\0template",
    })).toThrow(/recapTemplate/i);
    expect(() => validatePrivateCoreParams("ai.ask.start", {
      recordingId: "recording_1",
      question: "What changed?",
      recapTemplate: "not accepted here",
    })).toThrow(/recapTemplate.*not allowed/i);
  });

  it("keeps local eligibility path-only and requires a lowercase source identity for import", () => {
    const sourcePath = "C:\\incoming\\meeting.wav";
    const expectedSourceSha256 = "a".repeat(64);
    expect(validatePrivateCoreParams("media.validateLocalSourcePath", { sourcePath })).toEqual({ sourcePath });
    expect(validatePrivateCoreParams("media.importFromPath", {
      sourcePath,
      expectedSourceSha256,
    })).toEqual({ sourcePath, expectedSourceSha256 });

    for (const invalid of ["A".repeat(64), "a".repeat(63), `${"a".repeat(63)}g`]) {
      expect(() => validatePrivateCoreParams("media.importFromPath", {
        sourcePath,
        expectedSourceSha256: invalid,
      })).toThrow(/lowercase SHA-256/i);
    }
    expect(() => validatePrivateCoreParams("media.importFromPath", { sourcePath }))
      .toThrow(/lowercase SHA-256/i);
    expect(() => validatePrivateCoreParams("media.validateLocalSourcePath", {
      sourcePath,
      expectedSourceSha256,
    })).toThrow(/expectedSourceSha256.*not allowed/i);
    expect(() => validatePrivateCoreParams("media.inspectFromPath", { sourcePath }))
      .toThrow(/no private input contract/i);
  });
});
