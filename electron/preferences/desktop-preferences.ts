import path from "node:path";
import {
  AtomicJsonFile,
  type JsonObject,
  type UserOnlyFilePermissionEnforcer,
} from "./atomic-json-file.js";

export const SETUP_STEPS = [
  "license",
  "microphone",
  "shortcut",
  "system-audio",
  "storage",
  "local-ai",
] as const;

export type SetupStep = typeof SETUP_STEPS[number];
export type SetupProgress = "not-started" | "in-progress" | "completed";
export type SetupStepDisposition = "completed" | "deferred" | "pending";

export interface SetupPreferences {
  progress: SetupProgress;
  completed: SetupStep[];
  deferred: SetupStep[];
  lastStep: SetupStep | null;
  existingUserPromptShown: boolean;
  nonBlockingUpgrade: boolean;
}

export interface DesktopPreferences {
  schemaVersion: 4;
  setup: SetupPreferences;
}

export interface DesktopPreferencesStatus extends DesktopPreferences {
  localOnly: true;
  rawPathExposed: false;
  keyMaterialExposedToRenderer: false;
}

export interface DesktopPreferencesServiceOptions {
  userDataPath: () => string;
  fileName?: string;
  maximumBytes?: number;
  permissionEnforcer?: UserOnlyFilePermissionEnforcer;
  legacyInstallationEvidence?: () => Promise<boolean>;
}

const DEFAULT_FILE_NAME = "desktop-preferences.json";
const MAXIMUM_PREFERENCES_BYTES = 16 * 1024;
const SETUP_STEP_SET = new Set<string>(SETUP_STEPS);

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyFields(value: JsonObject, fields: readonly string[]): boolean {
  const allowed = new Set(fields);
  return Object.keys(value).every((field) => allowed.has(field));
}

export function isSetupStep(value: unknown): value is SetupStep {
  return typeof value === "string" && SETUP_STEP_SET.has(value);
}

function parseStepList(value: unknown): SetupStep[] | null {
  if (!Array.isArray(value) || value.length > SETUP_STEPS.length) return null;
  const steps: SetupStep[] = [];
  for (const item of value) {
    if (!isSetupStep(item) || steps.includes(item)) return null;
    steps.push(item);
  }
  return steps;
}

function deriveProgress(
  completed: readonly SetupStep[],
  deferred: readonly SetupStep[],
  lastStep: SetupStep | null,
): SetupProgress {
  const handled = new Set<SetupStep>([...completed, ...deferred]);
  if (handled.size === SETUP_STEPS.length) return "completed";
  if (handled.size > 0 || lastStep !== null) return "in-progress";
  return "not-started";
}

export function defaultDesktopPreferences(nonBlockingUpgrade = false): DesktopPreferences {
  return {
    schemaVersion: 4,
    setup: {
      progress: "not-started",
      completed: [],
      deferred: [],
      lastStep: null,
      existingUserPromptShown: false,
      nonBlockingUpgrade,
    },
  };
}

export function parseDesktopPreferences(value: unknown): DesktopPreferences | null {
  if (!isObject(value) || !hasOnlyFields(value, ["schemaVersion", "setup"])) return null;
  if ((value.schemaVersion !== 2 && value.schemaVersion !== 3 && value.schemaVersion !== 4) || !isObject(value.setup)) return null;
  const setup = value.setup;
  const isSchemaV2 = value.schemaVersion === 2;
  const isSchemaV4 = value.schemaVersion === 4;
  const setupFields = isSchemaV2
    ? ["progress", "completed", "deferred", "lastStep"]
    : isSchemaV4
      ? ["progress", "completed", "deferred", "lastStep", "existingUserPromptShown", "nonBlockingUpgrade"]
      : ["progress", "completed", "deferred", "lastStep", "existingUserPromptShown"];
  if (!hasOnlyFields(setup, setupFields)) return null;
  const completed = parseStepList(setup.completed);
  const deferred = parseStepList(setup.deferred);
  const lastStep = setup.lastStep === null ? null : isSetupStep(setup.lastStep) ? setup.lastStep : undefined;
  const existingUserPromptShown = isSchemaV2 ? false : setup.existingUserPromptShown;
  const nonBlockingUpgrade = isSchemaV4 ? setup.nonBlockingUpgrade : false;
  if (
    !completed
    || !deferred
    || lastStep === undefined
    || typeof existingUserPromptShown !== "boolean"
    || typeof nonBlockingUpgrade !== "boolean"
  ) return null;
  if (completed.some((step) => deferred.includes(step))) return null;
  const progress = deriveProgress(completed, deferred, lastStep);
  if (setup.progress !== progress) return null;
  return {
    schemaVersion: 4,
    setup: { progress, completed, deferred, lastStep, existingUserPromptShown, nonBlockingUpgrade },
  };
}

export function desktopPreferencesStatus(preferences: DesktopPreferences): DesktopPreferencesStatus {
  return {
    ...preferences,
    setup: {
      ...preferences.setup,
      completed: [...preferences.setup.completed],
      deferred: [...preferences.setup.deferred],
    },
    localOnly: true,
    rawPathExposed: false,
    keyMaterialExposedToRenderer: false,
  };
}

export class DesktopPreferencesService {
  private readonly file: AtomicJsonFile;
  private readonly legacyInstallationEvidence: () => Promise<boolean>;
  private queue: Promise<void> = Promise.resolve();
  private initializedPreferences: DesktopPreferences | null = null;
  private initialPersistencePending = false;

