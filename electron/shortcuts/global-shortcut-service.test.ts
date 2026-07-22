import { describe, expect, it, vi } from "vitest";
import { SUGGESTED_RECORDER_ACCELERATOR } from "./accelerator-policy.js";
import {
  GlobalShortcutService,
  ShortcutServiceError,
  type GlobalShortcutAdapter,
  type ShortcutScheduler,
} from "./global-shortcut-service.js";
import { defaultShortcutSettings, type ShortcutSettings, type ShortcutSettingsRepository } from "./shortcut-store.js";

class FakeStore implements ShortcutSettingsRepository {
  writes: ShortcutSettings[] = [];
  failWrites = false;

  constructor(public value: ShortcutSettings = defaultShortcutSettings(), private readonly events?: string[]) {}

  async read(): Promise<ShortcutSettings> {
    return { ...this.value };
  }

  async write(settings: ShortcutSettings): Promise<void> {
    this.events?.push(`write:${settings.accelerator}:${settings.enabled}`);
    if (this.failWrites) throw new Error("disk unavailable at a private path");
    this.value = { ...settings };
    this.writes.push({ ...settings });
  }
}

class FakeAdapter implements GlobalShortcutAdapter {
  callbacks = new Map<string, () => void>();
  conflicts = new Set<string>();

  constructor(private readonly events?: string[]) {}

  register(accelerator: string, callback: () => void): boolean {
    this.events?.push(`register:${accelerator}`);
    if (this.conflicts.has(accelerator)) return false;
    this.callbacks.set(accelerator, callback);
    return true;
  }

  unregister(accelerator: string): void {
    this.events?.push(`unregister:${accelerator}`);
    this.callbacks.delete(accelerator);
  }
}

class FakeScheduler implements ShortcutScheduler {
  callback: (() => void) | null = null;
  cleared = false;

  setTimeout(callback: () => void): unknown {
    this.callback = callback;
    return "timer";
  }

  clearTimeout(): void {
    this.cleared = true;
    this.callback = null;
  }

  flush(): void {
    const callback = this.callback;
    this.callback = null;
    callback?.();
  }
}

