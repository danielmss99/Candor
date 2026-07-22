import {
  AcceleratorPolicyError,
  SUGGESTED_RECORDER_ACCELERATOR,
  normalizeAccelerator,
} from "./accelerator-policy.js";
import {
  defaultShortcutSettings,
  type ShortcutSettings,
  type ShortcutSettingsRepository,
} from "./shortcut-store.js";

export interface GlobalShortcutAdapter {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

export interface RecorderShortcutActivationTarget {
  showAndFocusRecorder(): void | Promise<void>;
}

export interface ShortcutScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type ShortcutRuntimeState = "disabled" | "registered" | "conflict" | "unavailable" | "disposed";

export interface GlobalShortcutStatus {
  schemaVersion: 1;
  enabled: boolean;
  accelerator: string;
  suggestedAccelerator: typeof SUGGESTED_RECORDER_ACCELERATOR;
  registered: boolean;
  state: ShortcutRuntimeState;
  activationBehavior: "show-and-focus-recorder";
  recordsAudio: false;
  localOnly: true;
  rawPathExposed: false;
  keyMaterialExposedToRenderer: false;
}

export interface GlobalShortcutConfiguration {
  enabled: boolean;
  accelerator?: string;
}

export type ShortcutServiceErrorCode =
  | "SHORTCUT_INVALID_ACCELERATOR"
  | "SHORTCUT_CONFLICT"
  | "SHORTCUT_REGISTRATION_FAILED"
  | "SHORTCUT_PERSISTENCE_FAILED"
  | "SHORTCUT_SERVICE_SUSPENDED"
  | "SHORTCUT_SERVICE_DISPOSED";

export class ShortcutServiceError extends Error {
  constructor(readonly code: ShortcutServiceErrorCode, message: string) {
    super(message);
    this.name = "ShortcutServiceError";
  }
}

export interface GlobalShortcutServiceOptions {
  adapter: GlobalShortcutAdapter;
  store: ShortcutSettingsRepository;
  target: RecorderShortcutActivationTarget;
  debounceMs?: number;
  scheduler?: ShortcutScheduler;
  onActivationError?: () => void;
}

const defaultScheduler: ShortcutScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class GlobalShortcutService {
  private readonly adapter: GlobalShortcutAdapter;
  private readonly store: ShortcutSettingsRepository;
  private readonly target: RecorderShortcutActivationTarget;
  private readonly scheduler: ShortcutScheduler;
  private readonly debounceMs: number;
  private readonly onActivationError: () => void;
  private settings: ShortcutSettings = defaultShortcutSettings();
  private activeAccelerator: string | null = null;
  private pendingAccelerator: string | null = null;
  private state: ShortcutRuntimeState = "disabled";
  private initialized = false;
  private suspended = false;
  private disposed = false;
  private activationBlocked = false;
  private activationTimer: unknown = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: GlobalShortcutServiceOptions) {
    this.adapter = options.adapter;
    this.store = options.store;
    this.target = options.target;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.debounceMs = Math.max(100, Math.min(2_000, options.debounceMs ?? 300));
    this.onActivationError = options.onActivationError ?? (() => undefined);
  }

  initialize(): Promise<GlobalShortcutStatus> {
    return this.exclusive(async () => {
      await this.initializeUnlocked();
      return this.status();
    });
  }

  configure(configuration: GlobalShortcutConfiguration): Promise<GlobalShortcutStatus> {
    return this.exclusive(async () => {
      this.assertOperational();
      await this.initializeUnlocked();
      const accelerator = this.normalizeConfigurationAccelerator(configuration.accelerator);
      const desired: ShortcutSettings = { schemaVersion: 1, enabled: configuration.enabled, accelerator };

      if (!desired.enabled) {
        await this.persist(desired);
        this.assertOperational();
        const previous = this.activeAccelerator;
        this.settings = desired;
        this.activeAccelerator = null;
        this.state = "disabled";
        if (previous) this.unregisterBestEffort(previous);
        return this.status();
      }

      if (this.activeAccelerator === desired.accelerator) {
        await this.persist(desired);
        this.assertOperational();
        this.settings = desired;
        this.state = "registered";
        return this.status();
      }

      const previousSettings = this.settings;
      const previousAccelerator = this.activeAccelerator;
      const previousState = this.state;
      this.registerOrThrow(desired.accelerator);
      this.pendingAccelerator = desired.accelerator;
      try {
        await this.persist(desired);
      } catch (error) {
        this.unregisterBestEffort(desired.accelerator);
        this.pendingAccelerator = null;
        this.settings = previousSettings;
        this.activeAccelerator = previousAccelerator;
        this.state = previousState;
        throw error;
      }

      if (this.disposed || this.suspended) {
        this.unregisterBestEffort(desired.accelerator);
        this.pendingAccelerator = null;
        throw this.lifecycleError();
      }

      this.settings = desired;
      this.activeAccelerator = desired.accelerator;
      this.pendingAccelerator = null;
      this.state = "registered";
      if (previousAccelerator && previousAccelerator !== desired.accelerator) {
        this.unregisterBestEffort(previousAccelerator);
      }
      return this.status();
    });
  }

  reset(): Promise<GlobalShortcutStatus> {
    return this.configure({ enabled: false, accelerator: SUGGESTED_RECORDER_ACCELERATOR });
  }

