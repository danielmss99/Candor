import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CaptureDegradedMetadata } from "./core-client.js";

export interface CaptureRecoveryRecord {
  schemaVersion: 1;
  recoveryRequired: true;
  recordedAt: string;
  method: string;
  recordingId: string | null;
  rawPathExposed: false;
}

const SAFE_METHOD = /^[a-z][A-Za-z0-9.]{1,95}$/;
const SAFE_RECORDING_ID = /^[A-Za-z0-9_-]{1,96}$/;

export class CaptureRecoveryStore {
  constructor(private readonly userDataPath: () => string) {}

  async persist(metadata: CaptureDegradedMetadata): Promise<void> {
    const directory = path.join(this.userDataPath(), "recovery");
    const destination = path.join(directory, "capture-connection.json");
    const temporary = `${destination}.tmp`;
    const record: CaptureRecoveryRecord = {
      schemaVersion: 1,
      recoveryRequired: true,
      recordedAt: metadata.at,
      method: SAFE_METHOD.test(metadata.method) ? metadata.method : "capture.status",
      recordingId: metadata.recordingId && SAFE_RECORDING_ID.test(metadata.recordingId)
        ? metadata.recordingId
        : null,
      rawPathExposed: false,
    };
    await mkdir(directory, { recursive: true });
    await writeFile(temporary, JSON.stringify(record), { encoding: "utf8", mode: 0o600, flag: "w" });
    await rename(temporary, destination);
  }

  async read(): Promise<CaptureRecoveryRecord | null> {
    try {
      const value = JSON.parse(await readFile(this.filePath(), "utf8")) as Record<string, unknown>;
      if (
        value.schemaVersion !== 1 ||
        value.recoveryRequired !== true ||
        typeof value.recordedAt !== "string" ||
        !Number.isFinite(Date.parse(value.recordedAt)) ||
        typeof value.method !== "string" ||
        !SAFE_METHOD.test(value.method) ||
        value.rawPathExposed !== false ||
        (value.recordingId !== null && !SAFE_RECORDING_ID.test(String(value.recordingId)))
      ) {
        return null;
      }
      return {
        schemaVersion: 1,
        recoveryRequired: true,
        recordedAt: value.recordedAt,
        method: value.method,
        recordingId: typeof value.recordingId === "string" ? value.recordingId : null,
        rawPathExposed: false,
      };
    } catch {
      return null;
    }
  }

  async clear(): Promise<void> {
    await rm(this.filePath(), { force: true });
  }

  private filePath(): string {
    return path.join(this.userDataPath(), "recovery", "capture-connection.json");
  }
}
