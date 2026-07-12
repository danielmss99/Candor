import { describe, expect, it } from "vitest";
import {
  EXPECTED_PROTOCOL_VERSION,
  ProtocolValidationError,
  parseMeetingPrivacyReceipt,
  parseProtocolVersion,
  parseRecap,
  parseRecordingPage,
  parseTranscriptPage,
} from "./contracts";

describe("versioned Candor contracts", () => {
  it("accepts the expected core protocol", () => {
    expect(parseProtocolVersion({ version: "0.1.0", protocolVersion: EXPECTED_PROTOCOL_VERSION }))
      .toEqual({ version: "0.1.0", protocolVersion: EXPECTED_PROTOCOL_VERSION });
  });

  it("rejects a protocol mismatch visibly", () => {
    expect(() => parseProtocolVersion({ version: "0.1.0", protocolVersion: "future" }))
      .toThrow(ProtocolValidationError);
  });

  it("rejects malformed recording values instead of coercing them", () => {
    expect(() => parseRecordingPage({
      offset: 0,
      limit: 50,
      totalCount: 1,
      hasMore: false,
      recordings: [{
        recordingId: "rec-1",
        label: "Meeting",
        state: "finished",
        audioDurationMs: "not-a-number",
        audioChunkCount: 1,
        transcriptSegmentCount: 1,
        updatedAtMs: 1,
      }],
    })).toThrow("audioDurationMs");
  });

  it("rejects malformed transcript arrays", () => {
    expect(() => parseTranscriptPage({
      recordingId: "rec-1",
      offset: 0,
      limit: 200,
      segmentCount: 1,
      hasMore: false,
      durationMs: 500,
      segments: "not-an-array",
    })).toThrow("segments");
  });

  it("accepts a pathless core-backed privacy receipt", () => {
    const receipt = parseMeetingPrivacyReceipt({
      proofKind: "meeting-privacy-receipt",
      receiptVersion: 1,
      generatedAtMs: 3,
      recording: {
        recordingId: "rec-1",
        label: "Meeting",
        state: "finished",
        createdAtMs: 1,
        updatedAtMs: 2,
        deletionStatus: "present",
      },
      capture: { channels: ["mic", "system"], audioChunkCount: 2, channelAttribution: true },
      storage: { rootKind: "local-user-data", encryptedAudioChunkCount: 2, allAudioEncrypted: true, cipher: "chacha20poly1305" },
      content: { transcriptSegmentCount: 4, notesSavedLocally: true },
      processing: [],
      exports: [],
      retention: { policy: "manual-delete-only", automaticDeletion: false },
      network: { policy: "disabled-by-default", externalCallsAttempted: 0, capabilities: [] },
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    });
    expect(receipt.capture.channels).toEqual(["mic", "system"]);
    expect(receipt.network.externalCallsAttempted).toBe(0);
  });

  it("accepts quote-only heuristic citations", () => {
    const recap = parseRecap({
      engine: "heuristic-local",
      summary: "Local summary",
      decisions: [],
      actions: [],
      risks: [],
      questions: [],
      citations: [{ segmentIndex: 0, startMs: 10, speaker: "Alex", quote: "Decision text" }],
      recapMarkdown: "",
    });
    expect(recap.citations[0]).toMatchObject({ text: "Decision text", quote: "Decision text" });
  });

  it("rejects malformed citation text instead of coercing it", () => {
    expect(() => parseRecap({
      engine: "heuristic-local",
      summary: "Local summary",
      citations: [{ segmentIndex: 0, quote: "Evidence", text: 42 }],
    })).toThrow("citations[0].text");
  });
});
