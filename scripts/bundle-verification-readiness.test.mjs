import { describe, expect, it, vi } from "vitest";
import { waitForBundleVerification } from "./bundle-verification-readiness.mjs";

describe("bundled AI verification readiness", () => {
  it("returns a terminal status without delaying", async () => {
    const readStatus = vi.fn().mockResolvedValue({ state: "ready", ready: true });
    const wait = vi.fn();

    await expect(waitForBundleVerification(readStatus, { wait })).resolves.toEqual({
      state: "ready",
      ready: true,
    });
    expect(readStatus).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("polls only while verification reports checking", async () => {
    const readStatus = vi
      .fn()
      .mockResolvedValueOnce({ state: "checking", ready: false })
      .mockResolvedValueOnce({ state: "checking", ready: false })
      .mockResolvedValueOnce({ state: "missing", ready: false, language: { ready: true } });
    let currentTime = 100;
    const wait = vi.fn(async (milliseconds) => {
      currentTime += milliseconds;
    });

    await expect(waitForBundleVerification(readStatus, {
      timeoutMs: 100,
      pollIntervalMs: 5,
      now: () => currentTime,
      wait,
    })).resolves.toEqual({
      state: "missing",
      ready: false,
      language: { ready: true },
    });
    expect(readStatus).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it("fails within the configured bound when verification never completes", async () => {
    const readStatus = vi.fn().mockResolvedValue({ state: "checking", ready: false });
    let currentTime = 0;
    const wait = vi.fn(async (milliseconds) => {
      currentTime += milliseconds;
    });

    await expect(waitForBundleVerification(readStatus, {
      timeoutMs: 12,
      pollIntervalMs: 5,
      now: () => currentTime,
      wait,
    })).rejects.toThrow("timed out after 12ms waiting for bundled AI verification");
    expect(currentTime).toBe(12);
  });
});