  status(): GlobalShortcutStatus {
    return {
      schemaVersion: 1,
      enabled: this.settings.enabled,
      accelerator: this.settings.accelerator,
      suggestedAccelerator: SUGGESTED_RECORDER_ACCELERATOR,
      registered: this.activeAccelerator === this.settings.accelerator && this.state === "registered",
      state: this.disposed ? "disposed" : this.suspended ? "unavailable" : this.state,
      activationBehavior: "show-and-focus-recorder",
      recordsAudio: false,
      localOnly: true,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
  }

  dispose(): Promise<void> {
    this.disposeSync();
    return Promise.resolve();
  }

  suspendForShutdownSync(): void {
    if (this.disposed || this.suspended) return;
    this.suspended = true;
    if (this.activationTimer !== null) {
      this.scheduler.clearTimeout(this.activationTimer);
      this.activationTimer = null;
    }
    this.activationBlocked = false;
    const registrations = new Set([this.activeAccelerator, this.pendingAccelerator]);
    registrations.forEach((accelerator) => {
      if (accelerator) this.unregisterBestEffort(accelerator);
    });
    this.activeAccelerator = null;
    this.pendingAccelerator = null;
    this.state = this.settings.enabled ? "unavailable" : "disabled";
  }

  resumeAfterShutdownFailure(): Promise<GlobalShortcutStatus> {
    return this.exclusive(async () => {
      this.assertNotDisposed();
      if (!this.suspended) return this.status();
      const settings = await this.store.read().catch(() => ({ ...this.settings }));
      this.assertNotDisposed();
      this.settings = settings;
      this.initialized = true;
      this.suspended = false;
      if (!settings.enabled) {
        this.state = "disabled";
        return this.status();
      }
      try {
        this.registerOrThrow(settings.accelerator);
        this.activeAccelerator = settings.accelerator;
        this.state = "registered";
      } catch (error) {
        this.activeAccelerator = null;
        this.state = error instanceof ShortcutServiceError && error.code === "SHORTCUT_CONFLICT"
          ? "conflict"
          : "unavailable";
      }
      return this.status();
    });
  }

  disposeSync(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.suspended = false;
    if (this.activationTimer !== null) {
      this.scheduler.clearTimeout(this.activationTimer);
      this.activationTimer = null;
    }
    this.activationBlocked = false;
    const registrations = new Set([this.activeAccelerator, this.pendingAccelerator]);
    registrations.forEach((accelerator) => {
      if (accelerator) this.unregisterBestEffort(accelerator);
    });
    this.activeAccelerator = null;
    this.pendingAccelerator = null;
    this.state = "disposed";
  }

  private async initializeUnlocked(): Promise<void> {
    this.assertOperational();
    if (this.initialized) return;
    this.settings = await this.store.read();
    this.assertOperational();
    this.initialized = true;
    if (!this.settings.enabled) {
      this.state = "disabled";
      return;
    }
    try {
      this.registerOrThrow(this.settings.accelerator);
      this.activeAccelerator = this.settings.accelerator;
      this.state = "registered";
    } catch (error) {
      if (error instanceof ShortcutServiceError && error.code === "SHORTCUT_CONFLICT") {
        this.state = "conflict";
        return;
      }
      this.state = "unavailable";
    }
  }

  private normalizeConfigurationAccelerator(value: string | undefined): string {
    try {
      return normalizeAccelerator(value ?? this.settings.accelerator);
    } catch (error) {
      if (error instanceof AcceleratorPolicyError) {
        throw new ShortcutServiceError("SHORTCUT_INVALID_ACCELERATOR", error.message);
      }
      throw error;
    }
  }

  private registerOrThrow(accelerator: string): void {
    let registered = false;
    try {
      registered = this.adapter.register(accelerator, () => this.activate());
    } catch {
      // A defensive adapter may fail after the OS accepted the binding. Always
      // issue a matching cleanup before reporting failure so an untracked
      // registration cannot survive a partially successful adapter call.
      this.unregisterBestEffort(accelerator);
      throw new ShortcutServiceError(
        "SHORTCUT_REGISTRATION_FAILED",
        "The keyboard shortcut could not be registered on this computer.",
      );
    }
    if (!registered) {
      throw new ShortcutServiceError(
        "SHORTCUT_CONFLICT",
        "That keyboard shortcut is already in use by another application.",
      );
    }
  }

  private async persist(settings: ShortcutSettings): Promise<void> {
    try {
      await this.store.write(settings);
    } catch {
      throw new ShortcutServiceError(
        "SHORTCUT_PERSISTENCE_FAILED",
        "The keyboard shortcut could not be saved. The previous shortcut is still active.",
      );
    }
  }

  private activate(): void {
    if (this.disposed || this.suspended || this.activationBlocked) return;
    this.activationBlocked = true;
    this.activationTimer = this.scheduler.setTimeout(() => {
      this.activationBlocked = false;
      this.activationTimer = null;
    }, this.debounceMs);
    try {
      const result = this.target.showAndFocusRecorder();
      if (result && typeof (result as PromiseLike<void>).then === "function") {
        Promise.resolve(result).catch(() => this.onActivationError());
      }
    } catch {
      this.onActivationError();
    }
  }

  private unregisterBestEffort(accelerator: string): void {
    try {
      this.adapter.unregister(accelerator);
    } catch {
      // Electron unregister is normally infallible. Cleanup remains best effort during shutdown.
    }
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new ShortcutServiceError("SHORTCUT_SERVICE_DISPOSED", "The keyboard shortcut service is unavailable.");
    }
  }

  private assertOperational(): void {
    this.assertNotDisposed();
    if (this.suspended) throw this.lifecycleError();
  }

  private lifecycleError(): ShortcutServiceError {
    return this.disposed
      ? new ShortcutServiceError("SHORTCUT_SERVICE_DISPOSED", "The keyboard shortcut service is unavailable.")
      : new ShortcutServiceError("SHORTCUT_SERVICE_SUSPENDED", "The keyboard shortcut service is pausing for shutdown.");
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}
