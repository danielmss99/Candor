export type LocalJsonValue =
  | null
  | boolean
  | number
  | string
  | LocalJsonValue[]
  | { [key: string]: LocalJsonValue };

export type JsonObject = Record<string, LocalJsonValue>;
export type AiMode = "local-llm" | "heuristic-fallback";
export type InstructAssetKind = "runner" | "model";
export type AppView = "home" | "meeting" | "library" | "detail" | "review" | "settings" | "export";
export type DetailSection = "summary" | "transcript" | "notes" | "history";
export type SettingsSection = "general" | "recording" | "profiles" | "models" | "storage" | "privacy" | "diagnostics" | "export" | "license";
export type ReviewSection = "summary" | "decisions" | "actions" | "questions" | "risks" | "notes" | "transcript" | "preview";
export type LibraryFilter = "all" | "transcribed" | "audio";
export type OnboardingStep = "activate" | "yours" | "microphone" | "shortcut" | "system-audio" | "storage" | "local-ai" | "app";
export type ExportFormat = "markdown" | "docx" | "pdf";
export type ExportPaperSize = "letter" | "a4";
export type CompactMeetingPane = "transcript" | "notes" | "ai";

export const EXPECTED_PROTOCOL_VERSION = "m0-jsonrpc-stdio-1";
export const DEFAULT_MODEL = "small.en";
export const LIBRARY_PAGE_SIZE = 50;
export const TRANSCRIPT_PAGE_SIZE = 100;

export interface RecordingSummary {
  recordingId: string;
  label: string;
  state: string;
  audioDurationMs: number;
  audioChunkCount: number;
  transcriptSegmentCount: number;
  updatedAtMs: number;
}

export interface RecordingPage {
  recordings: RecordingSummary[];
  quarantinedRecordings: QuarantinedRecording[];
  quarantinedCount: number;
  offset: number;
  limit: number;
  totalCount: number;
  hasMore: boolean;
}

export interface QuarantinedRecording {
  recordingId: string;
  reasonCode: string;
  receiptPersisted: boolean;
  contentModified: boolean;
}

export interface PersistentAlert {
  id: string;
  severity: "info" | "warning" | "error";
  title: string;
  message: string;
  actions?: Array<{ label: string; primary?: boolean; onActivate: () => void }>;
}

export interface TranscriptSegment {
  index: number;
  channel: string;
  speaker: string;
  text: string;
  startMs: number;
  endMs: number;
  confidence?: number;
}

export interface TranscriptPage {
  recordingId: string;
  segments: TranscriptSegment[];
  offset: number;
  limit: number;
  segmentCount: number;
  hasMore: boolean;
  durationMs: number;
}

export interface MarkedMoment {
  id: string;
  timeMs: number;
  label: string;
}

export interface ModelRow {
  modelId: string;
  language: string;
  installed: boolean;
  verified: boolean;
  bytes: number;
  failureCode: string;
}

export type TranscriptionQualityTier = "fast" | "balanced" | "maximum";
export type TranscriptionLanguagePreference = "english" | "multilingual";
export type TranscriptionBenchmarkState = "checking" | "not-run" | "measured" | "failed" | "unavailable";

export interface TranscriptionQualityOption {
  id: TranscriptionQualityTier;
  label: string;
  available: boolean;
  recommended: boolean;
  guardReason: string | null;
}

export interface TranscriptionQualityStatus {
  state: "checking" | "ready" | "corrupt";
  tier: TranscriptionQualityTier;
  languagePreference: TranscriptionLanguagePreference;
  recommendedTier: TranscriptionQualityTier;
  benchmarkState: TranscriptionBenchmarkState;
  benchmarkFailureTier: "balanced" | "maximum" | null;
  estimatedRealTimeFactor: number | null;
  estimatedMinutesPerHour: number | null;
  estimatedCompletionAvailable: boolean;
  fallbackApplied: boolean;
  guardReason: string | null;
  tiers: TranscriptionQualityOption[];
}

export interface TerminologyDictionaryRow {
  dictionaryId: string;
  name: string;
  enabled: boolean;
  assignedToRecording: boolean;
  entryCount: number;
  packageId: string | null;
  packageVersion: string | null;
  publisher: string | null;
  language: string | null;
  signatureKeyId: string | null;
  trustLabel: string | null;
  signatureVerified: boolean;
  scope: "meeting" | "project" | "organization" | "personal" | "specialist" | "general";
  scopeTargetId: string | null;
  explicitPreference: number;
  approvedCorrectionCount: number;
}

export interface TerminologyStatus {
  state: "ready" | "corrupt" | "unavailable";
  dictionaryCount: number;
  entryCount: number;
  dictionaries: TerminologyDictionaryRow[];
  encryptedAtRest: boolean;
  projectScopeAvailable: false;
}

export interface TerminologyCorrectionProposal {
  proposalId: string;
  dictionaryId: string;
  original: string;
  proposed: string;
  sourceSegmentId: string;
  sourceSegmentIndex: number;
  startMs: number;
  confidence: "high" | "medium";
  risk: "high" | "standard";
  numericMutation: boolean;
  requiresApproval: true;
  autoApply: false;
}

export type BundledAssetState =
  | "checking"
  | "ready"
  | "missing"
  | "corrupt"
  | "incompatible"
  | "repair-required"
  | "disabled"
  | "unavailable"
  | "no-default-selected";

export interface BundledCapabilityStatus {
  state: BundledAssetState;
  ready: boolean;
  available: boolean;
  requiredAssets: number;
  verifiedAssets: number;
  modelId: string | null;
  failureCode: string | null;
}

export interface BundledAiStatus {
  releaseReady: boolean;
  fixture: boolean;
  selectionStatus: string;
  state: BundledAssetState;
  ready: boolean;
  repairRequired: boolean;
  repairPolicy: "signed-installer-only";
  repairAction: "reinstall-candor" | "none";
  speech: BundledCapabilityStatus;
  language: BundledCapabilityStatus;
}

