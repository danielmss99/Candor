import type { JsonValue } from "./json.js";
import type { CoreResponse } from "./protocol.js";

const LIVE_TRANSCRIPT_EVENT_CHANNEL = "candor-events:transcript-partial";
const MAX_PARTIAL_TEXT_BYTES = 4 * 1024;

interface LiveTranscriptCore {
  call(method: string, params: JsonValue): Promise<CoreResponse>;
}

interface LiveTranscriptWindow {
  isDestroyed(): boolean;
  webContents: {
    isDestroyed(): boolean;
    send(channel: string, payload: JsonValue): void;
  };
}

interface LiveTranscriptEventBridgeDependencies {
  core: LiveTranscriptCore;
  getMainWindow(): LiveTranscriptWindow | null;
  pollIntervalMs?: number;
}

function objectValue(value: JsonValue | undefined): Record<string, JsonValue> | null {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function safePartialPayload(value: JsonValue | undefined): JsonValue | null {
  const payload = objectValue(value);
  if (
    !payload
    || payload.event !== "transcript.partial"
    || payload.schemaVersion !== 1
    || typeof payload.recordingId !== "string"
    || !/^[A-Za-z0-9_-]{1,96}$/.test(payload.recordingId)
    || typeof payload.sequence !== "number"
    || !Number.isSafeInteger(payload.sequence)
    || payload.sequence < 1
    || payload.provisional !== true
    || payload.isFinal !== false
    || typeof payload.startMs !== "number"
    || !Number.isSafeInteger(payload.startMs)
    || payload.startMs < 0
    || typeof payload.endMs !== "number"
    || !Number.isSafeInteger(payload.endMs)
    || payload.endMs < payload.startMs
    || typeof payload.text !== "string"
    || payload.text.length < 1
    || Buffer.byteLength(payload.text, "utf8") > MAX_PARTIAL_TEXT_BYTES
    || typeof payload.segmentCount !== "number"
    || !Number.isSafeInteger(payload.segmentCount)
    || payload.segmentCount < 1
    || payload.segmentCount > 256
    || payload.localOnly !== true
    || payload.networkAttempted !== false
    || payload.rawPathExposed !== false
    || payload.keyMaterialExposedToRenderer !== false
  ) {
    return null;
  }
  return {
    event: "transcript.partial",
    schemaVersion: 1,
    recordingId: payload.recordingId,
    sequence: payload.sequence,
    provisional: true,
    isFinal: false,
    startMs: payload.startMs,
    endMs: payload.endMs,
    text: payload.text,
    segmentCount: payload.segmentCount,
    localOnly: true,
    networkAttempted: false,
    rawPathExposed: false,
    keyMaterialExposedToRenderer: false,
  };
}

/**
 * Drains bounded core-owned updates only while a renderer-started live session
 * is active. The bridge cannot create transcript text. A trusted in-core ASR
 * producer is the only source of event text.
 */
export class LiveTranscriptEventBridge {
  private readonly activeRecordingIds = new Set<string>();
  private readonly pollIntervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private drainInFlight: Promise<number | null> | null = null;
  private readonly finalizingRecordingIds = new Set<string>();

  constructor(private readonly dependencies: LiveTranscriptEventBridgeDependencies) {
    this.pollIntervalMs = Math.max(100, dependencies.pollIntervalMs ?? 250);
  }

  observeCoreOperation(method: string, params: JsonValue, result: JsonValue): Promise<void> | void {
    const input = objectValue(params);
    const output = objectValue(result);
    const inputRecordingId = input?.recordingId;

    if (
      method === "liveTranscript.start"
      && output?.active === true
      && typeof inputRecordingId === "string"
      && /^[A-Za-z0-9_-]{1,96}$/.test(inputRecordingId)
    ) {
      this.activeRecordingIds.add(inputRecordingId);
      this.ensurePolling();
      return;
    }
    if (
      method === "liveTranscript.stop"
      && output?.sessionRemoved === true
      && typeof inputRecordingId === "string"
      && /^[A-Za-z0-9_-]{1,96}$/.test(inputRecordingId)
    ) {
      this.activeRecordingIds.delete(inputRecordingId);
      if (this.activeRecordingIds.size === 0) this.stopPolling();
      return;
    }
    if (method === "capture.stop") {
      const capture = objectValue(output?.capture);
      const recordingId = capture?.recordingId;
      if (
        typeof recordingId === "string"
        && /^[A-Za-z0-9_-]{1,96}$/.test(recordingId)
        && this.activeRecordingIds.has(recordingId)
      ) {
        return this.finalDrainAndDeactivate(recordingId);
      }
    }
  }

  async drainOnce(): Promise<number | null> {
    if (this.activeRecordingIds.size === 0) return 0;
    if (this.drainInFlight) return this.drainInFlight;
    const window = this.dependencies.getMainWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return null;

    const drain = this.performDrain(window);
    this.drainInFlight = drain;
    try {
      return await drain;
    } finally {
      if (this.drainInFlight === drain) this.drainInFlight = null;
    }
  }

  dispose(): void {
    this.activeRecordingIds.clear();
    this.finalizingRecordingIds.clear();
    this.stopPolling();
  }

  private async performDrain(window: LiveTranscriptWindow): Promise<number | null> {
    try {
      const response = await this.dependencies.core.call("liveTranscript.eventsDrain", null);
      if (!response.ok) return null;
      const drain = objectValue(response.result);
      if (
        !drain
        || drain.schemaVersion !== 1
        || drain.localOnly !== true
        || drain.networkAttempted !== false
        || drain.rawPathExposed !== false
        || drain.keyMaterialExposedToRenderer !== false
        || !Array.isArray(drain.events)
        || drain.events.length > 128
        || typeof drain.remainingEventCount !== "number"
        || !Number.isSafeInteger(drain.remainingEventCount)
        || drain.remainingEventCount < 0
        || drain.remainingEventCount > 512
      ) {
        return null;
      }
      if (window.isDestroyed() || window.webContents.isDestroyed()) return null;
      for (const candidate of drain.events) {
        const envelope = objectValue(candidate);
        if (!envelope || envelope.channel !== "transcript.partial") continue;
        const payload = safePartialPayload(envelope.payload);
        if (payload) window.webContents.send(LIVE_TRANSCRIPT_EVENT_CHANNEL, payload);
      }
      return drain.remainingEventCount;
    } catch {
      // A core restart or malformed event fails closed and can be retried by the next poll.
      return null;
    }
  }

  private async finalDrainAndDeactivate(recordingId: string): Promise<void> {
    if (this.finalizingRecordingIds.has(recordingId)) return;
    this.finalizingRecordingIds.add(recordingId);
    try {
      // The core queue is capped at 512 and each drain is capped at 128, so
      // four serialized drains are sufficient once capture has stopped.
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const remaining = await this.drainOnce();
        if (remaining === null || remaining === 0) break;
      }
    } finally {
      this.activeRecordingIds.delete(recordingId);
      this.finalizingRecordingIds.delete(recordingId);
      if (this.activeRecordingIds.size === 0) this.stopPolling();
    }
  }

  private ensurePolling(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.drainOnce(), this.pollIntervalMs);
    this.timer.unref();
  }

  private stopPolling(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
