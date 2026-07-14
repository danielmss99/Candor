import { describe, expect, it, vi } from "vitest";
import { CandorClient, CandorClientError } from "./candor-client";
import { EXPECTED_PROTOCOL_VERSION } from "./contracts";

type CoreApi = ConstructorParameters<typeof CandorClient>[0];

function coreApi(overrides: Record<string, unknown> = {}): CoreApi {
  const app = {
    getVersion: vi.fn().mockResolvedValue({ version: "0.1.0", protocolVersion: EXPECTED_PROTOCOL_VERSION }),
  };
  const meetings = {
    list: vi.fn(),
    getTranscript: vi.fn(),
    getPrivacyReceipt: vi.fn(),
  };
  const settings = { getNetworkPolicy: vi.fn() };
  const ai = { listSpeechModels: vi.fn() };
  if (overrides.version) app.getVersion = overrides.version as typeof app.getVersion;
  if (overrides.recordingDurableListPage) meetings.list = overrides.recordingDurableListPage as typeof meetings.list;
  return {
    version: 3,
    app,
    meetings,
    settings,
    ai,
  } as unknown as CoreApi;
}

describe("CandorClient", () => {
  it("performs one version handshake and reuses it", async () => {
    const api = coreApi();
    const client = new CandorClient(api);
    await client.object("first", async () => ({ ok: true }));
    await client.object("second", async () => ({ ok: true }));
    expect(api.app.getVersion).toHaveBeenCalledTimes(1);
  });

  it("turns malformed core payloads into visible protocol errors", async () => {
    const api = coreApi({
      recordingDurableListPage: vi.fn().mockResolvedValue({
        offset: 0,
        limit: 50,
        totalCount: 1,
        hasMore: false,
        recordings: [{
          recordingId: "rec-1",
          label: "Meeting",
          state: "finished",
          audioDurationMs: "invalid",
          audioChunkCount: 1,
          transcriptSegmentCount: 1,
          updatedAtMs: 1,
        }],
      }),
    });
    const client = new CandorClient(api);
    await expect(client.recordingPage(0, 50)).rejects.toMatchObject({
      name: "CandorClientError",
      code: "PROTOCOL_RESPONSE_INVALID",
      retryable: false,
    });
  });

  it("retries the handshake after a version mismatch is corrected", async () => {
    const version = vi.fn()
      .mockResolvedValueOnce({ version: "0.1.0", protocolVersion: "future" })
      .mockResolvedValueOnce({ version: "0.1.0", protocolVersion: EXPECTED_PROTOCOL_VERSION });
    const client = new CandorClient(coreApi({ version }));
    await expect(client.object("first", async () => ({ ok: true }))).rejects.toThrow();
    await expect(client.object("second", async () => ({ ok: true }))).resolves.toEqual({ ok: true });
    expect(version).toHaveBeenCalledTimes(2);
  });

  it("keeps request identity on core failures", async () => {
    const client = new CandorClient(coreApi());
    let caught: unknown;
    try {
      await client.object("notes.save", async () => { throw new Error("disk unavailable"); });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CandorClientError);
    expect(caught).toMatchObject({ code: "CORE_REQUEST_FAILED", requestId: "notes.save-1" });
  });

  it("preserves a renderer-safe core error code without trusting raw details", async () => {
    const client = new CandorClient(coreApi());
    await expect(client.object("capture.start", async () => {
      throw new Error("Error invoking remote method: CANDOR_CORE_ERROR:CONSENT_REQUIRED");
    })).rejects.toMatchObject({
      code: "CONSENT_REQUIRED",
      requestId: "capture.start-1",
      retryable: false,
    });
  });
});