export interface RecapItem {
  category: string;
  text: string;
  speaker: string;
  channel: string;
  startMs: number;
  segmentIndex: number;
  quote: string;
  confidence?: "high" | "medium" | "low";
}

export interface LocalAiRecap {
  engine: string;
  summary: string;
  markdown: string;
  decisions: RecapItem[];
  actions: RecapItem[];
  risks: RecapItem[];
  questions: RecapItem[];
  citations: RecapItem[];
  provenance: AiProvenance;
}

export interface LocalAiAnswer {
  engine: string;
  question: string;
  answer: string;
  answerFound: boolean;
  intent: string;
  citations: RecapItem[];
  provenance: AiProvenance;
}

export interface AiProvenance {
  engine: "local-llm" | "heuristic";
  modelId: string | null;
  modelSha256: string | null;
  runtimeSha256: string | null;
  fallbackUsed: boolean;
  fallbackReason: "llm-unavailable" | "runtime-failed" | "model-corrupt" | "resource-policy" | "user-requested" | null;
  promptVersion: string;
  generatedAt: string;
}

export interface NetworkCapability {
  id: string;
  label: string;
  mode: "denied" | "disabled" | "local-only";
  trigger: string;
  owner: string;
}

export interface NetworkCapabilities {
  policy: string;
  externalCallsAttempted: number;
  capabilities: NetworkCapability[];
}

export interface PrivacyEvent {
  eventType: "transcription" | "local-ai-recap" | "local-ai-ask" | "export";
  engine: string | null;
  modelId: string | null;
  sha256: string | null;
  format: string | null;
  bytes: number | null;
  aiProvenance: AiProvenance | null;
  createdAtMs: number;
}

export interface MeetingPrivacyReceipt {
  proofKind: "meeting-privacy-receipt";
  receiptVersion: number;
  generatedAtMs: number;
  recording: {
    recordingId: string;
    label: string;
    state: string;
    createdAtMs: number;
    updatedAtMs: number;
    deletionStatus: string;
  };
  capture: {
    channels: string[];
    audioChunkCount: number;
    channelAttribution: boolean;
  };
  storage: {
    rootKind: string;
    encryptedAudioChunkCount: number;
    allAudioEncrypted: boolean;
    cipher: string | null;
  };
  content: {
    transcriptSegmentCount: number;
    notesSavedLocally: boolean;
  };
  processing: PrivacyEvent[];
  exports: PrivacyEvent[];
  retention: {
    policy: string;
    automaticDeletion: boolean;
  };
  network: NetworkCapabilities;
}

export class ProtocolValidationError extends Error {
  readonly field: string;

  constructor(field: string, expectation: string) {
    super(`Candor protocol error at ${field}: expected ${expectation}`);
    this.name = "ProtocolValidationError";
    this.field = field;
  }
}

export function expectObject(value: unknown, field: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolValidationError(field, "an object");
  }
  return value as JsonObject;
}

export function expectArray(value: unknown, field: string): LocalJsonValue[] {
  if (!Array.isArray(value)) throw new ProtocolValidationError(field, "an array");
  return value as LocalJsonValue[];
}

export function optionalObject(value: unknown, field: string): JsonObject {
  if (value === null || value === undefined) return {};
  return expectObject(value, field);
}

export function optionalArray(value: unknown, field: string): LocalJsonValue[] {
  if (value === null || value === undefined) return [];
  return expectArray(value, field);
}

export function stringField(value: unknown, field: string, fallback?: string): string {
  if (value === null || value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new ProtocolValidationError(field, "a string");
  }
  if (typeof value !== "string") throw new ProtocolValidationError(field, "a string");
  return value;
}

export function numberField(value: unknown, field: string, fallback?: number): number {
  if (value === null || value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new ProtocolValidationError(field, "a finite number");
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ProtocolValidationError(field, "a finite number");
  }
  return value;
}

export function booleanField(value: unknown, field: string, fallback?: boolean): boolean {
  if (value === null || value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new ProtocolValidationError(field, "a boolean");
  }
  if (typeof value !== "boolean") throw new ProtocolValidationError(field, "a boolean");
  return value;
}

export function nullableStringField(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return stringField(value, field);
}

export function nullableNumberField(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  return numberField(value, field);
}

export function asObject(value: unknown): JsonObject {
  return optionalObject(value, "renderer response object");
}

export function asArray(value: unknown): LocalJsonValue[] {
  return optionalArray(value, "renderer response array");
}

export function asString(value: unknown, fallback = ""): string {
  return stringField(value, "renderer response string", fallback);
}

export function asNumber(value: unknown, fallback = 0): number {
  return numberField(value, "renderer response number", fallback);
}

export function asBool(value: unknown): boolean {
  return booleanField(value, "renderer response boolean", false);
}

export function parseProtocolVersion(value: unknown): { version: string; protocolVersion: string } {
  const object = expectObject(value, "core.version");
  const protocolVersion = stringField(object.protocolVersion, "core.version.protocolVersion");
  if (protocolVersion !== EXPECTED_PROTOCOL_VERSION) {
    throw new ProtocolValidationError(
      "core.version.protocolVersion",
      EXPECTED_PROTOCOL_VERSION,
    );
  }
  return {
    version: stringField(object.version, "core.version.version"),
    protocolVersion,
  };
}