describe("global shortcut service", () => {
  it("keeps the suggested shortcut disabled until explicit opt-in", async () => {
    const adapter = new FakeAdapter();
    const service = new GlobalShortcutService({
      adapter,
      store: new FakeStore(),
      target: { showAndFocusRecorder: vi.fn() },
    });
    await expect(service.initialize()).resolves.toMatchObject({
      enabled: false,
      accelerator: SUGGESTED_RECORDER_ACCELERATOR,
      registered: false,
      state: "disabled",
      recordsAudio: false,
      keyMaterialExposedToRenderer: false,
    });
    expect(adapter.callbacks.size).toBe(0);
  });

  it("initializes an enabled shortcut only once across duplicate calls", async () => {
    const events: string[] = [];
    const adapter = new FakeAdapter(events);
    const service = new GlobalShortcutService({
      adapter,
      store: new FakeStore({
        schemaVersion: 1,
        enabled: true,
        accelerator: SUGGESTED_RECORDER_ACCELERATOR,
      }),
      target: { showAndFocusRecorder: vi.fn() },
    });

    await Promise.all([service.initialize(), service.initialize()]);

    expect(events.filter((event) => event === `register:${SUGGESTED_RECORDER_ACCELERATOR}`)).toHaveLength(1);
    expect(adapter.callbacks.size).toBe(1);
    expect(service.status()).toMatchObject({ registered: true, state: "registered" });
  });

  it("opens only the fixed recorder target and debounces key repeat", async () => {
    const adapter = new FakeAdapter();
    const scheduler = new FakeScheduler();
    const showAndFocusRecorder = vi.fn();
    const store = new FakeStore({
      schemaVersion: 1,
      enabled: true,
      accelerator: SUGGESTED_RECORDER_ACCELERATOR,
    });
    const service = new GlobalShortcutService({
      adapter,
      store,
      scheduler,
      target: { showAndFocusRecorder },
    });
    await service.initialize();
    const callback = adapter.callbacks.get(SUGGESTED_RECORDER_ACCELERATOR);
    callback?.();
    callback?.();
    expect(showAndFocusRecorder).toHaveBeenCalledTimes(1);
    scheduler.flush();
    callback?.();
    expect(showAndFocusRecorder).toHaveBeenCalledTimes(2);
  });

  it("registers the new accelerator before persistence and unregisters the old one last", async () => {
    const events: string[] = [];
    const adapter = new FakeAdapter(events);
    const store = new FakeStore({
      schemaVersion: 1,
      enabled: true,
      accelerator: SUGGESTED_RECORDER_ACCELERATOR,
    }, events);
    const service = new GlobalShortcutService({
      adapter,
      store,
      target: { showAndFocusRecorder: vi.fn() },
    });
    await service.initialize();
    events.length = 0;
    await service.configure({ enabled: true, accelerator: "CommandOrControl+Shift+R" });
    expect(events).toEqual([
      "register:CommandOrControl+Shift+R",
      "write:CommandOrControl+Shift+R:true",
      `unregister:${SUGGESTED_RECORDER_ACCELERATOR}`,
    ]);
  });

  it("leaves the old registration and persistence untouched on conflict", async () => {
    const adapter = new FakeAdapter();
    const store = new FakeStore({
      schemaVersion: 1,
      enabled: true,
      accelerator: SUGGESTED_RECORDER_ACCELERATOR,
    });
    const service = new GlobalShortcutService({ adapter, store, target: { showAndFocusRecorder: vi.fn() } });
    await service.initialize();
    adapter.conflicts.add("CommandOrControl+Shift+R");
    await expect(service.configure({ enabled: true, accelerator: "CommandOrControl+Shift+R" }))
      .rejects.toMatchObject({ code: "SHORTCUT_CONFLICT" });
    expect(adapter.callbacks.has(SUGGESTED_RECORDER_ACCELERATOR)).toBe(true);
    expect(store.writes).toEqual([]);
    expect(service.status()).toMatchObject({ accelerator: SUGGESTED_RECORDER_ACCELERATOR, registered: true });
  });

  it("cleans up a binding when the adapter throws after an OS-side registration", async () => {
    const callbacks = new Map<string, () => void>();
    const unregister = vi.fn((accelerator: string) => callbacks.delete(accelerator));
    const adapter: GlobalShortcutAdapter = {
      register(accelerator, callback) {
        callbacks.set(accelerator, callback);
        throw new Error("adapter failed after registration");
      },
      unregister,
    };
    const store = new FakeStore();
    const service = new GlobalShortcutService({ adapter, store, target: { showAndFocusRecorder: vi.fn() } });

    await expect(service.configure({ enabled: true, accelerator: "CommandOrControl+Shift+R" }))
      .rejects.toMatchObject({ code: "SHORTCUT_REGISTRATION_FAILED" });
    expect(unregister).toHaveBeenCalledWith("CommandOrControl+Shift+R");
    expect(callbacks.size).toBe(0);
    expect(store.writes).toEqual([]);
    expect(service.status()).toMatchObject({ enabled: false, registered: false, state: "disabled" });
  });

  it("rolls back a newly registered accelerator when persistence fails", async () => {
    const adapter = new FakeAdapter();
    const store = new FakeStore({
      schemaVersion: 1,
      enabled: true,
      accelerator: SUGGESTED_RECORDER_ACCELERATOR,
    });
    const service = new GlobalShortcutService({ adapter, store, target: { showAndFocusRecorder: vi.fn() } });
    await service.initialize();
    store.failWrites = true;
    await expect(service.configure({ enabled: true, accelerator: "CommandOrControl+Shift+R" }))
      .rejects.toMatchObject({ code: "SHORTCUT_PERSISTENCE_FAILED" });
    expect(adapter.callbacks.has("CommandOrControl+Shift+R")).toBe(false);
    expect(adapter.callbacks.has(SUGGESTED_RECORDER_ACCELERATOR)).toBe(true);
    expect(service.status()).toMatchObject({ accelerator: SUGGESTED_RECORDER_ACCELERATOR, registered: true });
  });

  it("persists opt-out before unregistering and cleans up registration and timers", async () => {
    const events: string[] = [];
    const adapter = new FakeAdapter(events);
    const scheduler = new FakeScheduler();
    const store = new FakeStore({
      schemaVersion: 1,
      enabled: true,
      accelerator: SUGGESTED_RECORDER_ACCELERATOR,
    }, events);
    const service = new GlobalShortcutService({
      adapter,
      store,
      scheduler,
      target: { showAndFocusRecorder: vi.fn() },
    });
    await service.initialize();
    adapter.callbacks.get(SUGGESTED_RECORDER_ACCELERATOR)?.();
    events.length = 0;
    await service.configure({ enabled: false });
    expect(events).toEqual([
      `write:${SUGGESTED_RECORDER_ACCELERATOR}:false`,
      `unregister:${SUGGESTED_RECORDER_ACCELERATOR}`,
    ]);
    service.disposeSync();
    expect(scheduler.cleared).toBe(true);
    expect(service.status()).toMatchObject({ state: "disposed", registered: false });
  });

  it("reports a persisted startup conflict without silently rewriting opt-in", async () => {
    const adapter = new FakeAdapter();
    adapter.conflicts.add(SUGGESTED_RECORDER_ACCELERATOR);
    const store = new FakeStore({
      schemaVersion: 1,
      enabled: true,
      accelerator: SUGGESTED_RECORDER_ACCELERATOR,
    });
    const service = new GlobalShortcutService({ adapter, store, target: { showAndFocusRecorder: vi.fn() } });
    await expect(service.initialize()).resolves.toMatchObject({
      enabled: true,
      registered: false,
      state: "conflict",
    });
    expect(store.writes).toEqual([]);
  });

  it("resets to the disabled suggested accelerator", async () => {
    const adapter = new FakeAdapter();
    const store = new FakeStore({
      schemaVersion: 1,
      enabled: true,
      accelerator: "CommandOrControl+Shift+R",
    });
    const service = new GlobalShortcutService({ adapter, store, target: { showAndFocusRecorder: vi.fn() } });
    await service.initialize();
    await expect(service.reset()).resolves.toMatchObject({
      enabled: false,
      accelerator: SUGGESTED_RECORDER_ACCELERATOR,
      registered: false,
      state: "disabled",
    });
    expect(adapter.callbacks.size).toBe(0);
  });

  it("uses stable safe error types for invalid accelerators", async () => {
    const service = new GlobalShortcutService({
      adapter: new FakeAdapter(),
      store: new FakeStore(),
      target: { showAndFocusRecorder: vi.fn() },
    });
    let caught: unknown;
    try {
      await service.configure({ enabled: true, accelerator: "Space" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ShortcutServiceError);
    expect(caught).toMatchObject({ code: "SHORTCUT_INVALID_ACCELERATOR" });
  });

  it("synchronously suspends registration and restores persisted opt-in after failed shutdown", async () => {
    const events: string[] = [];
    const adapter = new FakeAdapter(events);
    const store = new FakeStore({
      schemaVersion: 1,
      enabled: true,
      accelerator: SUGGESTED_RECORDER_ACCELERATOR,
    });
    const service = new GlobalShortcutService({
      adapter,
      store,
      target: { showAndFocusRecorder: vi.fn() },
    });
    await service.initialize();
    events.length = 0;

    service.suspendForShutdownSync();
    expect(events).toEqual([`unregister:${SUGGESTED_RECORDER_ACCELERATOR}`]);
    expect(adapter.callbacks.size).toBe(0);
    expect(service.status()).toMatchObject({ enabled: true, registered: false, state: "unavailable" });
    await expect(service.configure({ enabled: false })).rejects.toMatchObject({
      code: "SHORTCUT_SERVICE_SUSPENDED",
    });

    await expect(service.resumeAfterShutdownFailure()).resolves.toMatchObject({
      enabled: true,
      registered: true,
      state: "registered",
    });
    expect(adapter.callbacks.has(SUGGESTED_RECORDER_ACCELERATOR)).toBe(true);
    expect(store.writes).toEqual([]);
  });

  it("unregisters active and pending accelerators synchronously during shutdown", async () => {
    const adapter = new FakeAdapter();
    let releaseWrite: () => void = () => undefined;
    let announceWrite: () => void = () => undefined;
    const writeStarted = new Promise<void>((resolve) => { announceWrite = resolve; });
    const store: ShortcutSettingsRepository = {
      read: async () => ({
        schemaVersion: 1,
        enabled: true,
        accelerator: SUGGESTED_RECORDER_ACCELERATOR,
      }),
      write: async () => {
        announceWrite();
        await new Promise<void>((resolve) => { releaseWrite = resolve; });
      },
    };
    const service = new GlobalShortcutService({ adapter, store, target: { showAndFocusRecorder: vi.fn() } });
    await service.initialize();
    const configuring = service.configure({ enabled: true, accelerator: "CommandOrControl+Shift+R" });
    await writeStarted;
    expect(adapter.callbacks.size).toBe(2);
    service.disposeSync();
    expect(adapter.callbacks.size).toBe(0);
    expect(service.status().state).toBe("disposed");
    releaseWrite();
    await expect(configuring).rejects.toMatchObject({ code: "SHORTCUT_SERVICE_DISPOSED" });
    expect(adapter.callbacks.size).toBe(0);
  });
});