  constructor(options: DesktopPreferencesServiceOptions) {
    const fileName = options.fileName ?? DEFAULT_FILE_NAME;
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(fileName)) throw new Error("Desktop preferences file name is invalid.");
    this.file = new AtomicJsonFile({
      filePath: path.join(options.userDataPath(), "preferences", fileName),
      maximumBytes: options.maximumBytes ?? MAXIMUM_PREFERENCES_BYTES,
      permissionEnforcer: options.permissionEnforcer,
    });
    this.legacyInstallationEvidence = options.legacyInstallationEvidence ?? (async () => false);
  }

  initialize(): Promise<DesktopPreferencesStatus> {
    return this.status();
  }

  read(): Promise<DesktopPreferences> {
    return this.exclusive(async () => this.readUnlocked());
  }

  async status(): Promise<DesktopPreferencesStatus> {
    return desktopPreferencesStatus(await this.read());
  }

  visitStep(step: SetupStep): Promise<DesktopPreferencesStatus> {
    return this.mutate((current) => ({
      ...current,
      setup: {
        ...current.setup,
        progress: deriveProgress(current.setup.completed, current.setup.deferred, step),
        lastStep: step,
      },
    }));
  }

  setStepDisposition(step: SetupStep, disposition: SetupStepDisposition): Promise<DesktopPreferencesStatus> {
    return this.mutate((current) => {
      const completed = current.setup.completed.filter((item) => item !== step);
      const deferred = current.setup.deferred.filter((item) => item !== step);
      if (disposition === "completed") completed.push(step);
      if (disposition === "deferred") deferred.push(step);
      return {
        ...current,
        setup: {
          ...current.setup,
          progress: deriveProgress(completed, deferred, step),
          completed,
          deferred,
          lastStep: step,
        },
      };
    });
  }

  updateStep(step: SetupStep, visit: SetupStep | null = null): Promise<DesktopPreferencesStatus> {
    return this.mutate((current) => {
      const completed = current.setup.completed.filter((item) => item !== step);
      const deferred = current.setup.deferred.filter((item) => item !== step);
      completed.push(step);
      const lastStep = visit ?? step;
      return {
        ...current,
        setup: {
          ...current.setup,
          progress: deriveProgress(completed, deferred, lastStep),
          completed,
          deferred,
          lastStep,
        },
      };
    });
  }

  deferStep(step: SetupStep): Promise<DesktopPreferencesStatus> {
    return this.setStepDisposition(step, "deferred");
  }

  markExistingUserPromptShown(): Promise<DesktopPreferencesStatus> {
    return this.mutate((current) => ({
      ...current,
      setup: {
        ...current.setup,
        existingUserPromptShown: true,
      },
    }));
  }

  completeSetup(): Promise<DesktopPreferencesStatus> {
    return this.exclusive(async () => {
      const current = await this.readUnlocked();
      const handled = new Set<SetupStep>([
        ...current.setup.completed,
        ...current.setup.deferred,
      ]);
      if (handled.size !== SETUP_STEPS.length) {
        throw new Error("Every setup step must be completed or deferred before setup can finish.");
      }
      return desktopPreferencesStatus(current);
    });
  }

  private mutate(update: (current: DesktopPreferences) => DesktopPreferences): Promise<DesktopPreferencesStatus> {
    return this.exclusive(async () => {
      const current = await this.readUnlocked();
      const next = update(current);
      await this.file.writeObject(next as unknown as JsonObject);
      this.initializedPreferences = next;
      this.initialPersistencePending = false;
      return desktopPreferencesStatus(next);
    });
  }

  private async readUnlocked(): Promise<DesktopPreferences> {
    if (this.initializedPreferences) {
      if (this.initialPersistencePending) {
        try {
          await this.file.writeObject(this.initializedPreferences as unknown as JsonObject);
          this.initialPersistencePending = false;
        } catch {
          // Keep the pre-core snapshot for this process and retry on the next
          // serialized preferences operation. Existing data remains reachable.
        }
      }
      return this.initializedPreferences;
    }
    let stored: JsonObject | null;
    try {
      stored = await this.file.readObject();
    } catch {
      const fallback = defaultDesktopPreferences();
      this.initializedPreferences = fallback;
      return fallback;
    }
    if (stored === null) {
      const nonBlockingUpgrade = await this.legacyInstallationEvidence().catch(() => false);
      const created = defaultDesktopPreferences(nonBlockingUpgrade === true);
      await this.persistInitialPreferences(created);
      return created;
    }
    const parsed = parseDesktopPreferences(stored);
    if (!parsed) {
      const fallback = defaultDesktopPreferences();
      this.initializedPreferences = fallback;
      return fallback;
    }
    if (stored.schemaVersion !== 4) await this.persistInitialPreferences(parsed);
    else this.initializedPreferences = parsed;
    return parsed;
  }

  private async persistInitialPreferences(preferences: DesktopPreferences): Promise<void> {
    try {
      await this.file.writeObject(preferences as unknown as JsonObject);
      this.initializedPreferences = preferences;
      this.initialPersistencePending = false;
    } catch (error) {
      // The classification was captured before core startup. Retaining it in
      // memory prevents a later handshake-created root from changing the
      // current session, while later operations retry the atomic publication.
      this.initializedPreferences = preferences;
      this.initialPersistencePending = true;
      throw error;
    }
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}
