import { describe, expect, it } from "vitest";
import { recapItemKey, type RecapItem } from "../../core/contracts";
import { reviewedReportItems, reviewStatesReducer } from "./useReportWorkflow";

const item: RecapItem = {
  category: "action",
  text: "Send the report",
  speaker: "Me",
  channel: "mic",
  startMs: 1000,
  segmentIndex: 1,
  quote: "I will send the report",
};

describe("structured report review", () => {
  it("removes rejected evidence from every export renderer", () => {
    expect(reviewedReportItems([item], {})).toEqual([item]);
    expect(reviewedReportItems([item], { [recapItemKey(item)]: "rejected" })).toEqual([]);
  });

  it("clears review decisions when the selected recording changes", () => {
    const reviewed = reviewStatesReducer({}, { type: "review", key: recapItemKey(item), state: "rejected" });
    expect(reviewed).not.toEqual({});
    expect(reviewStatesReducer(reviewed, { type: "recording-changed" })).toEqual({});
  });
});
