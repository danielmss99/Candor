import { describe, expect, it } from "vitest";
import { denyPermissionCheck, denyPermissionRequest, NetworkGuard } from "./network-policy.js";

describe("network guard", () => {
  it("allows local resources and blocks remote resources", () => {
    const guard = new NetworkGuard();
    expect(guard.recordRequest("file:///app/index.html", false)).toBe(true);
    expect(guard.recordRequest("http://127.0.0.1:5173/main.tsx", true)).toBe(true);
    expect(guard.recordRequest("https://example.com/data", false)).toBe(false);
    expect(guard.snapshot()).toMatchObject({
      totalRequests: 3,
      localAllowedRequests: 1,
      externalAllowedRequests: 1,
      blockedRequests: 1,
      blockedSamples: ["https://example.com"],
    });
  });

  it("records denial categories without retaining target URLs or paths", () => {
    const guard = new NetworkGuard();
    guard.recordWindowOpen("https://example.com/private");
    guard.recordNavigation("file:///C:/Users/example/private.txt");

    const snapshot = JSON.stringify(guard.snapshot());
    expect(snapshot).toContain("window-open-denied:external");
    expect(snapshot).toContain("navigation-denied:local-file");
    expect(snapshot).not.toContain("example.com/private");
    expect(snapshot).not.toContain("private.txt");
  });

  it("denies permission requests and checks unconditionally", () => {
    let granted: boolean | null = null;
    denyPermissionRequest((value) => { granted = value; });
    expect(granted).toBe(false);
    expect(denyPermissionCheck()).toBe(false);
  });
});
