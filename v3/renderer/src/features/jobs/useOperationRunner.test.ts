import { describe, expect, it } from "vitest";
import { operationErrorMessage } from "./useOperationRunner";

describe("operation runner errors", () => {
  it("normalizes failures without exposing object internals", () => {
    expect(operationErrorMessage(new Error("Model unavailable"))).toBe("Model unavailable");
    expect(operationErrorMessage("Capture failed")).toBe("Capture failed");
  });

  it("turns encrypted search backfill into a clear retry state", () => {
    expect(operationErrorMessage(new Error(
      "Error invoking remote method: CANDOR_CORE_ERROR:RECORDING_SEARCH_INDEX_BUILDING",
    ))).toBe("Preparing encrypted search. Try again shortly.");
  });
});

