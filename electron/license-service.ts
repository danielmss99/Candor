import { app, safeStorage } from "electron";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type LicenseState = "inactive" | "trial" | "activated";
export type LicenseActivationSource = "none" | "local-trial" | "development-mock" | "production";

export interface LicenseStatus {
  state: LicenseState;
  planName: string;
  licenseId: string;
  activatedAt: string | null;
  trialEndsAt: string | null;
  trialDaysRemaining: number | null;
  activationSource: LicenseActivationSource;
  productionVerification: "pending" | "verified" | "not-configured";
  secureStorageAvailable: boolean;
  persistentAccountRequired: false;
  localOnly: true;
  deviceLabel: string;
  portalAvailable: boolean;
  portalActions: string[];
  rawPathExposed: false;
  keyMaterialExposedToRenderer: false;
}

export interface LicensePortalInfo {
  available: boolean;
  requiresSignInForNormalUse: false;
  status: LicenseStatus;
  actions: Array<{
    id: "view-status" | "deactivate-device" | "download-installers" | "download-receipts" | "future-upgrades";
    label: string;
    enabled: boolean;
    note: string;
  }>;
  rawPathExposed: false;
  keyMaterialExposedToRenderer: false;
}

interface StoredLicenseRecord {
  schemaVersion: 1;
  state: LicenseState;
  planName: string;
  licenseId: string;
  activatedAt: string | null;
  trialStartedAt: string | null;
  trialEndsAt: string | null;
  activationSource: LicenseActivationSource;
  productionVerification: "pending" | "verified" | "not-configured";
  deviceId: string;
  purchaserEmailHash: string | null;
}

interface LicenseServiceOptions {
  isDev: boolean;
  trialDays?: number;
}

const DEFAULT_TRIAL_DAYS = 14;
const PLAN_NAME = "Candor Professional";
const PORTAL_ACTIONS = [
  "View license status",
  "Deactivate this device",
  "Download installers",
  "Download receipts",
  "Future major upgrades",
];

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function publicLicenseIdFromKey(licenseKey: string): string {
  const normalized = licenseKey.trim().toUpperCase().replace(/\s+/g, "");
  const digest = sha256(normalized);
  return `DEV-${digest.slice(0, 4).toUpperCase()}-${digest.slice(4, 8).toUpperCase()}`;
}

function emptyStatus(secureStorageAvailable: boolean): LicenseStatus {
  return {
    state: "inactive",
    planName: PLAN_NAME,
    licenseId: "",
    activatedAt: null,
    trialEndsAt: null,
    trialDaysRemaining: null,
    activationSource: "none",
    productionVerification: "not-configured",
    secureStorageAvailable,
    persistentAccountRequired: false,
    localOnly: true,
    deviceLabel: deviceLabel(),
    portalAvailable: false,
    portalActions: PORTAL_ACTIONS,
    rawPathExposed: false,
    keyMaterialExposedToRenderer: false,
  };
}

function deviceLabel(): string {
  if (process.platform === "win32") return "This Windows device";
  if (process.platform === "darwin") return "This Mac";
  if (process.platform === "linux") return "This Linux device";
  return "This device";
}

function calculateTrialDaysRemaining(trialEndsAt: string | null): number | null {
  if (!trialEndsAt) return null;
  const endMs = Date.parse(trialEndsAt);
  if (!Number.isFinite(endMs)) return null;
  return Math.max(0, Math.ceil((endMs - Date.now()) / 86_400_000));
}

function toPublicStatus(record: StoredLicenseRecord | null, secureStorageAvailable: boolean): LicenseStatus {
  if (!record) return emptyStatus(secureStorageAvailable);
  return {
    state: record.state,
    planName: record.planName,
    licenseId: record.licenseId,
    activatedAt: record.activatedAt,
    trialEndsAt: record.trialEndsAt,
    trialDaysRemaining: calculateTrialDaysRemaining(record.trialEndsAt),
    activationSource: record.activationSource,
    productionVerification: record.productionVerification,
    secureStorageAvailable,
    persistentAccountRequired: false,
    localOnly: true,
    deviceLabel: deviceLabel(),
    portalAvailable: false,
    portalActions: PORTAL_ACTIONS,
    rawPathExposed: false,
    keyMaterialExposedToRenderer: false,
  };
}

export class LicenseService {
  private readonly isDev: boolean;
  private readonly trialDays: number;
  private readonly storagePath: string;

  constructor(options: LicenseServiceOptions) {
    this.isDev = options.isDev;
    this.trialDays = options.trialDays ?? DEFAULT_TRIAL_DAYS;
    this.storagePath = path.join(app.getPath("userData"), "license-state.bin");
  }

  async status(): Promise<LicenseStatus> {
    return toPublicStatus(await this.readRecord(), safeStorage.isEncryptionAvailable());
  }

