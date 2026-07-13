import { describe, expect, it } from "vitest";
import {
  chooseInitialSelection,
  mergeRecordingPages,
  mergeTranscriptPages,
} from "./useMeetingWorkspace";

const recording = (recordingId: string) => ({
  recordingId,
  label: recordingId,
  state: "saved",
  audioDurationMs: 0,
  audioChunkCount: 0,
  transcriptSegmentCount: 0,
  updatedAtMs: 0,
});

describe("meeting workspace paging", () => {
  it("keeps a valid selection and falls back deterministically", () => {
    const recordings = [recording("one"), recording("two")];
    expect(chooseInitialSelection("two", recordings)).toBe("two");
    expect(chooseInitialSelection("missing", recordings)).toBe("one");
    expect(chooseInitialSelection("missing", [])).toBe("");
  });

  it("deduplicates recording and transcript pages", () => {
    expect(mergeRecordingPages([recording("one")], [recording("one"), recording("two")]).map((item) => item.recordingId))
      .toEqual(["one", "two"]);
    expect(mergeTranscriptPages(
      [{ index: 0, channel: "mic", speaker: "Me", text: "One", startMs: 0, endMs: 1 }],
      [
        { index: 0, channel: "mic", speaker: "Me", text: "One", startMs: 0, endMs: 1 },
        { index: 1, channel: "system", speaker: "Them", text: "Two", startMs: 1, endMs: 2 },
      ],
    ).map((item) => item.index)).toEqual([0, 1]);
  });
});

