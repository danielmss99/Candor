import { describe, expect, it } from "vitest";
import { deleteRecordingConfirmationOptions } from "./delete-policy.js";

describe("permanent recording deletion policy", () => {
  it("defaults to cancel and states the local irreversible scope", () => {
    const options = deleteRecordingConfirmationOptions();

    expect(options.type).toBe("warning");
    expect(options.buttons).toEqual(["Cancel", "Delete permanently"]);
    expect(options.defaultId).toBe(0);
    expect(options.cancelId).toBe(0);
    expect(options.detail).toContain("local audio, transcript, notes, and meeting metadata");
    expect(options.detail).toContain("cannot be undone");
  });
});
