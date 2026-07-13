import { describe, expect, it } from "vitest";
import { parseModels } from "../../core/contracts";

describe("local AI model state", () => {
  it("rejects malformed model metadata instead of inventing readiness", () => {
    expect(() => parseModels({ models: [{ modelId: "base.en", installed: true }] }))
      .toThrow(/protocol error/i);
  });
});