export function parseRecordingPage(value: unknown): RecordingPage {
  const object = expectObject(value, "recording.durable.listPage");
  const recordings = expectArray(object.recordings, "recording.durable.listPage.recordings")
    .map((item, index) => {
      const row = expectObject(item, `recording.durable.listPage.recordings[${index}]`);
      const recordingId = stringField(row.recordingId, `recordings[${index}].recordingId`);
      return {
        recordingId,
        label: stringField(row.label, `recordings[${index}].label`, recordingId || "Untitled meeting"),
        state: stringField(row.state, `recordings[${index}].state`),
        audioDurationMs: numberField(row.audioDurationMs, `recordings[${index}].audioDurationMs`),
        audioChunkCount: numberField(row.audioChunkCount, `recordings[${index}].audioChunkCount`),
        transcriptSegmentCount: numberField(row.transcriptSegmentCount, `recordings[${index}].transcriptSegmentCount`),
        updatedAtMs: numberField(row.updatedAtMs, `recordings[${index}].updatedAtMs`),
      };
    });
  const quarantinedRecordings = optionalArray(
    object.quarantinedRecordings,
    "recording.durable.listPage.quarantinedRecordings",
  ).map((item, index) => {
    const row = expectObject(item, `recording.durable.listPage.quarantinedRecordings[${index}]`);
    return {
      recordingId: stringField(row.recordingId, `quarantinedRecordings[${index}].recordingId`),
      reasonCode: stringField(row.reasonCode, `quarantinedRecordings[${index}].reasonCode`),
      receiptPersisted: booleanField(row.receiptPersisted, `quarantinedRecordings[${index}].receiptPersisted`, false),
      contentModified: booleanField(row.contentModified, `quarantinedRecordings[${index}].contentModified`, false),
    };
  });
  return {
    recordings,
    quarantinedRecordings,
    quarantinedCount: numberField(object.quarantinedCount, "recording.durable.listPage.quarantinedCount", quarantinedRecordings.length),
    offset: numberField(object.offset, "recording.durable.listPage.offset"),
    limit: numberField(object.limit, "recording.durable.listPage.limit"),
    totalCount: numberField(object.totalCount, "recording.durable.listPage.totalCount"),
    hasMore: booleanField(object.hasMore, "recording.durable.listPage.hasMore"),
  };
}

function parseTranscriptSegment(value: unknown, index: number): TranscriptSegment {
  const object = expectObject(value, `recording.durable.transcriptPage.segments[${index}]`);
  const confidence = object.confidence === null || object.confidence === undefined
    ? undefined
    : numberField(object.confidence, `segments[${index}].confidence`);
  return {
    index: numberField(object.index, `segments[${index}].index`),
    channel: stringField(object.channel, `segments[${index}].channel`),
    speaker: stringField(object.speaker, `segments[${index}].speaker`, "Speaker"),
    text: stringField(object.text, `segments[${index}].text`),
    startMs: numberField(object.startMs, `segments[${index}].startMs`),
    endMs: numberField(object.endMs, `segments[${index}].endMs`),
    confidence,
  };
}

export function parseTranscriptPage(value: unknown): TranscriptPage {
  const object = expectObject(value, "recording.durable.transcriptPage");
  return {
    recordingId: stringField(object.recordingId, "recording.durable.transcriptPage.recordingId"),
    segments: expectArray(object.segments, "recording.durable.transcriptPage.segments")
      .map(parseTranscriptSegment),
    offset: numberField(object.offset, "recording.durable.transcriptPage.offset"),
    limit: numberField(object.limit, "recording.durable.transcriptPage.limit"),
    segmentCount: numberField(object.segmentCount, "recording.durable.transcriptPage.segmentCount"),
    hasMore: booleanField(object.hasMore, "recording.durable.transcriptPage.hasMore"),
    durationMs: numberField(object.durationMs, "recording.durable.transcriptPage.durationMs"),
  };
}

export function parseModels(value: unknown): ModelRow[] {
  const object = expectObject(value, "models.status");
  return expectArray(object.models, "models.status.models").map((item, index) => {
    const model = expectObject(item, `models.status.models[${index}]`);
    return {
      modelId: stringField(model.modelId, `models[${index}].modelId`),
      language: stringField(model.language, `models[${index}].language`),
      installed: booleanField(model.installed, `models[${index}].installed`),
      verified: booleanField(model.verified, `models[${index}].verified`),
      bytes: numberField(model.bytes, `models[${index}].bytes`, 0),
      failureCode: stringField(model.failureCode, `models[${index}].failureCode`, ""),
    };
  });
}

const TRANSCRIPTION_QUALITY_TIERS = new Set<TranscriptionQualityTier>([
  "fast",
  "balanced",
  "maximum",
]);

function transcriptionQualityTier(value: unknown, field: string): TranscriptionQualityTier {
  const tier = stringField(value, field) as TranscriptionQualityTier;
  if (!TRANSCRIPTION_QUALITY_TIERS.has(tier)) {
    throw new ProtocolValidationError(field, "fast, balanced, or maximum");
  }
  return tier;
}

