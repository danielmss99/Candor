import { describe, expect, it } from "vitest";
import { operationErrorMessage } from "./useOperationRunner";

describe("operation runner errors", () => {
  it("normalizes failures without exposing object internals", () => {
    expect(operationErrorMessage(new Error("Model unavailable"))).toBe("Model unavailable");
    expect(operationErrorMessage("Capture failed")).toBe("Capture failed");
  });
});

