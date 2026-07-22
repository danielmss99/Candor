import { describe, expect, it, vi } from "vitest";
import { searchWhenReady } from "./core-rpc-search-retry.mjs";

function codedError(code) {
  return Object.assign(new Error(code), { code });
}

describe("core search readiness retry", () => {
  it("retries an explicit building response and returns the ready result", async () => {
    const call = vi.fn()
      .mockRejectedValueOnce(codedError("RECORDING_SEARCH_INDEX_BUILDING"))
      .mockResolvedValueOnce({ matchCount: 1 });

    await expect(searchWhenReady(call, { query: "pathless" }, {
      attempts: 2,
      retryDelayMs: 0,
    })).resolves.toEqual({ matchCount: 1 });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("preserves the building code when the readiness bound is exhausted", async () => {
    const call = vi.fn().mockRejectedValue(codedError("RECORDING_SEARCH_INDEX_BUILDING"));

    await expect(searchWhenReady(call, { query: "pathless" }, {
      attempts: 2,
      retryDelayMs: 0,
    })).rejects.toMatchObject({
      code: "RECORDING_SEARCH_INDEX_BUILDING",
      attempts: 2,
      cause: { code: "RECORDING_SEARCH_INDEX_BUILDING" },
    });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("propagates a no-response timeout without retrying it", async () => {
    const timeout = codedError("RPC_RESPONSE_TIMEOUT");
    const call = vi.fn().mockRejectedValue(timeout);

    await expect(searchWhenReady(call, { query: "pathless" })).rejects.toBe(timeout);
    expect(call).toHaveBeenCalledOnce();
  });
});
