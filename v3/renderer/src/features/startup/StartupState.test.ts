import { describe, expect, it } from "vitest";
import { startupFailureTitle } from "./StartupState";

describe("startup recovery", () => {
  it("distinguishes protocol incompatibility from local core unavailability", () => {
    expect(startupFailureTitle("protocol version 2 is incompatible")).toBe("Candor's local service is incompatible");
    expect(startupFailureTitle("local process did not start")).toBe("Candor's local service is unavailable");
  });
});
