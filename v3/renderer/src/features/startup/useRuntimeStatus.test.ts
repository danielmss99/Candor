import { describe, expect, it, vi } from "vitest";
import { runBackgroundDiagnostics, runCheapThenExpensive } from "./useRuntimeStatus";

describe("background diagnostics", () => {
  it("runs every independent diagnostic and reports failures without throwing", async () => {
    const order: string[] = [];
    const successful = vi.fn(async () => { order.push("privacy"); });
    const failed = vi.fn(async () => {
      order.push("models");
      throw new Error("model metadata unavailable");
    });
    const final = vi.fn(async () => { order.push("retention"); });

    const result = await runBackgroundDiagnostics([
      { label: "privacy", run: successful },
      { label: "models", run: failed },
      { label: "retention", run: final },
    ]);

    expect(result).toEqual({ failed: ["models"], completed: 2 });
    expect(successful).toHaveBeenCalledOnce();
    expect(failed).toHaveBeenCalledOnce();
    expect(final).toHaveBeenCalledOnce();
    expect(order).toEqual(["privacy", "models", "retention"]);
  });
});

describe("expensive local diagnostics", () => {
  it("finishes ordinary RPC work before starting full bundle verification", async () => {
    const order: string[] = [];
    const result = await runCheapThenExpensive(
      async () => {
        order.push("cheap-start");
        await Promise.resolve();
        order.push("cheap-finish");
        return "cheap";
      },
      async () => {
        order.push("bundle-start");
        return "bundle";
      },
    );

    expect(result).toEqual(["cheap", "bundle"]);
    expect(order).toEqual(["cheap-start", "cheap-finish", "bundle-start"]);
  });

  it("does not start bundle verification when an ordinary RPC fails", async () => {
    const expensive = vi.fn(async () => "bundle");
    await expect(runCheapThenExpensive(
      async () => { throw new Error("ordinary RPC failed"); },
      expensive,
    )).rejects.toThrow("ordinary RPC failed");
    expect(expensive).not.toHaveBeenCalled();
  });
});

