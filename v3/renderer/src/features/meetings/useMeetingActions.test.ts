import { describe, expect, it } from "vitest";
import { nextOpenMeetingIds } from "./useMeetingActions";

describe("meeting session rail", () => {
  it("keeps the most recently opened meeting first and caps tabs at three", () => {
    expect(nextOpenMeetingIds(["one", "two", "three"], "two")).toEqual(["two", "one", "three"]);
    expect(nextOpenMeetingIds(["one", "two", "three"], "four")).toEqual(["four", "one", "two"]);
  });
});

