import { describe, expect, it } from "vitest";
import { mergePartialTranscript } from "./useLiveTranscript";

function payload(sequence: number, text: string): LiveTranscriptPartialPayload {
  return {
    event: "transcript.partial",
    schemaVersion: 1,
    recordingId: "recording_1",
    sequence,
    provisional: true,
    isFinal: false,
    startMs: sequence * 100,
    endMs: sequence * 100 + 90,
    text,
    segmentCount: sequence,
    localOnly: true,
    networkAttempted: false,
    rawPathExposed: false,
    keyMaterialExposedToRenderer: false,
  };
}

describe("live transcript renderer state", () => {
  it("orders, replaces, and bounds fixed provisional events", () => {
    let segments = mergePartialTranscript([], payload(2, "second"));
    segments = mergePartialTranscript(segments, payload(1, "first"));
    segments = mergePartialTranscript(segments, payload(2, "second updated"));
    expect(segments.map((segment) => segment.text)).toEqual(["first", "second updated"]);

    for (let sequence = 3; sequence <= 300; sequence += 1) {
      segments = mergePartialTranscript(segments, payload(sequence, `part ${sequence}`));
    }
    expect(segments).toHaveLength(256);
    expect(segments[0]?.sequence).toBe(45);
    expect(segments.at(-1)?.sequence).toBe(300);
  });
});
