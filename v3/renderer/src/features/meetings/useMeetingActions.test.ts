import { describe, expect, it } from "vitest";
import { nextOpenMeetingIds, queuedDeletionNotice } from "./useMeetingActions";

describe("meeting session rail", () => {
  it("keeps the most recently opened meeting first and caps tabs at three", () => {
    expect(nextOpenMeetingIds(["one", "two", "three"], "two")).toEqual(["two", "one", "three"]);
    expect(nextOpenMeetingIds(["one", "two", "three"], "four")).toEqual(["four", "one", "two"]);
  });

  it("explains that a bounded queued deletion retains confirmation", () => {
    expect(queuedDeletionNotice({
      recordingDataRemoved: false,
      confirmationRetained: true,
    })).toContain("without asking again");
    expect(queuedDeletionNotice({
      recordingDataRemoved: false,
      confirmationRetained: false,
    })).toBeNull();
    expect(queuedDeletionNotice({
      recordingDataRemoved: true,
      confirmationRetained: true,
    })).toBeNull();
  });
});

