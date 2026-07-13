import { describe, expect, it } from "vitest";
import { senderMatchesMainFrame } from "./validate-sender.js";

describe("IPC sender identity", () => {
  it("accepts only the active main frame", () => {
    const mainFrame = {};
    const identity = { destroyed: false, webContentsId: 7, mainFrame };
    expect(senderMatchesMainFrame(7, mainFrame, identity)).toBe(true);
    expect(senderMatchesMainFrame(8, mainFrame, identity)).toBe(false);
    expect(senderMatchesMainFrame(7, {}, identity)).toBe(false);
    expect(senderMatchesMainFrame(7, mainFrame, { ...identity, destroyed: true })).toBe(false);
    expect(senderMatchesMainFrame(7, mainFrame, null)).toBe(false);
  });
});
