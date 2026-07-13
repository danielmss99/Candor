import {
  EXPECTED_PROTOCOL_VERSION,
  expectObject,
  parseAnswer,
  parseMeetingPrivacyReceipt,
  parseModels,
  parseNetworkCapabilities,
  parseProtocolVersion,
  parseRecap,
  parseRecordingPage,
  parseTranscriptPage,
  type JsonObject,
  type LocalAiAnswer,
  type LocalAiRecap,
  type MeetingPrivacyReceipt,
  type ModelRow,
  type NetworkCapabilities,
  type RecordingPage,
  type TranscriptPage,
} from "./contracts";

export interface RpcEnvelope<T> {
  protocolVersion: typeof EXPECTED_PROTOCOL_VERSION;
  requestId: string;
  result?: T;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

type CoreApi = NonNullable<Window["candor"]>["core"];

function bridgeErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return "CORE_REQUEST_FAILED";
  return error.message.match(/CANDOR_CORE_ERROR:([A-Z][A-Z0-9_]{1,63})/)?.[1]
    ?? "CORE_REQUEST_FAILED";
}

export class CandorClientError extends Error {
  readonly code: string;
  readonly requestId: string;
  readonly retryable: boolean;

  constructor(envelope: RpcEnvelope<never>) {
    super(envelope.error?.message ?? "Candor request failed");
    this.name = "CandorClientError";
    this.code = envelope.error?.code ?? "CANDOR_REQUEST_FAILED";
    this.requestId = envelope.requestId;
    this.retryable = envelope.error?.retryable ?? false;
  }
}

export class CandorClient {
  private readonly api: CoreApi;
  private requestSequence = 0;
  private protocolPromise: Promise<void> | null = null;

  constructor(api: CoreApi) {
    this.api = api;
  }

  verifyProtocol(): Promise<void> {
    if (!this.protocolPromise) {
      this.protocolPromise = this.api.version().then((value) => {
        parseProtocolVersion(value);
      }).catch((error) => {
        this.protocolPromise = null;
        throw error;
      });
    }
    return this.protocolPromise;
  }

  async object(method: string, invoke: () => Promise<unknown>): Promise<JsonObject> {
    return this.request(method, invoke, (value) => expectObject(value, method));
  }

  async recordingPage(offset: number, limit: number): Promise<RecordingPage> {
    return this.request(
      "recording.durable.listPage",
      () => this.api.recordingDurableListPage(offset, limit),
      parseRecordingPage,
    );
  }

  async transcriptPage(recordingId: string, offset: number, limit: number): Promise<TranscriptPage> {
    return this.request(
      "recording.durable.transcriptPage",
      () => this.api.recordingDurableTranscriptPage(recordingId, offset, limit),
      parseTranscriptPage,
    );
  }

  async models(): Promise<ModelRow[]> {
    return this.request("models.status", () => this.api.modelsStatus(), parseModels);
  }

  async recap(invoke: () => Promise<unknown>): Promise<LocalAiRecap> {
    return this.request("ai.recap", invoke, parseRecap);
  }

  async answer(invoke: () => Promise<unknown>): Promise<LocalAiAnswer> {
    return this.request("ai.ask", invoke, parseAnswer);
  }

  async privacyReceipt(recordingId: string): Promise<MeetingPrivacyReceipt> {
    return this.request(
      "recording.privacyReceipt",
      () => this.api.recordingPrivacyReceipt(recordingId),
      parseMeetingPrivacyReceipt,
    );
  }

  async networkCapabilities(): Promise<NetworkCapabilities> {
    return this.request(
      "privacy.capabilities",
      () => this.api.privacyCapabilities(),
      parseNetworkCapabilities,
    );
  }

  private async request<T>(
    method: string,
    invoke: () => Promise<unknown>,
    parse: (value: unknown) => T,
  ): Promise<T> {
    await this.verifyProtocol();
    const requestId = `${method}-${++this.requestSequence}`;
    try {
      const result = parse(await invoke());
      const envelope: RpcEnvelope<T> = {
        protocolVersion: EXPECTED_PROTOCOL_VERSION,
        requestId,
        result,
      };
      return envelope.result as T;
    } catch (error) {
      const envelope: RpcEnvelope<never> = {
        protocolVersion: EXPECTED_PROTOCOL_VERSION,
        requestId,
        error: {
          code: error instanceof Error && error.name === "ProtocolValidationError"
            ? "PROTOCOL_RESPONSE_INVALID"
            : bridgeErrorCode(error),
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
        },
      };
      throw new CandorClientError(envelope);
    }
  }
}
