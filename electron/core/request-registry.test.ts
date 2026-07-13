import { describe, expect, it, vi } from "vitest";
import { RequestRegistry } from "./request-registry.js";

describe("request registry", () => {
  it("settles each request exactly once", async () => {
    const registry = new RequestRegistry<number>();
    const result = registry.register("request-1", "core.status", 1000, () => undefined);
    expect(registry.resolve("request-1", 42)).toBe(true);
    expect(registry.resolve("request-1", 43)).toBe(false);
    await expect(result).resolves.toBe(42);
    expect(registry.size).toBe(0);
  });

  it("rejects duplicate pending IDs", async () => {
    const registry = new RequestRegistry<number>();
    const pending = registry.register("request-1", "core.status", 1000, () => undefined);
    expect(() => registry.register("request-1", "core.status", 1000, () => undefined)).toThrow(
      "duplicate core request id",
    );
    const cleanup = expect(pending).rejects.toThrow("cleanup");
    registry.rejectAll(new Error("cleanup"));
    await cleanup;
  });

  it("times out and removes a pending request", async () => {
    vi.useFakeTimers();
    const registry = new RequestRegistry<number>();
    const onTimeout = vi.fn();
    const result = registry.register("request-1", "core.status", 50, onTimeout);
    const assertion = expect(result).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    expect(onTimeout).toHaveBeenCalledWith("core.status");
    expect(registry.size).toBe(0);
    vi.useRealTimers();
  });
});
