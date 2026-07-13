import {
  asBool,
  asNumber,
  asObject,
  asString,
  type JsonObject,
  type PersistentAlert,
} from "../../core/contracts";

interface SystemAlertInput {
  coreStatus: JsonObject;
  captureStatus: JsonObject;
  recordingStatus: JsonObject;
  quarantinedCount: number;
}

function formatAvailableBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "Unknown space";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB available`;
  return `${Math.max(0, Math.floor(bytes / 1024 ** 2))} MiB available`;
}

export function buildPersistentAlerts(input: SystemAlertInput): PersistentAlert[] {
  const alerts: PersistentAlert[] = [];
  const storage = asObject(input.recordingStatus.storageHealth);
  const storageLevel = asString(storage.level, "unavailable");
  if (storageLevel === "unavailable") {
    alerts.push({
      id: "storage-unavailable",
      severity: "error",
      title: "Local storage check unavailable",
      message: "New recordings are blocked until Candor can verify free space on this device.",
    });
  } else if (storageLevel === "blocking") {
    alerts.push({
      id: "storage-blocking",
      severity: "error",
      title: asBool(storage.canContinueCapture) ? "New recordings blocked by low storage" : "Recording storage exhausted",
      message: `${formatAvailableBytes(asNumber(storage.availableBytes, -1))}. Free local space before recording again.`,
    });
  } else if (storageLevel === "low") {
    alerts.push({
      id: "storage-low",
      severity: "warning",
      title: "Local storage is running low",
      message: `${formatAvailableBytes(asNumber(storage.availableBytes, -1))}. Candor can still record locally.`,
    });
  }

  const activeSession = asObject(input.captureStatus.activeSession);
  if (asString(activeSession.integrityStatus) === "failed" || asString(activeSession.lastError)) {
    alerts.push({
      id: "capture-integrity",
      severity: "error",
      title: "Recording needs recovery",
      message: "Candor stopped accepting audio after a durable-write failure. Stop the session to preserve its recovery state.",
    });
  }

  const startupRecovery = asObject(input.coreStatus.startupRecovery);
  const pendingDeletionCount = asNumber(startupRecovery.pendingDeletionCount);
  if (pendingDeletionCount > 0) {
    alerts.push({
      id: "pending-deletion",
      severity: "error",
      title: "Deletion cleanup is pending",
      message: `${pendingDeletionCount} local deletion ${pendingDeletionCount === 1 ? "operation" : "operations"} will retry automatically.`,
    });
  }

  if (input.quarantinedCount > 0) {
    alerts.push({
      id: "quarantined-recordings",
      severity: "warning",
      title: "Some meetings need recovery",
      message: `${input.quarantinedCount} ${input.quarantinedCount === 1 ? "meeting is" : "meetings are"} preserved untouched and hidden from normal results.`,
    });
  }

  const recoveredCount = asNumber(startupRecovery.recoveredCount);
  if (recoveredCount > 0) {
    alerts.push({
      id: "recovered-recordings",
      severity: "info",
      title: "Interrupted recording recovered",
      message: `${recoveredCount} ${recoveredCount === 1 ? "meeting is" : "meetings are"} ready for review.`,
    });
  }
  return alerts;
}