export function parseTranscriptionQualityStatus(value: unknown): TranscriptionQualityStatus {
  const object = expectObject(value, "transcription.quality.status");
  if (
    object.implemented !== true
    || object.localOnly !== true
    || object.cloudAi !== false
    || object.rawModelNamesExposed !== false
    || object.rawPathExposed !== false
    || object.keyMaterialExposedToRenderer !== false
  ) {
    throw new ProtocolValidationError(
      "transcription.quality.status",
      "a local-only pathless quality policy without raw model exposure",
    );
  }
  expectObject(object.hardware, "transcription.quality.status.hardware");
  const state = stringField(object.state, "transcription.quality.status.state");
  if (state !== "ready" && state !== "corrupt") {
    throw new ProtocolValidationError("transcription.quality.status.state", "ready or corrupt");
  }
  const languagePreference = stringField(
    object.languagePreference,
    "transcription.quality.status.languagePreference",
  );
  if (languagePreference !== "english" && languagePreference !== "multilingual") {
    throw new ProtocolValidationError(
      "transcription.quality.status.languagePreference",
      "english or multilingual",
    );
  }
  const tiers = optionalArray(object.tiers, "transcription.quality.status.tiers")
    .map((item, index): TranscriptionQualityOption => {
      const option = expectObject(item, `transcription.quality.status.tiers[${index}]`);
      return {
        id: transcriptionQualityTier(option.id, `transcription.quality.status.tiers[${index}].id`),
        label: stringField(option.label, `transcription.quality.status.tiers[${index}].label`),
        available: booleanField(option.available, `transcription.quality.status.tiers[${index}].available`),
        recommended: booleanField(option.recommended, `transcription.quality.status.tiers[${index}].recommended`),
        guardReason: nullableStringField(option.guardReason, `transcription.quality.status.tiers[${index}].guardReason`),
      };
    });
  if (tiers.length !== 3 || new Set(tiers.map((tier) => tier.id)).size !== 3) {
    throw new ProtocolValidationError(
      "transcription.quality.status.tiers",
      "one Fast, Balanced, and Maximum option",
    );
  }
  const benchmarkState = stringField(
    object.benchmarkState,
    "transcription.quality.status.benchmarkState",
  ) as TranscriptionBenchmarkState;
  if (!new Set(["not-run", "measured", "failed", "unavailable"]).has(benchmarkState)) {
    throw new ProtocolValidationError(
      "transcription.quality.status.benchmarkState",
      "not-run, measured, failed, or unavailable",
    );
  }
  const benchmarkFailureTier = nullableStringField(
    object.benchmarkFailureTier,
    "transcription.quality.status.benchmarkFailureTier",
  );
  if (benchmarkFailureTier !== null
      && benchmarkFailureTier !== "balanced"
      && benchmarkFailureTier !== "maximum") {
    throw new ProtocolValidationError(
      "transcription.quality.status.benchmarkFailureTier",
      "balanced, maximum, or null",
    );
  }
  const estimatedMinutesPerHour = nullableNumberField(
    object.estimatedMinutesPerHour,
    "transcription.quality.status.estimatedMinutesPerHour",
  );
  if (estimatedMinutesPerHour !== null && (
    !Number.isSafeInteger(estimatedMinutesPerHour)
    || estimatedMinutesPerHour < 1
    || estimatedMinutesPerHour > 60
  )) {
    throw new ProtocolValidationError(
      "transcription.quality.status.estimatedMinutesPerHour",
      "an integer from 1 through 60, or null",
    );
  }
  const estimatedRealTimeFactor = nullableNumberField(
    object.estimatedRealTimeFactor,
    "transcription.quality.status.estimatedRealTimeFactor",
  );
  if (estimatedRealTimeFactor !== null) {
    throw new ProtocolValidationError(
      "transcription.quality.status.estimatedRealTimeFactor",
      "null because raw benchmark measurements are diagnostics-only",
    );
  }
  const estimatedCompletionAvailable = booleanField(
    object.estimatedCompletionAvailable,
    "transcription.quality.status.estimatedCompletionAvailable",
  );
  if (estimatedCompletionAvailable !== (estimatedMinutesPerHour !== null)) {
    throw new ProtocolValidationError(
      "transcription.quality.status.estimatedCompletionAvailable",
      "a value consistent with the rounded completion estimate",
    );
  }
  return {
    state,
    tier: transcriptionQualityTier(object.tier, "transcription.quality.status.tier"),
    languagePreference,
    recommendedTier: transcriptionQualityTier(
      object.recommendedTier,
      "transcription.quality.status.recommendedTier",
    ),
    benchmarkState,
    benchmarkFailureTier,
    estimatedRealTimeFactor,
    estimatedMinutesPerHour,
    estimatedCompletionAvailable,
    fallbackApplied: booleanField(
      object.fallbackApplied,
      "transcription.quality.status.fallbackApplied",
    ),
    guardReason: nullableStringField(object.guardReason, "transcription.quality.status.guardReason"),
    tiers,
  };
}

export function parseTerminologyStatus(value: unknown): TerminologyStatus {
  const object = expectObject(value, "terminology.status");
  if (
    object.implemented !== true
    || object.localOnly !== true
    || object.cloudAi !== false
    || object.promptWritingRequired !== false
    || object.automaticCorrection !== false
    || object.rawPathExposed !== false
    || object.keyMaterialExposedToRenderer !== false
  ) {
    throw new ProtocolValidationError(
      "terminology.status",
      "an automatic, local-only, pathless dictionary policy without automatic correction",
    );
  }
  const state = stringField(object.state, "terminology.status.state");
  if (state !== "ready" && state !== "corrupt" && state !== "unavailable") {
    throw new ProtocolValidationError("terminology.status.state", "ready, corrupt, or unavailable");
  }
  const dictionaries = expectArray(object.dictionaries, "terminology.status.dictionaries")
    .map((item, index): TerminologyDictionaryRow => {
      const dictionary = expectObject(item, `terminology.status.dictionaries[${index}]`);
      const scope = stringField(dictionary.scope, `terminology.status.dictionaries[${index}].scope`);
      if (!new Set(["meeting", "project", "organization", "personal", "specialist", "general"]).has(scope)) {
        throw new ProtocolValidationError(
          `terminology.status.dictionaries[${index}].scope`,
          "meeting, project, organization, personal, specialist, or general",
        );
      }
      const signatureVerified = booleanField(
        dictionary.signatureVerified,
        `terminology.status.dictionaries[${index}].signatureVerified`,
      );
      const rawTrustLabel = nullableStringField(
        dictionary.trustLabel,
        `terminology.status.dictionaries[${index}].trustLabel`,
      );
      const trustLabel = rawTrustLabel === "verified-candor" && signatureVerified
        ? "verified-candor"
        : rawTrustLabel !== null || signatureVerified
          ? "community-unverified"
          : null;
      return {
        dictionaryId: stringField(dictionary.dictionaryId, `terminology.status.dictionaries[${index}].dictionaryId`),
        name: stringField(dictionary.name, `terminology.status.dictionaries[${index}].name`),
        enabled: booleanField(dictionary.enabled, `terminology.status.dictionaries[${index}].enabled`),
        assignedToRecording: booleanField(
          dictionary.assignedToRecording,
          `terminology.status.dictionaries[${index}].assignedToRecording`,
        ),
        entryCount: numberField(dictionary.entryCount, `terminology.status.dictionaries[${index}].entryCount`),
        packageId: nullableStringField(dictionary.packageId, `terminology.status.dictionaries[${index}].packageId`),
        packageVersion: nullableStringField(dictionary.packageVersion, `terminology.status.dictionaries[${index}].packageVersion`),
        publisher: nullableStringField(dictionary.publisher, `terminology.status.dictionaries[${index}].publisher`),
        language: nullableStringField(dictionary.language, `terminology.status.dictionaries[${index}].language`),
        signatureKeyId: nullableStringField(dictionary.signatureKeyId, `terminology.status.dictionaries[${index}].signatureKeyId`),
        trustLabel,
        signatureVerified,
        scope: scope as TerminologyDictionaryRow["scope"],
        scopeTargetId: nullableStringField(dictionary.scopeTargetId, `terminology.status.dictionaries[${index}].scopeTargetId`),
        explicitPreference: numberField(dictionary.explicitPreference, `terminology.status.dictionaries[${index}].explicitPreference`),
        approvedCorrectionCount: numberField(
          dictionary.approvedCorrectionCount,
          `terminology.status.dictionaries[${index}].approvedCorrectionCount`,
        ),
      };
    });
  return {
    state,
    dictionaryCount: numberField(object.dictionaryCount, "terminology.status.dictionaryCount"),
    entryCount: numberField(object.entryCount, "terminology.status.entryCount"),
    dictionaries,
    encryptedAtRest: booleanField(object.encryptedAtRest, "terminology.status.encryptedAtRest"),
    projectScopeAvailable: object.projectScopeAvailable === false
      ? false
      : (() => { throw new ProtocolValidationError("terminology.status.projectScopeAvailable", "false until projects have stable identifiers"); })(),
  };
}

