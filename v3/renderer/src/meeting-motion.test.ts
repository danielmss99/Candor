import { describe, expect, it } from "vitest";
import { formatClock } from "./meeting-motion";

describe("formatClock", () => {
  it("clamps negative timestamps", () => {
    expect(formatClock(-250)).toBe("0:00");
  });

  it("formats timestamp evidence without rounding up", () => {
    expect(formatClock(65_999)).toBe("1:05");
  });

  it("supports meetings longer than one hour", () => {
    expect(formatClock(3_725_000)).toBe("62:05");
  });
});