  async activate(licenseKey: string, purchaserEmail = ""): Promise<LicenseStatus> {
    const normalizedKey = licenseKey.trim().toUpperCase().replace(/\s+/g, "");
    if (!normalizedKey) {
      throw new Error("Enter a license key or start a local trial.");
    }

    const mockAllowed = this.isDev || process.env.CANDOR_ENABLE_MOCK_LICENSE === "1";
    if (!mockAllowed || !normalizedKey.startsWith("CANDOR-DEV-")) {
      throw new Error("Production license verification is not connected yet. Use Start Trial, or use a CANDOR-DEV key in development.");
    }

    const now = new Date().toISOString();
    const record: StoredLicenseRecord = {
      schemaVersion: 1,
      state: "activated",
      planName: PLAN_NAME,
      licenseId: publicLicenseIdFromKey(normalizedKey),
      activatedAt: now,
      trialStartedAt: null,
      trialEndsAt: null,
      activationSource: "development-mock",
      productionVerification: "pending",
      deviceId: this.localDeviceId(),
      purchaserEmailHash: purchaserEmail.trim() ? sha256(purchaserEmail.trim().toLowerCase()) : null,
    };
    await this.writeRecord(record);
    return toPublicStatus(record, safeStorage.isEncryptionAvailable());
  }

  async startTrial(): Promise<LicenseStatus> {
    const current = await this.readRecord();
    if (current?.state === "activated") {
      return toPublicStatus(current, safeStorage.isEncryptionAvailable());
    }

    const started = new Date();
    const ends = new Date(started.getTime() + this.trialDays * 86_400_000);
    const record: StoredLicenseRecord = {
      schemaVersion: 1,
      state: "trial",
      planName: PLAN_NAME,
      licenseId: `TRIAL-${sha256(`${this.localDeviceId()}:${started.toISOString()}`).slice(0, 8).toUpperCase()}`,
      activatedAt: null,
      trialStartedAt: started.toISOString(),
      trialEndsAt: ends.toISOString(),
      activationSource: "local-trial",
      productionVerification: "not-configured",
      deviceId: this.localDeviceId(),
      purchaserEmailHash: null,
    };
    await this.writeRecord(record);
    return toPublicStatus(record, safeStorage.isEncryptionAvailable());
  }

  async deactivateDevice(): Promise<LicenseStatus> {
    await rm(this.storagePath, { force: true });
    return emptyStatus(safeStorage.isEncryptionAvailable());
  }

  async portalInfo(): Promise<LicensePortalInfo> {
    const status = await this.status();
    return {
      available: false,
      requiresSignInForNormalUse: false,
      status,
      actions: [
        {
          id: "view-status",
          label: "View license status",
          enabled: true,
          note: "Available locally in Settings.",
        },
        {
          id: "deactivate-device",
          label: "Deactivate this device",
          enabled: status.state !== "inactive",
          note: "Removes the local activation record from this computer.",
        },
        {
          id: "download-installers",
          label: "Download installers",
          enabled: false,
          note: "Pending production license portal.",
        },
        {
          id: "download-receipts",
          label: "Download receipts",
          enabled: false,
          note: "Pending production license portal.",
        },
        {
          id: "future-upgrades",
          label: "Future major upgrades",
          enabled: false,
          note: "Pending production license portal.",
        },
      ],
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
  }

  private async readRecord(): Promise<StoredLicenseRecord | null> {
    let bytes: Buffer;
    try {
      bytes = await readFile(this.storagePath);
    } catch {
      return null;
    }

    try {
      const json = safeStorage.isEncryptionAvailable()
        ? safeStorage.decryptString(bytes)
        : bytes.toString("utf8");
      const parsed = JSON.parse(json) as Partial<StoredLicenseRecord>;
      if (parsed.schemaVersion !== 1 || !parsed.state) return null;
      return {
        schemaVersion: 1,
        state: parsed.state,
        planName: parsed.planName || PLAN_NAME,
        licenseId: parsed.licenseId || "",
        activatedAt: parsed.activatedAt ?? null,
        trialStartedAt: parsed.trialStartedAt ?? null,
        trialEndsAt: parsed.trialEndsAt ?? null,
        activationSource: parsed.activationSource || "none",
        productionVerification: parsed.productionVerification || "not-configured",
        deviceId: parsed.deviceId || this.localDeviceId(),
        purchaserEmailHash: parsed.purchaserEmailHash ?? null,
      };
    } catch {
      return null;
    }
  }

  private async writeRecord(record: StoredLicenseRecord): Promise<void> {
    await mkdir(path.dirname(this.storagePath), { recursive: true });
    const json = JSON.stringify(record);
    const bytes = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(json)
      : Buffer.from(json, "utf8");
    await writeFile(this.storagePath, bytes);
  }

  private localDeviceId(): string {
    return sha256(`${os.hostname()}:${process.platform}:${os.arch()}`).slice(0, 24);
  }
}