export function parseTerminologyProposals(value: unknown): TerminologyCorrectionProposal[] {
  const object = expectObject(value, "terminology.proposals");
  if (
    object.automaticCorrection !== false
    || object.approvalRequired !== true
    || object.rawPathExposed !== false
    || object.keyMaterialExposedToRenderer !== false
  ) {
    throw new ProtocolValidationError(
      "terminology.proposals",
      "pathless correction proposals that always require approval",
    );
  }
  return expectArray(object.proposals, "terminology.proposals.proposals")
    .map((item, index): TerminologyCorrectionProposal => {
      const proposal = expectObject(item, `terminology.proposals.proposals[${index}]`);
      const confidence = stringField(proposal.confidence, `terminology.proposals.proposals[${index}].confidence`);
      const risk = stringField(proposal.risk, `terminology.proposals.proposals[${index}].risk`);
      if (confidence !== "high" && confidence !== "medium") {
        throw new ProtocolValidationError(`terminology.proposals.proposals[${index}].confidence`, "high or medium");
      }
      if (risk !== "high" && risk !== "standard") {
        throw new ProtocolValidationError(`terminology.proposals.proposals[${index}].risk`, "high or standard");
      }
      if (proposal.requiresApproval !== true || proposal.autoApply !== false) {
        throw new ProtocolValidationError(
          `terminology.proposals.proposals[${index}]`,
          "a proposal requiring explicit approval",
        );
      }
      return {
        proposalId: stringField(proposal.proposalId, `terminology.proposals.proposals[${index}].proposalId`),
        dictionaryId: stringField(proposal.dictionaryId, `terminology.proposals.proposals[${index}].dictionaryId`),
        original: stringField(proposal.original, `terminology.proposals.proposals[${index}].original`),
        proposed: stringField(proposal.proposed, `terminology.proposals.proposals[${index}].proposed`),
        sourceSegmentId: stringField(proposal.sourceSegmentId, `terminology.proposals.proposals[${index}].sourceSegmentId`),
        sourceSegmentIndex: numberField(proposal.sourceSegmentIndex, `terminology.proposals.proposals[${index}].sourceSegmentIndex`),
        startMs: numberField(proposal.startMs, `terminology.proposals.proposals[${index}].startMs`),
        confidence,
        risk,
        numericMutation: booleanField(proposal.numericMutation, `terminology.proposals.proposals[${index}].numericMutation`),
        requiresApproval: true,
        autoApply: false,
      };
    });
}

const BUNDLED_ASSET_STATES = new Set<BundledAssetState>([
  "checking",
  "ready",
  "missing",
  "corrupt",
  "incompatible",
  "repair-required",
  "disabled",
  "unavailable",
  "no-default-selected",
]);

function bundledAssetState(value: unknown, field: string): BundledAssetState {
  const state = stringField(value, field) as BundledAssetState;
  if (!BUNDLED_ASSET_STATES.has(state)) {
    throw new ProtocolValidationError(field, "a known bundled asset state");
  }
  return state;
}

function parseBundledCapability(value: unknown, field: string): BundledCapabilityStatus {
  const object = expectObject(value, field);
  const requiredAssets = numberField(object.requiredAssets, `${field}.requiredAssets`);
  const verifiedAssets = numberField(object.verifiedAssets, `${field}.verifiedAssets`);
  if (!Number.isSafeInteger(requiredAssets) || requiredAssets < 0) {
    throw new ProtocolValidationError(`${field}.requiredAssets`, "a non-negative integer");
  }
  if (!Number.isSafeInteger(verifiedAssets) || verifiedAssets < 0) {
    throw new ProtocolValidationError(`${field}.verifiedAssets`, "a non-negative integer");
  }
  const status = {
    state: bundledAssetState(object.state, `${field}.state`),
    ready: booleanField(object.ready, `${field}.ready`),
    available: booleanField(object.available, `${field}.available`),
    requiredAssets,
    verifiedAssets,
    modelId: nullableStringField(object.modelId, `${field}.modelId`),
    failureCode: nullableStringField(object.failureCode, `${field}.failureCode`),
  };
  if (status.ready !== (status.state === "ready") || (status.ready && !status.available)) {
    throw new ProtocolValidationError(field, "internally consistent capability readiness");
  }
  if (status.ready && (
    status.requiredAssets < 1
    || status.verifiedAssets < status.requiredAssets
    || status.modelId === null
  )) {
    throw new ProtocolValidationError(field, "verified required assets and a selected model when ready");
  }
  return status;
}

