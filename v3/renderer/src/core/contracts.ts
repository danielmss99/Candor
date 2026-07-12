export type LocalJsonValue =
  | null
  | boolean
  | number
  | string
  | LocalJsonValue[]
  | { [key: string]: LocalJsonValue };

export type JsonObject = Record<string, LocalJsonValue>;
export type AiMode = "quality" | "fast";
export type InstructAssetKind = "runner" | "model";
export type AppView = "home" | "meeting" | "library" | "detail" | "review" | "settings" | "export" | "proof";
export type DetailSection = "summary" | "transcript" | "notes" | "actions" | "audio" | "privacy";
export type SettingsSection = "general" | "recording" | "models" | "privacy" | "export" | "license";
export type ReviewSection = "summary" | "decisions" | "actions" | "questions" | "risks" | "notes" | "transcript" | "preview";
export type LibraryFilter = "all" | "transcribed" | "audio";
export type OnboardingStep = "activate" | "yours" | "microphone" | "system-audio" | "storage" | "local-ai" | "app";
export type ExportFormat = "markdown" | "docx" | "pdf";
export type ExportPaperSize = "letter" | "a4";
export type CompactMeetingPane = "transcript" | "notes" | "ai";

export const EXPECTED_PROTOCOL_VERSION = "m0-jsonrpc-stdio-1";
export const DEFAULT_MODEL = "base.en";
export const LIBRARY_PAGE_SIZE = 50;
export const TRANSCRIPT_PAGE_SIZE = 200;

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
  offset: number;
  limit: number;
  totalCount: number;
  hasMore: boolean;
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

export interface RecapItem {
  category: string;
  text: string;
  speaker: string;
  channel: string;
  startMs: number;
  segmentIndex: number;
  quote: string;
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
}

export interface LocalAiAnswer {
  engine: string;
  question: string;
  answer: string;
  answerFound: boolean;
  intent: string;
  citations: RecapItem[];
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
  return {
    recordings,
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

function parseRecapItem(value: unknown, field: string): RecapItem {
  const object = expectObject(value, field);
  return {
    category: stringField(object.category, `${field}.category`, "evidence"),
    text: stringField(object.text, `${field}.text`),
    speaker: stringField(object.speaker, `${field}.speaker`, "Speaker"),
    channel: stringField(object.channel, `${field}.channel`, "mixed"),
    startMs: numberField(object.startMs, `${field}.startMs`, 0),
    segmentIndex: numberField(object.segmentIndex, `${field}.segmentIndex`, 0),
    quote: stringField(object.quote, `${field}.quote`, ""),
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

export function parseRecap(value: unknown): LocalAiRecap {
  const object = expectObject(value, "ai.recap");
  const markdown = stringField(object.recapMarkdown, "ai.recap.recapMarkdown", "");
  return {
    engine: stringField(object.engine, "ai.recap.engine"),
    summary: stringField(object.summary, "ai.recap.summary", markdown ? "" : "No local recap yet."),
    markdown,
    decisions: recapItems(object, "decisions"),
    actions: recapItems(object, "actions"),
    risks: recapItems(object, "risks"),
    questions: recapItems(object, "questions"),
    citations: optionalArray(object.citations, "ai.recap.citations")
      .map((item, index) => parseCitation(item, `ai.recap.citations[${index}]`)),
  };
}

export function parseAnswer(value: unknown): LocalAiAnswer {
  const object = expectObject(value, "ai.ask");
  const answer = stringField(object.answer, "ai.ask.answer");
  const engine = stringField(object.engine, "ai.ask.engine");
  return {
    engine,
    question: stringField(object.question, "ai.ask.question", ""),
    answer,
    answerFound: booleanField(object.answerFound, "ai.ask.answerFound", Boolean(answer.trim())),
    intent: stringField(object.intent, "ai.ask.intent", engine === "llama-cpp-local" ? "cited local answer" : "general"),
    citations: optionalArray(object.citations, "ai.ask.citations")
      .map((item, index) => parseCitation(item, `ai.ask.citations[${index}]`)),
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
  return {
    eventType: eventType as PrivacyEvent["eventType"],
    engine: nullableStringField(object.engine, `${field}.engine`),
    modelId: nullableStringField(object.modelId, `${field}.modelId`),
    sha256: nullableStringField(object.sha256, `${field}.sha256`),
    format: nullableStringField(object.format, `${field}.format`),
    bytes: nullableNumberField(object.bytes, `${field}.bytes`),
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
