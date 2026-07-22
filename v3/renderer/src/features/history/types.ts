export type TranscriptComparison = {
  rawTextSha256: string;
  normalizedTextSha256: string;
  rawTextBytes: number;
  normalizedTextBytes: number;
  rawSegmentCount: number;
  normalizedSegmentCount: number;
  changed: boolean;
};

export type TranscriptRevision = {
  revisionId: string;
  version: number;
  source: "initial" | "reprocess" | "import" | "review" | "ai-cleanup" | "unknown";
  kind: "raw-asr" | "normalized" | "ai-cleaned" | "legacy" | "unknown";
  parentRevisionId: string | null;
  engine: string;
  modelId: string | null;
  modelSha256: string | null;
  createdAtMs: number;
  comparison: TranscriptComparison | null;
  rawComparisonAvailable: boolean;
};

export type TranscriptComparisonView = {
  available: boolean;
  rawText: string | null;
  normalizedText: string | null;
  rawTextTruncated: boolean;
  normalizedTextTruncated: boolean;
  maxTextBytesPerSide: number;
  encryptedAtRest: boolean;
  reason: "legacy-revision" | null;
};

export type ProcessingReceipt = {
  receiptId: string;
  attempt: number;
  operation: string;
  stage: "transcription" | "normalization" | "cleanup" | "recap" | "unknown";
  outcome: "succeeded" | "failed" | "cancelled" | "unknown";
  engine: string;
  modelId: string | null;
  modelSha256: string | null;
  revisionId: string | null;
  inputRevisionId: string | null;
  inputRevisionKind: TranscriptRevision["kind"] | null;
  promptTemplateSha256: string | null;
  validationResult: "passed" | "failed" | "not-applicable" | "unknown";
  fallbackApplied: boolean;
  errorCode: string | null;
  errorSummary: string | null;
  startedAtMs: number;
  finishedAtMs: number;
  elapsedMs: number;
  comparison: TranscriptComparison | null;
};

export type TrustHistory = {
  recordingId: string;
  currentRevisionId: string | null;
  currentCleanedRevisionId: string | null;
  revisions: TranscriptRevision[];
  processingReceipts: ProcessingReceipt[];
  immutableRevisions: boolean;
  originalAudioRetained: boolean;
};

export type TranscriptSegment = {
  startMs: number | null;
  endMs: number | null;
  speaker: string | null;
  text: string;
};

export type TranscriptRevisionDetail = {
  recordingId: string;
  revision: TranscriptRevision;
  current: boolean;
  currentCleaned: boolean;
  segmentCount: number;
  returnedSegmentCount: number;
  hasMore: boolean;
  segments: TranscriptSegment[];
  comparisonView: TranscriptComparisonView;
};

export type ReprocessJob = {
  jobId: string;
  state: string;
};

export type ProtectedTermChange = {
  ruleId: string;
  ruleOrder: number;
  replacementCount: number;
};

export type ProtectedTermPreviewSegment = {
  channel: string;
  speaker: string | null;
  startMs: number;
  durationMs: number;
  before: string;
  after: string;
  beforeTruncated: boolean;
  afterTruncated: boolean;
};

export type ProtectedTermReview = {
  recordingId: string;
  revisionId: string | null;
  ruleSetId: string | null;
  ruleSetVersion: number | null;
  reviewRequired: boolean;
  replacementCount: number;
  changes: ProtectedTermChange[];
  changedSegmentCount: number;
  previewSegments: ProtectedTermPreviewSegment[];
  previewTruncated: boolean;
  previewToken: string | null;
};

export type TrustHistoryController = {
  history: TrustHistory | null;
  viewedRevision: TranscriptRevisionDetail | null;
  loading: boolean;
  revisionLoading: boolean;
  busy: boolean;
  error: string;
  notice: string;
  reprocessJob: ReprocessJob | null;
  protectedTermReview: ProtectedTermReview | null;
  refreshHistory(): Promise<void>;
  viewRevision(revisionId: string): Promise<void>;
  selectRevision(revisionId: string): Promise<void>;
  reprocess(): Promise<void>;
  applyProtectedTermReview(): Promise<void>;
};