export function parseBundledAiStatus(value: unknown): BundledAiStatus {
  const object = expectObject(value, "ai.bundledAssetsStatus");
  if (
    object.implemented !== true
    || object.localOnly !== true
    || object.cloudAi !== false
    || object.requiredDownload !== false
    || object.backgroundDownloads !== false
    || object.runtimePathAcceptedFromRenderer !== false
    || object.rawPathExposed !== false
    || object.hashExposed !== false
    || object.keyMaterialExposedToRenderer !== false
  ) {
    throw new ProtocolValidationError(
      "ai.bundledAssetsStatus",
      "local-only readiness with no download, renderer path, hash, key, or filesystem exposure",
    );
  }
  const repairPolicy = stringField(object.repairPolicy, "ai.bundledAssetsStatus.repairPolicy");
  if (repairPolicy !== "signed-installer-only") {
    throw new ProtocolValidationError("ai.bundledAssetsStatus.repairPolicy", "signed-installer-only");
  }
  const repairAction = stringField(object.repairAction, "ai.bundledAssetsStatus.repairAction");
  if (repairAction !== "reinstall-candor" && repairAction !== "none") {
    throw new ProtocolValidationError("ai.bundledAssetsStatus.repairAction", "reinstall-candor or none");
  }
  const status: BundledAiStatus = {
    releaseReady: booleanField(object.releaseReady, "ai.bundledAssetsStatus.releaseReady"),
    fixture: booleanField(object.fixture, "ai.bundledAssetsStatus.fixture"),
    selectionStatus: stringField(object.selectionStatus, "ai.bundledAssetsStatus.selectionStatus"),
    state: bundledAssetState(object.state, "ai.bundledAssetsStatus.state"),
    ready: booleanField(object.ready, "ai.bundledAssetsStatus.ready"),
    repairRequired: booleanField(object.repairRequired, "ai.bundledAssetsStatus.repairRequired"),
    repairPolicy,
    repairAction,
    speech: parseBundledCapability(object.speech, "ai.bundledAssetsStatus.speech"),
    language: parseBundledCapability(object.language, "ai.bundledAssetsStatus.language"),
  };
  if (status.fixture && status.releaseReady) {
    throw new ProtocolValidationError("ai.bundledAssetsStatus", "a fixture that is never release-ready");
  }
  if (status.ready !== (status.speech.ready && status.language.ready)
      || status.ready !== (status.state === "ready")) {
    throw new ProtocolValidationError("ai.bundledAssetsStatus", "internally consistent aggregate readiness");
  }
  if (status.repairRequired !== (status.repairAction === "reinstall-candor")) {
    throw new ProtocolValidationError("ai.bundledAssetsStatus", "a repair action matching repairRequired");
  }
  return status;
}

function parseRecapItem(value: unknown, field: string): RecapItem {
  const object = expectObject(value, field);
  const confidence = object.confidence === undefined || object.confidence === null
    ? undefined
    : stringField(object.confidence, `${field}.confidence`);
  if (confidence !== undefined && confidence !== "high" && confidence !== "medium" && confidence !== "low") {
    throw new ProtocolValidationError(`${field}.confidence`, "high, medium, or low");
  }
  return {
    category: stringField(object.category, `${field}.category`, "evidence"),
    text: stringField(object.text, `${field}.text`),
    speaker: stringField(object.speaker, `${field}.speaker`, "Speaker"),
    channel: stringField(object.channel, `${field}.channel`, "mixed"),
    startMs: numberField(object.startMs, `${field}.startMs`, 0),
    segmentIndex: numberField(object.segmentIndex, `${field}.segmentIndex`, 0),
    quote: stringField(object.quote, `${field}.quote`, ""),
    ...(confidence ? { confidence } : {}),
  };
}

function parseCitation(value: unknown, field: string): RecapItem {
  const object = expectObject(value, field);
  const quote = stringField(object.quote, `${field}.quote`, "");
  const text = stringField(object.text, `${field}.text`, quote);
  if (!text.trim() && !quote.trim()) {
    throw new ProtocolValidationError(field, "a citation with text or quote");
  }
  return {
    category: stringField(object.category, `${field}.category`, "evidence"),
    text: text || quote,
    speaker: stringField(object.speaker, `${field}.speaker`, "Speaker"),
    channel: stringField(object.channel, `${field}.channel`, "mixed"),
    startMs: numberField(object.startMs, `${field}.startMs`, 0),
    segmentIndex: numberField(object.segmentIndex, `${field}.segmentIndex`, 0),
    quote: quote || text,
  };
}

function recapItems(object: JsonObject, key: string): RecapItem[] {
  return optionalArray(object[key], `ai.recap.${key}`)
    .map((item, index) => parseRecapItem(item, `ai.recap.${key}[${index}]`));
}

