import { createHash } from "node:crypto";
import { objectValue, type JsonValue } from "../core/json.js";

const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

export interface DiagnosticReportInput {
  appVersion: string;
  platform: string;
  arch: string;
  packaged: boolean;
  supervisor: JsonValue;
  coreStatus: JsonValue;
  coreVersion: JsonValue;
  vaultStatus: JsonValue;
  recordingStatus: JsonValue;
  captureStatus: JsonValue;
  privacyAudit: JsonValue;
  updateStatus: JsonValue;
}

function safeToken(value: unknown, fallback = "unavailable"): string {
  return typeof value === "string" && SAFE_TOKEN.test(value) ? value : fallback;
}

function safeErrorCode(value: unknown): string | null {
  return typeof value === "string" && SAFE_ERROR_CODE.test(value) ? value : null;
}

function safeInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function safeBoolean(value: unknown): boolean {
  return value === true;
}

function safeFeatureList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && SAFE_TOKEN.test(item)).slice(0, 32)
    : [];
}

export function buildDiagnosticReport(input: DiagnosticReportInput): JsonValue {
  const supervisor = objectValue(input.supervisor);
  const handshake = objectValue(supervisor.lastHandshake ?? null);
  const handshakeVersion = objectValue(handshake.version ?? null);
  const handshakeBuild = objectValue(handshakeVersion.build ?? null);
  const core = objectValue(input.coreStatus);
  const startupRecovery = objectValue(core.startupRecovery ?? null);
  const version = objectValue(input.coreVersion);
  const versionBuild = objectValue(version.build ?? null);
  const vault = objectValue(input.vaultStatus);
  const recording = objectValue(input.recordingStatus);
  const capture = objectValue(input.captureStatus);
  const privacy = objectValue(input.privacyAudit);
  const updates = objectValue(input.updateStatus);

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    contentPolicy: "metadata-only-no-user-content",
    app: {
      version: safeToken(input.appVersion),
      platform: safeToken(input.platform),
      arch: safeToken(input.arch),
      packaged: input.packaged,
    },
    core: {
      supervisorState: safeToken(supervisor.state),
      restartCount: safeInteger(supervisor.restartCount),
      handshakeOk: safeBoolean(handshake.ok),
      version: safeToken(version.version ?? handshakeVersion.version),
      protocolVersion: safeToken(version.protocolVersion ?? handshakeVersion.protocolVersion),
      schemaVersion: safeInteger(version.schemaVersion ?? handshakeVersion.schemaVersion),
      target: safeToken(versionBuild.target ?? handshakeBuild.target),
      features: safeFeatureList(versionBuild.features ?? handshakeBuild.features),
      startupRecovery: {
        attempted: safeBoolean(startupRecovery.attempted),
        ok: safeBoolean(startupRecovery.ok),
        recoveredCount: safeInteger(startupRecovery.recoveredCount),
        errorCode: safeErrorCode(startupRecovery.errorCode),
      },
    },
    storage: {
      vaultState: safeToken(vault.state),
      vaultBackend: safeToken(vault.backend),
      encrypted: safeBoolean(vault.encrypted),
      sqlcipherAvailable: safeBoolean(vault.sqlcipherAvailable),
      osKeyStorageAvailable: safeBoolean(vault.osKeyStorageAvailable),
      durableChunks: safeBoolean(recording.durableChunks),
      durableAudioChunks: safeBoolean(recording.durableAudioChunks),
      recordingCount: safeInteger(recording.recordingCount),
      chunkEncryptionAvailable: safeBoolean(recording.chunkEncryptionAvailable),
    },
    capture: {
      active: safeBoolean(capture.active),
      implementation: safeToken(capture.implementation),
    },
    privacy: {
      networkPolicy: safeToken(core.networkPolicy),
      externalCallsAttempted: safeInteger(privacy.externalCallsAttempted),
      userContentIncluded: false,
      rawPathsIncluded: false,
      processIdsIncluded: false,
      secretsIncluded: false,
    },
    updates: {
      policy: safeToken(updates.policy),
      backgroundChecks: safeBoolean(updates.backgroundChecks),
      startupCheck: safeBoolean(updates.startupCheck),
      attemptedChecks: safeInteger(updates.attemptedChecks),
    },
  };
}

export function diagnosticReportBytes(report: JsonValue): Buffer {
  return Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8");
}

export function diagnosticReportSha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
