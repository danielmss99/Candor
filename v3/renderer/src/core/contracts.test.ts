import { describe, expect, it } from "vitest";
import {
  EXPECTED_PROTOCOL_VERSION,
  ProtocolValidationError,
  parseBundledAiStatus,
  parseAnswer,
  parseMeetingPrivacyReceipt,
  parseProtocolVersion,
  parseRecap,
  parseRecordingPage,
  parseTerminologyStatus,
  parseTranscriptPage,
  parseTranscriptionQualityStatus,
} from "./contracts";

const heuristicProvenance = {
  engine: "heuristic",
  modelId: null,
  fallbackUsed: true,
  fallbackReason: "user-requested",
  promptVersion: "candor-heuristic-v1",
  generatedAt: "2026-07-14T12:00:00Z",
};

const localLlmProvenance = {
  engine: "local-llm",
  modelId: "qwen3-4b-official-q4_k_m",
  fallbackUsed: false,
  fallbackReason: null,
  promptVersion: "candor-grounded-v1",
  generatedAt: "2026-07-14T12:00:00Z",
};

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

  it("preserves pathless quarantine facts from the core", () => {
    const page = parseRecordingPage({
      offset: 0,
      limit: 50,
      totalCount: 0,
      hasMore: false,
      recordings: [],
      quarantinedCount: 1,
      quarantinedRecordings: [{
        recordingId: "rec-damaged",
        reasonCode: "future-manifest-schema",
        receiptPersisted: true,
        contentModified: false,
      }],
    });

    expect(page.quarantinedCount).toBe(1);
    expect(page.quarantinedRecordings).toEqual([{
      recordingId: "rec-damaged",
      reasonCode: "future-manifest-schema",
      receiptPersisted: true,
      contentModified: false,
    }]);
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

  it("accepts pathless bundled readiness and rejects path or hash exposure", () => {
    const status = {
      implemented: true,
      localOnly: true,
      cloudAi: false,
      releaseReady: false,
      fixture: false,
      selectionStatus: "no-default-selected",
      state: "no-default-selected",
      ready: false,
      repairRequired: false,
      repairPolicy: "signed-installer-only",
      repairAction: "none",
      speech: { state: "no-default-selected", ready: false, available: false, requiredAssets: 0, verifiedAssets: 0, modelId: null, failureCode: "BUNDLED_AI_NO_DEFAULT_SELECTED" },
      language: { state: "no-default-selected", ready: false, available: false, requiredAssets: 0, verifiedAssets: 0, modelId: null, failureCode: "BUNDLED_AI_NO_DEFAULT_SELECTED" },
      requiredDownload: false,
      backgroundDownloads: false,
      runtimePathAcceptedFromRenderer: false,
      rawPathExposed: false,
      hashExposed: false,
      keyMaterialExposedToRenderer: false,
    };
    expect(parseBundledAiStatus(status).repairPolicy).toBe("signed-installer-only");
    expect(() => parseBundledAiStatus({ ...status, hashExposed: true })).toThrow("local-only readiness");
    expect(() => parseBundledAiStatus({ ...status, cloudAi: true })).toThrow("local-only readiness");
    expect(() => parseBundledAiStatus({ ...status, state: "ready" })).toThrow("aggregate readiness");
    expect(() => parseBundledAiStatus({ ...status, repairRequired: true })).toThrow("matching repairRequired");
    const falseReady = {
      ...status,
      state: "ready",
      ready: true,
      speech: { ...status.speech, state: "ready", ready: true, available: true },
      language: { ...status.language, state: "ready", ready: true, available: true },
    };
    expect(() => parseBundledAiStatus(falseReady)).toThrow("selected model when ready");
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
      processing: [{
        eventType: "local-ai-recap",
        engine: "heuristic",
        modelId: null,
        sha256: null,
        format: null,
        bytes: null,
        aiProvenance: heuristicProvenance,
        createdAtMs: 2,
      }],
      exports: [],
      retention: { policy: "manual-delete-only", automaticDeletion: false },
      network: { policy: "disabled-by-default", externalCallsAttempted: 0, capabilities: [] },
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    });
    expect(receipt.capture.channels).toEqual(["mic", "system"]);
    expect(receipt.network.externalCallsAttempted).toBe(0);
    expect(receipt.processing[0].aiProvenance).toEqual(heuristicProvenance);
  });

  it("downgrades unknown signed dictionary trust labels at the renderer boundary", () => {
    const status = parseTerminologyStatus({
      implemented: true,
      state: "ready",
      dictionaryCount: 1,
      entryCount: 1,
      dictionaries: [{
        dictionaryId: "dictionary-1",
        name: "Community terms",
        enabled: true,
        assignedToRecording: false,
        entryCount: 1,
        packageId: "org.example.terms",
        packageVersion: "1.0.0",
        publisher: "Example",
        language: "en",
        signatureKeyId: "unknown-key",
        trustLabel: "verified-organization",
        signatureVerified: true,
        scope: "specialist",
        scopeTargetId: null,
        explicitPreference: 0,
        approvedCorrectionCount: 0,
      }],
      encryptedAtRest: true,
      projectScopeAvailable: false,
      promptWritingRequired: false,
      automaticCorrection: false,
      localOnly: true,
      cloudAi: false,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    });

    expect(status.dictionaries[0].trustLabel).toBe("community-unverified");
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
      provenance: heuristicProvenance,
    });
    expect(recap.citations[0]).toMatchObject({ text: "Decision text", quote: "Decision text" });
  });

  it("rejects malformed citation text instead of coercing it", () => {
    expect(() => parseRecap({
      engine: "heuristic-local",
      summary: "Local summary",
      citations: [{ segmentIndex: 0, quote: "Evidence", text: 42 }],
      provenance: heuristicProvenance,
    })).toThrow("citations[0].text");
  });

  it("requires strict source-linked metadata for llama.cpp output", () => {
    const strict = {
      engine: "llama-cpp-local",
      outputSchemaVersion: 1,
      strictOutputValidated: true,
      groundingMethod: "strict-source-id-and-exact-critical-evidence-v1",
    };
    expect(() => parseRecap({
      ...strict,
      summary: "Grounded recap",
      decisions: [],
      actions: [],
      risks: [],
      questions: [],
      citations: [],
      recapMarkdown: "Grounded recap",
      provenance: localLlmProvenance,
    })).not.toThrow();
    expect(() => parseRecap({ ...strict, strictOutputValidated: false, provenance: localLlmProvenance }))
      .toThrow("strict source-linked");
    expect(() => parseAnswer({
      ...strict,
      question: "What changed?",
      answer: "No grounded answer was found in this meeting.",
      answerFound: false,
      citations: [],
      provenance: localLlmProvenance,
    })).not.toThrow();
    expect(() => parseAnswer({
      ...strict,
      outputSchemaVersion: 2,
      answer: "Unsupported",
      citations: [],
      provenance: localLlmProvenance,
    })).toThrow("strict source-linked");
  });

  it("validates benchmark state and retry tier without exposing raw measurements", () => {
    const status = {
      implemented: true,
      state: "ready",
      tier: "fast",
      languagePreference: "english",
      recommendedTier: "fast",
      benchmarkState: "failed",
      benchmarkFailureTier: "balanced",
      estimatedRealTimeFactor: null,
      estimatedMinutesPerHour: null,
      estimatedCompletionAvailable: false,
      fallbackApplied: true,
      guardReason: "balanced-requires-passing-local-benchmark-on-this-device",
      hardware: {},
      tiers: [
        { id: "fast", label: "Fast", available: true, recommended: true, guardReason: null },
        { id: "balanced", label: "Balanced", available: false, recommended: false, guardReason: "benchmark" },
        { id: "maximum", label: "Maximum accuracy", available: false, recommended: false, guardReason: "memory" },
      ],
      localOnly: true,
      cloudAi: false,
      rawModelNamesExposed: false,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
    expect(parseTranscriptionQualityStatus(status)).toMatchObject({
      benchmarkState: "failed",
      benchmarkFailureTier: "balanced",
    });
    expect(() => parseTranscriptionQualityStatus({
      ...status,
      benchmarkFailureTier: "fast",
    })).toThrow("benchmarkFailureTier");
    expect(() => parseTranscriptionQualityStatus({
      ...status,
      benchmarkState: "probably-fine",
    })).toThrow("benchmarkState");
    expect(parseTranscriptionQualityStatus({
      ...status,
      benchmarkState: "measured",
      benchmarkFailureTier: null,
      estimatedMinutesPerHour: 15,
      estimatedCompletionAvailable: true,
    })).toMatchObject({ estimatedMinutesPerHour: 15 });
    expect(() => parseTranscriptionQualityStatus({
      ...status,
      estimatedMinutesPerHour: 15.5,
    })).toThrow("estimatedMinutesPerHour");
    expect(() => parseTranscriptionQualityStatus({
      ...status,
      estimatedRealTimeFactor: 0.25,
    })).toThrow("diagnostics-only");
    expect(() => parseTranscriptionQualityStatus({
      ...status,
      estimatedMinutesPerHour: 15,
      estimatedCompletionAvailable: false,
    })).toThrow("consistent");
  });
});