function parseAiProvenance(value: unknown, field: string): AiProvenance {
  const object = expectObject(value, field);
  const engine = stringField(object.engine, `${field}.engine`);
  if (engine !== "local-llm" && engine !== "heuristic") {
    throw new ProtocolValidationError(`${field}.engine`, "local-llm or heuristic");
  }
  const modelId = nullableStringField(object.modelId, `${field}.modelId`);
  const modelSha256 = nullableStringField(object.modelSha256, `${field}.modelSha256`);
  const runtimeSha256 = nullableStringField(object.runtimeSha256, `${field}.runtimeSha256`);
  const fallbackUsed = booleanField(object.fallbackUsed, `${field}.fallbackUsed`);
  const rawReason = nullableStringField(object.fallbackReason, `${field}.fallbackReason`);
  const reasons = ["llm-unavailable", "runtime-failed", "model-corrupt", "resource-policy", "user-requested"] as const;
  if (rawReason !== null && !reasons.includes(rawReason as typeof reasons[number])) {
    throw new ProtocolValidationError(`${field}.fallbackReason`, "an approved fallback reason");
  }
  if (fallbackUsed !== (rawReason !== null)) {
    throw new ProtocolValidationError(field, "fallback status matching its reason");
  }
  if (engine === "local-llm" && !modelId) {
    throw new ProtocolValidationError(`${field}.modelId`, "a local model identifier");
  }
  if (engine === "local-llm" && (!modelSha256 || !/^[a-f0-9]{64}$/.test(modelSha256))) {
    throw new ProtocolValidationError(`${field}.modelSha256`, "a verified model digest");
  }
  if (engine === "local-llm" && (!runtimeSha256 || !/^[a-f0-9]{64}$/.test(runtimeSha256))) {
    throw new ProtocolValidationError(`${field}.runtimeSha256`, "a verified runtime digest");
  }
  if (engine === "heuristic" && (modelId || modelSha256 || runtimeSha256)) {
    throw new ProtocolValidationError(field, "null model identity for heuristic output");
  }
  const generatedAt = stringField(object.generatedAt, `${field}.generatedAt`);
  if (Number.isNaN(Date.parse(generatedAt))) {
    throw new ProtocolValidationError(`${field}.generatedAt`, "an RFC 3339 timestamp");
  }
  return {
    engine,
    modelId,
    modelSha256,
    runtimeSha256,
    fallbackUsed,
    fallbackReason: rawReason as AiProvenance["fallbackReason"],
    promptVersion: stringField(object.promptVersion, `${field}.promptVersion`),
    generatedAt,
  };
}

export function parseRecap(value: unknown): LocalAiRecap {
  const object = expectObject(value, "ai.recap");
  const markdown = stringField(object.recapMarkdown, "ai.recap.recapMarkdown", "");
  const engine = stringField(object.engine, "ai.recap.engine");
  if (engine === "llama-cpp-local"
      && (object.strictOutputValidated !== true
        || object.outputSchemaVersion !== 1
        || object.groundingMethod !== "strict-source-id-and-exact-critical-evidence-v1")) {
    throw new ProtocolValidationError(
      "ai.recap",
      "strict source-linked Local AI output using schema version 1",
    );
  }
  return {
    engine,
    summary: stringField(object.summary, "ai.recap.summary", markdown ? "" : "No local recap yet."),
    markdown,
    decisions: recapItems(object, "decisions"),
    actions: recapItems(object, "actions"),
    risks: recapItems(object, "risks"),
    questions: recapItems(object, "questions"),
    citations: optionalArray(object.citations, "ai.recap.citations")
      .map((item, index) => parseCitation(item, `ai.recap.citations[${index}]`)),
    provenance: parseAiProvenance(object.provenance, "ai.recap.provenance"),
  };
}

export function parseAnswer(value: unknown): LocalAiAnswer {
  const object = expectObject(value, "ai.ask");
  const answer = stringField(object.answer, "ai.ask.answer");
  const engine = stringField(object.engine, "ai.ask.engine");
  if (engine === "llama-cpp-local"
      && (object.strictOutputValidated !== true
        || object.outputSchemaVersion !== 1
        || object.groundingMethod !== "strict-source-id-and-exact-critical-evidence-v1")) {
    throw new ProtocolValidationError(
      "ai.ask",
      "strict source-linked Local AI output using schema version 1",
    );
  }
  return {
    engine,
    question: stringField(object.question, "ai.ask.question", ""),
    answer,
    answerFound: booleanField(object.answerFound, "ai.ask.answerFound", Boolean(answer.trim())),
    intent: stringField(object.intent, "ai.ask.intent", engine === "llama-cpp-local" ? "cited local answer" : "general"),
    citations: optionalArray(object.citations, "ai.ask.citations")
      .map((item, index) => parseCitation(item, `ai.ask.citations[${index}]`)),
    provenance: parseAiProvenance(object.provenance, "ai.ask.provenance"),
  };
}

export function parseNetworkCapabilities(value: unknown): NetworkCapabilities {
  const object = expectObject(value, "privacy.capabilities");
  const capabilities = expectArray(object.capabilities, "privacy.capabilities.capabilities")
    .map((item, index) => {
      const capability = expectObject(item, `privacy.capabilities.capabilities[${index}]`);
      const rawMode = stringField(capability.mode, `capabilities[${index}].mode`);
      if (rawMode !== "denied" && rawMode !== "disabled" && rawMode !== "local-only") {
        throw new ProtocolValidationError(`capabilities[${index}].mode`, "denied, disabled, or local-only");
      }
      const mode: NetworkCapability["mode"] = rawMode;
      return {
        id: stringField(capability.id, `capabilities[${index}].id`),
        label: stringField(capability.label, `capabilities[${index}].label`),
        mode,
        trigger: stringField(capability.trigger, `capabilities[${index}].trigger`),
        owner: stringField(capability.owner, `capabilities[${index}].owner`),
      };
    });
  return {
    policy: stringField(object.policy, "privacy.capabilities.policy"),
    externalCallsAttempted: numberField(object.externalCallsAttempted, "privacy.capabilities.externalCallsAttempted"),
    capabilities,
  };
}

