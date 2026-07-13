import { describe, expect, it, vi } from "vitest";
import { runBackgroundDiagnostics } from "./useRuntimeStatus";

describe("background diagnostics", () => {
  it("runs every independent diagnostic and reports failures without throwing", async () => {
    const successful = vi.fn(async () => undefined);
    const failed = vi.fn(async () => { throw new Error("model metadata unavailable"); });
    const final = vi.fn(async () => undefined);

    const result = await runBackgroundDiagnostics([
      { label: "privacy", run: successful },
      { label: "models", run: failed },
      { label: "retention", run: final },
    ]);

    expect(result).toEqual({ failed: ["models"], completed: 2 });
    expect(successful).toHaveBeenCalledOnce();
    expect(failed).toHaveBeenCalledOnce();
    expect(final).toHaveBeenCalledOnce();
  });
});

