import { describe, expect, it } from "vitest";
import { buildPersistentAlerts } from "./system-alerts";

describe("persistent local recovery alerts", () => {
  it("keeps measured storage and quarantine failures persistent", () => {
    const alerts = buildPersistentAlerts({
      coreStatus: { startupRecovery: { pendingDeletionCount: 1, recoveredCount: 0 } },
      captureStatus: {},
      recordingStatus: { storageHealth: { level: "blocking", availableBytes: 100, canContinueCapture: false } },
      quarantinedCount: 2,
    });

    expect(alerts.map((alert) => alert.id)).toEqual([
      "storage-blocking",
      "pending-deletion",
      "quarantined-recordings",
    ]);
    expect(alerts.every((alert) => alert.message.length > 0)).toBe(true);
  });

  it("does not invent warnings when the core reports healthy local state", () => {
    expect(buildPersistentAlerts({
      coreStatus: { startupRecovery: { pendingDeletionCount: 0, recoveredCount: 0 } },
      captureStatus: {},
      recordingStatus: { storageHealth: { level: "ok", availableBytes: 10_000 } },
      quarantinedCount: 0,
    })).toEqual([]);
  });
});