function parsePrivacyEvent(value: unknown, field: string): PrivacyEvent {
  const object = expectObject(value, field);
  const eventType = stringField(object.eventType, `${field}.eventType`);
  if (!(["transcription", "local-ai-recap", "local-ai-ask", "export"] as string[]).includes(eventType)) {
    throw new ProtocolValidationError(`${field}.eventType`, "a known privacy event type");
  }
  const aiProvenance = object.aiProvenance === null || object.aiProvenance === undefined
    ? null
    : parseAiProvenance(object.aiProvenance, `${field}.aiProvenance`);
  return {
    eventType: eventType as PrivacyEvent["eventType"],
    engine: nullableStringField(object.engine, `${field}.engine`),
    modelId: nullableStringField(object.modelId, `${field}.modelId`),
    sha256: nullableStringField(object.sha256, `${field}.sha256`),
    format: nullableStringField(object.format, `${field}.format`),
    bytes: nullableNumberField(object.bytes, `${field}.bytes`),
    aiProvenance,
    createdAtMs: numberField(object.createdAtMs, `${field}.createdAtMs`),
  };
}

export function parseMeetingPrivacyReceipt(value: unknown): MeetingPrivacyReceipt {
  const object = expectObject(value, "recording.privacyReceipt");
  const recording = expectObject(object.recording, "recording.privacyReceipt.recording");
  const capture = expectObject(object.capture, "recording.privacyReceipt.capture");
  const storage = expectObject(object.storage, "recording.privacyReceipt.storage");
  const content = expectObject(object.content, "recording.privacyReceipt.content");
  const retention = expectObject(object.retention, "recording.privacyReceipt.retention");
  const proofKind = stringField(object.proofKind, "recording.privacyReceipt.proofKind");
  if (proofKind !== "meeting-privacy-receipt") {
    throw new ProtocolValidationError("recording.privacyReceipt.proofKind", "meeting-privacy-receipt");
  }
  return {
    proofKind,
    receiptVersion: numberField(object.receiptVersion, "recording.privacyReceipt.receiptVersion"),
    generatedAtMs: numberField(object.generatedAtMs, "recording.privacyReceipt.generatedAtMs"),
    recording: {
      recordingId: stringField(recording.recordingId, "privacyReceipt.recording.recordingId"),
      label: stringField(recording.label, "privacyReceipt.recording.label", "Untitled meeting"),
      state: stringField(recording.state, "privacyReceipt.recording.state"),
      createdAtMs: numberField(recording.createdAtMs, "privacyReceipt.recording.createdAtMs"),
      updatedAtMs: numberField(recording.updatedAtMs, "privacyReceipt.recording.updatedAtMs"),
      deletionStatus: stringField(recording.deletionStatus, "privacyReceipt.recording.deletionStatus"),
    },
    capture: {
      channels: expectArray(capture.channels, "privacyReceipt.capture.channels")
        .map((channel, index) => stringField(channel, `privacyReceipt.capture.channels[${index}]`)),
      audioChunkCount: numberField(capture.audioChunkCount, "privacyReceipt.capture.audioChunkCount"),
      channelAttribution: booleanField(capture.channelAttribution, "privacyReceipt.capture.channelAttribution"),
    },
    storage: {
      rootKind: stringField(storage.rootKind, "privacyReceipt.storage.rootKind"),
      encryptedAudioChunkCount: numberField(storage.encryptedAudioChunkCount, "privacyReceipt.storage.encryptedAudioChunkCount"),
      allAudioEncrypted: booleanField(storage.allAudioEncrypted, "privacyReceipt.storage.allAudioEncrypted"),
      cipher: nullableStringField(storage.cipher, "privacyReceipt.storage.cipher"),
    },
    content: {
      transcriptSegmentCount: numberField(content.transcriptSegmentCount, "privacyReceipt.content.transcriptSegmentCount"),
      notesSavedLocally: booleanField(content.notesSavedLocally, "privacyReceipt.content.notesSavedLocally"),
    },
    processing: expectArray(object.processing, "privacyReceipt.processing")
      .map((event, index) => parsePrivacyEvent(event, `privacyReceipt.processing[${index}]`)),
    exports: expectArray(object.exports, "privacyReceipt.exports")
      .map((event, index) => parsePrivacyEvent(event, `privacyReceipt.exports[${index}]`)),
    retention: {
      policy: stringField(retention.policy, "privacyReceipt.retention.policy"),
      automaticDeletion: booleanField(retention.automaticDeletion, "privacyReceipt.retention.automaticDeletion"),
    },
    network: parseNetworkCapabilities(object.network),
  };
}

export function parseMarkedMoments(markdown: string): MarkedMoment[] {
  const moments: MarkedMoment[] = [];
  const pattern = /^- \[(\d+):(\d{2})\] (.+)$/gm;
  for (const match of markdown.matchAll(pattern)) {
    const minutes = Number(match[1]);
    const seconds = Number(match[2]);
    if (!Number.isFinite(minutes) || !Number.isFinite(seconds) || seconds > 59) continue;
    const timeMs = (minutes * 60 + seconds) * 1000;
    moments.push({
      id: `note-${timeMs}-${moments.length}`,
      timeMs,
      label: match[3] || "Marked moment",
    });
  }
  return moments;
}

export function recapItemKey(item: RecapItem): string {
  return `${item.category}-${item.segmentIndex}-${item.text}`;
}

export function exportReportItem(item: RecapItem): JsonObject {
  return {
    text: item.text,
    speaker: item.speaker,
    startMs: item.startMs,
    owner: "",
    dueDate: "",
    status: "",
  };
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "Not installed";
  const units = ["B", "KB", "MB", "GB"];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** unitIndex;
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

export function metric(value: unknown, fallback = "Unknown"): string {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  throw new ProtocolValidationError("display metric", "a string, number, or boolean");
}

export function exportFormatLabel(format: ExportFormat): string {
  if (format === "docx") return "Word (.docx)";
  if (format === "pdf") return "PDF";
  return "Markdown";
}

export function exportActionLabel(format: ExportFormat): string {
  if (format === "docx") return "Save Word";
  if (format === "pdf") return "Save PDF";
  return "Save Markdown";
}
