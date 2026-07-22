import path from "node:path";
import { AtomicJsonFile, type JsonObject } from "../preferences/atomic-json-file.js";
import { SUGGESTED_RECORDER_ACCELERATOR, normalizeAccelerator } from "./accelerator-policy.js";

export interface ShortcutSettings {
  schemaVersion: 1;
  enabled: boolean;
  accelerator: string;
}

export interface ShortcutSettingsRepository {
  read(): Promise<ShortcutSettings>;
  write(settings: ShortcutSettings): Promise<void>;
}

export interface ShortcutStoreOptions {
  userDataPath: () => string;
  fileName?: string;
  maximumBytes?: number;
}

const DEFAULT_FILE_NAME = "recorder-shortcut.json";
const MAXIMUM_SHORTCUT_BYTES = 8 * 1024;

export function defaultShortcutSettings(): ShortcutSettings {
  return {
    schemaVersion: 1,
    enabled: false,
    accelerator: SUGGESTED_RECORDER_ACCELERATOR,
  };
}

export function parseShortcutSettings(value: unknown): ShortcutSettings | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !["schemaVersion", "enabled", "accelerator"].includes(key))) return null;
  if (object.schemaVersion !== 1 || typeof object.enabled !== "boolean") return null;
  try {
    return {
      schemaVersion: 1,
      enabled: object.enabled,
      accelerator: normalizeAccelerator(object.accelerator),
    };
  } catch {
    return null;
  }
}

export class ShortcutStore implements ShortcutSettingsRepository {
  private readonly file: AtomicJsonFile;

  constructor(options: ShortcutStoreOptions) {
    const fileName = options.fileName ?? DEFAULT_FILE_NAME;
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(fileName)) throw new Error("Shortcut settings file name is invalid.");
    this.file = new AtomicJsonFile({
      filePath: path.join(options.userDataPath(), "preferences", fileName),
      maximumBytes: options.maximumBytes ?? MAXIMUM_SHORTCUT_BYTES,
    });
  }

  async read(): Promise<ShortcutSettings> {
    try {
      return parseShortcutSettings(await this.file.readObject()) ?? defaultShortcutSettings();
    } catch {
      return defaultShortcutSettings();
    }
  }

  async write(settings: ShortcutSettings): Promise<void> {
    const parsed = parseShortcutSettings(settings);
    if (!parsed) throw new Error("Shortcut settings are invalid.");
    await this.file.writeObject(parsed as unknown as JsonObject);
  }
}
