import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("desktop startup ordering", () => {
  it("isolates smoke and E2E user data before acquiring the single-instance lock", () => {
    const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
    const testUserData = source.indexOf("app.setPath(");
    const singleInstanceLock = source.indexOf("app.requestSingleInstanceLock()");
    expect(testUserData).toBeGreaterThanOrEqual(0);
    expect(singleInstanceLock).toBeGreaterThan(testUserData);
  });

  it("registers the persisted global shortcut only inside app readiness", () => {
    const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
    const whenReady = source.indexOf("app.whenReady().then");
    const shortcutInitialization = source.indexOf("await shortcutService.initialize()");
    const readinessEnd = source.indexOf("\n});", shortcutInitialization);

    expect(whenReady).toBeGreaterThanOrEqual(0);
    expect(shortcutInitialization).toBeGreaterThan(whenReady);
    expect(readinessEnd).toBeGreaterThan(shortcutInitialization);
    expect(source.match(/shortcutService\.initialize\(\)/g)).toHaveLength(1);
  });
});
