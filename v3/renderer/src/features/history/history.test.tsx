import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { parseProtectedTermReview, parseTranscriptRevisionDetail, parseTrustHistory } from "./history-parsers";
import { TrustHistoryView } from "./TrustHistoryPanel";
import { runReprocessJob } from "./useTrustHistory";
import type { TrustHistoryController } from "./types";

const rawHash = "a".repeat(64);
const normalizedHash = "b".repeat(64);

function controller(overrides: Partial<TrustHistoryController> = {}): TrustHistoryController {
  return {
    history: {
      recordingId: "rec_1",
      currentRevisionId: "revision_2",
      currentCleanedRevisionId: null,
      immutableRevisions: true,
      originalAudioRetained: true,
      revisions: [
        {
          revisionId: "revision_1",
          version: 1,
          source: "initial",
          kind: "raw-asr",
          parentRevisionId: null,
          engine: "whisper.cpp",
          modelId: "local-small",
          modelSha256: "c".repeat(64),
          createdAtMs: 1_700_000_000_000,
          comparison: null,
          rawComparisonAvailable: false,
        },
        {
          revisionId: "revision_2",
          version: 2,
          source: "reprocess",
          kind: "raw-asr",
          parentRevisionId: null,
          engine: "whisper.cpp",
          modelId: "local-medium",
          modelSha256: "d".repeat(64),
          createdAtMs: 1_700_000_100_000,
          comparison: {
            rawTextSha256: rawHash,
            normalizedTextSha256: normalizedHash,
            rawTextBytes: 1_200,
            normalizedTextBytes: 1_180,
            rawSegmentCount: 12,
            normalizedSegmentCount: 11,
            changed: true,
          },
          rawComparisonAvailable: true,
        },
      ],
      processingReceipts: [{
        receiptId: "receipt_1",
        attempt: 2,
        operation: "transcription",
        stage: "transcription",
        outcome: "failed",
        engine: "whisper.cpp",
        modelId: "local-medium",
        modelSha256: "d".repeat(64),
        revisionId: null,
        inputRevisionId: null,
        inputRevisionKind: null,
        promptTemplateSha256: null,
        validationResult: "failed",
        fallbackApplied: false,
        errorCode: "MODEL_UNAVAILABLE",
        errorSummary: "The selected local model could not be loaded.",
        startedAtMs: 1_700_000_200_000,
        finishedAtMs: 1_700_000_202_100,
        elapsedMs: 2_100,
        comparison: null,
      }],
    },
    viewedRevision: {
      recordingId: "rec_1",
      current: true,
      currentCleaned: false,
      revision: {
        revisionId: "revision_2",
        version: 2,
        source: "reprocess",
        kind: "raw-asr",
        parentRevisionId: null,
        engine: "whisper.cpp",
        modelId: "local-medium",
        modelSha256: "d".repeat(64),
        createdAtMs: 1_700_000_100_000,
        comparison: {
          rawTextSha256: rawHash,
          normalizedTextSha256: normalizedHash,
          rawTextBytes: 1_200,
          normalizedTextBytes: 1_180,
          rawSegmentCount: 12,
          normalizedSegmentCount: 11,
          changed: true,
        },
        rawComparisonAvailable: true,
      },
      segmentCount: 1,
      returnedSegmentCount: 1,
      hasMore: false,
      segments: [{ startMs: 4_000, endMs: 7_000, speaker: "Speaker 1", text: "A locally stored transcript segment." }],
      comparisonView: {
        available: true,
        rawText: " teh locally stored transcript segment. ",
        normalizedText: "A locally stored transcript segment.",
        rawTextTruncated: false,
        normalizedTextTruncated: false,
        maxTextBytesPerSide: 65_536,
        encryptedAtRest: true,
        reason: null,
      },
    },
    loading: false,
    revisionLoading: false,
    busy: false,
    error: "",
    notice: "",
    reprocessJob: null,
    protectedTermReview: {
      recordingId: "rec_1",
      revisionId: "revision_2",
      ruleSetId: "protected-names",
      ruleSetVersion: 2,
      reviewRequired: false,
      replacementCount: 0,
      changes: [],
      changedSegmentCount: 0,
      previewSegments: [],
      previewTruncated: false,
      previewToken: null,
    },
    refreshHistory: vi.fn().mockResolvedValue(undefined),
    viewRevision: vi.fn().mockResolvedValue(undefined),
    selectRevision: vi.fn().mockResolvedValue(undefined),
    reprocess: vi.fn().mockResolvedValue(undefined),
    applyProtectedTermReview: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("Trust History response parsing", () => {
  it("accepts bounded immutable revisions and processing receipts", () => {
    const parsed = parseTrustHistory({
      recordingId: "rec_1",
      currentRevisionId: "revision_2",
      immutableRevisions: true,
      originalAudioRetained: true,
      revisions: [{
        revisionId: "revision_2",
        version: 2,
        source: "reprocess",
        engine: "whisper.cpp",
        modelId: "local-medium",
        createdAtMs: 42,
        rawComparisonAvailable: true,
        comparison: { rawTextSha256: rawHash, normalizedTextSha256: normalizedHash, rawTextBytes: 20, normalizedTextBytes: 18, rawSegmentCount: 2, normalizedSegmentCount: 2, changed: true },
      }],
      processingReceipts: [{ receiptId: "receipt_1", attempt: 1, operation: "transcription", outcome: "succeeded", engine: "whisper.cpp", elapsedMs: 500 }],
    });
    expect(parsed).toMatchObject({ recordingId: "rec_1", currentRevisionId: "revision_2", immutableRevisions: true, originalAudioRetained: true });
    expect(parsed?.revisions[0]).toMatchObject({ revisionId: "revision_2", source: "reprocess", comparison: { changed: true, rawTextBytes: 20 } });
    expect(parsed?.processingReceipts[0]).toMatchObject({ receiptId: "receipt_1", outcome: "succeeded", elapsedMs: 500 });
  });

  it("rejects malformed roots and skips malformed transcript segments", () => {
    expect(parseTrustHistory({ revisions: [] })).toBeNull();
    expect(parseTranscriptRevisionDetail({
      recordingId: "rec_1",
      current: false,
      revision: { revisionId: "revision_1", version: 1, source: "initial", engine: "local" },
      segmentCount: 1,
      returnedSegmentCount: 1,
      hasMore: false,
      segments: [{ startMs: 0, text: "Readable" }, { startMs: 1 }, null],
      comparisonView: {
        available: false,
        reason: "legacy-revision",
        maxTextBytesPerSide: 65_536,
        encryptedAtRest: false,
        rawPathExposed: false,
        keyMaterialExposedToRenderer: false,
      },
    })?.segments).toEqual([{ startMs: 0, endMs: null, speaker: null, text: "Readable" }]);
  });

  it("accepts a bounded core-owned protected-term preview", () => {
    const parsed = parseProtectedTermReview({
      implemented: true,
      recordingId: "rec_1",
      revisionId: "revision_2",
      ruleSetId: "protected-names",
      ruleSetVersion: 2,
      reviewRequired: true,
      replacementCount: 1,
      changes: [{ ruleId: "name", ruleOrder: 1, replacementCount: 1, protectedTermReview: true }],
      changedSegmentCount: 1,
      previewSegments: [{
        channel: "mic",
        speaker: "Speaker 1",
        startMs: 4_000,
        durationMs: 3_000,
        before: "Acme met us.",
        after: "ACME met us.",
        beforeTruncated: false,
        afterTruncated: false,
      }],
      previewTruncated: false,
      previewToken: "a".repeat(64),
      durableApplyCreatesRevision: true,
      rendererSuppliedTranscriptAccepted: false,
      captureTimeRuleSnapshotUsed: true,
      localOnly: true,
      networkAttempted: false,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    });
    expect(parsed).toMatchObject({ reviewRequired: true, replacementCount: 1, ruleSetId: "protected-names" });
    expect(parsed?.previewSegments[0]).toMatchObject({ before: "Acme met us.", after: "ACME met us." });
  });
});

describe("Trust History renderer", () => {
  it("makes original-audio reprocessing and non-overwrite behavior explicit", () => {
    const markup = renderToStaticMarkup(<TrustHistoryView controller={controller()} />);
    expect(markup).toContain("Reprocess original audio");
    expect(markup).toContain("creates a new revision");
    expect(markup).toContain("never overwrites an existing transcript");
    expect(markup).toContain("Use as current transcript");
    expect(markup).toContain("Selected as current");
  });

  it("shows comparison metadata, transcript content, timing, model, and processing errors", () => {
    const markup = renderToStaticMarkup(<TrustHistoryView controller={controller()} />);
    expect(markup).toContain("Raw versus normalized transcript metadata");
    expect(markup).toContain("Raw versus normalized text");
    expect(markup).toContain("teh locally stored transcript segment");
    expect(markup).toContain("A locally stored transcript segment.");
    expect(markup).toContain("1,200 bytes");
    expect(markup).toContain("local-medium");
    expect(markup).toContain("2.10 s");
    expect(markup).toContain("MODEL_UNAVAILABLE");
    expect(markup).toContain("A locally stored transcript segment.");
    expect(markup).toContain("Speaker 1");
  });

  it("shows exact protected-term changes and requires explicit revision creation", () => {
    const markup = renderToStaticMarkup(<TrustHistoryView controller={controller({
      protectedTermReview: {
        recordingId: "rec_1",
        revisionId: "revision_2",
        ruleSetId: "protected-names",
        ruleSetVersion: 2,
        reviewRequired: true,
        replacementCount: 1,
        changes: [{ ruleId: "name", ruleOrder: 1, replacementCount: 1 }],
        changedSegmentCount: 1,
        previewSegments: [{
          channel: "mic",
          speaker: "Speaker 1",
          startMs: 4_000,
          durationMs: 3_000,
          before: "Acme met us.",
          after: "ACME met us.",
          beforeTruncated: false,
          afterTruncated: false,
        }],
        previewTruncated: false,
        previewToken: "a".repeat(64),
      },
    })} />);
    expect(markup).toContain("Protected-term review");
    expect(markup).toContain("Acme met us.");
    expect(markup).toContain("ACME met us.");
    expect(markup).toContain("Apply in a new revision");
    expect(markup).toContain("current revision is retained");
  });

  it("uses honest loading, empty, and unavailable-audio states", () => {
    expect(renderToStaticMarkup(<TrustHistoryView controller={controller({ history: null, viewedRevision: null, loading: true })} />)).toContain("Loading transcript history");
    expect(renderToStaticMarkup(<TrustHistoryView controller={controller({ history: null, viewedRevision: null, error: "History could not be decrypted." })} />)).toContain("History could not be decrypted.");
    const noAudio = controller();
    noAudio.history = noAudio.history ? { ...noAudio.history, originalAudioRetained: false, revisions: [], processingReceipts: [] } : null;
    const markup = renderToStaticMarkup(<TrustHistoryView controller={noAudio} />);
    expect(markup).toContain("Original audio is not retained");
    expect(markup).toContain("No transcript revision has been created yet.");
    expect(markup).toContain("No processing receipt was recorded");
    expect(markup).toContain("disabled");
  });
});

describe("Trust History reprocessing", () => {
  function reprocessApi(job: Record<string, unknown>) {
    const jobId = "a".repeat(32);
    return {
      jobId,
      api: {
        transcript: { reprocess: vi.fn().mockResolvedValue({ jobId, state: "queued" }) },
        app: {
          getJob: vi.fn().mockResolvedValue({ jobId, ...job }),
          acknowledgeJob: vi.fn().mockResolvedValue(undefined),
        },
        ai: { cancel: vi.fn().mockResolvedValue(undefined) },
        events: { subscribe: vi.fn().mockReturnValue(() => undefined) },
      } as unknown as NonNullable<Window["candor"]>,
    };
  }

  it("waits for terminal success and reports completed progress", async () => {
    const fixture = reprocessApi({ state: "completed", terminal: true, result: { revisionId: "tr-2" } });
    const progress = vi.fn();
    await expect(runReprocessJob(fixture.api, "rec_1", progress)).resolves.toEqual({
      jobId: fixture.jobId,
      state: "completed",
    });
    expect(fixture.api.transcript.reprocess).toHaveBeenCalledWith({ recordingId: "rec_1" });
    expect(progress).toHaveBeenCalledWith({ jobId: fixture.jobId, state: "queued" });
    expect(progress).toHaveBeenLastCalledWith({ jobId: fixture.jobId, state: "completed" });
    expect(fixture.api.app.acknowledgeJob).toHaveBeenCalledWith(fixture.jobId);
  });

  it("keeps a terminal failure visible to the caller", async () => {
    const fixture = reprocessApi({
      state: "failed",
      terminal: true,
      error: { code: "MODEL_UNAVAILABLE", message: "Local model unavailable", retryable: true },
    });
    const progress = vi.fn();
    await expect(runReprocessJob(fixture.api, "rec_1", progress)).rejects.toThrow("Local model unavailable");
    expect(progress).toHaveBeenLastCalledWith({ jobId: fixture.jobId, state: "failed" });
  });
});
