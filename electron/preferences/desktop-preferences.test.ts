import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DesktopPreferencesService,
  defaultDesktopPreferences,
  parseDesktopPreferences,
} from "./desktop-preferences.js";

describe("desktop preferences", () => {
  const noOpPermissionEnforcer = async () => undefined;

  it("persists schema-v4 setup progress and the one-time existing-user prompt atomically", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "candor-desktop-preferences-"));
    try {
      const service = new DesktopPreferencesService({
        userDataPath: () => root,
        permissionEnforcer: noOpPermissionEnforcer,
      });
      await service.visitStep("microphone");
      await service.setStepDisposition("microphone", "completed");
      await service.setStepDisposition("shortcut", "deferred");
      await service.markExistingUserPromptShown();

      const reloaded = new DesktopPreferencesService({
        userDataPath: () => root,
        permissionEnforcer: noOpPermissionEnforcer,
      });
      await expect(reloaded.status()).resolves.toMatchObject({
        schemaVersion: 4,
        setup: {
          progress: "in-progress",
          completed: ["microphone"],
          deferred: ["shortcut"],
          lastStep: "shortcut",
          existingUserPromptShown: true,
          nonBlockingUpgrade: false,
        },
        localOnly: true,
        rawPathExposed: false,
        keyMaterialExposedToRenderer: false,
      });
      const destination = path.join(root, "preferences", "desktop-preferences.json");
      const serialized = await readFile(destination, "utf8");
      expect(serialized).not.toContain(root);
      if (process.platform !== "win32") {
        expect((await lstat(destination)).mode & 0o777).toBe(0o600);
      }
      const files = await import("node:fs/promises").then(({ readdir }) => readdir(path.dirname(destination)));
      expect(files.filter((file) => file.endsWith(".tmp"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("migrates schema-v2 setup preferences with the existing-user prompt unshown", () => {
    expect(parseDesktopPreferences({
      schemaVersion: 2,
      setup: {
        progress: "in-progress",
        completed: ["microphone"],
        deferred: [],
        lastStep: "microphone",
      },
    })).toEqual({
      schemaVersion: 4,
      setup: {
        progress: "in-progress",
        completed: ["microphone"],
        deferred: [],
        lastStep: "microphone",
        existingUserPromptShown: false,
        nonBlockingUpgrade: false,
      },
    });
  });

  it("does not reclassify schema-v3 setup state as a legacy pre-setup installation", () => {
    expect(parseDesktopPreferences({
      schemaVersion: 3,
      setup: {
        progress: "not-started",
        completed: [],
        deferred: [],
        lastStep: null,
        existingUserPromptShown: false,
      },
    })).toEqual({
      schemaVersion: 4,
      setup: {
        progress: "not-started",
        completed: [],
        deferred: [],
        lastStep: null,
        existingUserPromptShown: false,
        nonBlockingUpgrade: false,
      },
    });
  });

  it("snapshots and persists a genuine first launch as non-upgrade before core startup", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "candor-desktop-preferences-new-"));
    try {
      const firstDetector = vi.fn().mockResolvedValue(false);
      const service = new DesktopPreferencesService({
        userDataPath: () => root,
        permissionEnforcer: noOpPermissionEnforcer,
        legacyInstallationEvidence: firstDetector,
      });
      await expect(service.initialize()).resolves.toMatchObject({
        schemaVersion: 4,
        setup: { nonBlockingUpgrade: false },
        rawPathExposed: false,
      });
      expect(firstDetector).toHaveBeenCalledOnce();

      const laterDetector = vi.fn().mockResolvedValue(true);
      const reloaded = new DesktopPreferencesService({
        userDataPath: () => root,
        permissionEnforcer: noOpPermissionEnforcer,
        legacyInstallationEvidence: laterDetector,
      });
      await expect(reloaded.status()).resolves.toMatchObject({
        setup: { nonBlockingUpgrade: false },
      });
      expect(laterDetector).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("persists a detected legacy installation as a bounded non-blocking upgrade flag", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "candor-desktop-preferences-upgrade-"));
    try {
      const service = new DesktopPreferencesService({
        userDataPath: () => root,
        permissionEnforcer: noOpPermissionEnforcer,
        legacyInstallationEvidence: vi.fn().mockResolvedValue(true),
      });
      await expect(service.initialize()).resolves.toMatchObject({
        schemaVersion: 4,
        setup: {
          existingUserPromptShown: false,
          nonBlockingUpgrade: true,
        },
        rawPathExposed: false,
        keyMaterialExposedToRenderer: false,
      });
      const serialized = await readFile(path.join(root, "preferences", "desktop-preferences.json"), "utf8");
      expect(serialized).toContain('"nonBlockingUpgrade":true');
      expect(serialized).not.toContain(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("retains the pre-core decision and retries a transient first-write failure", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "candor-desktop-preferences-retry-"));
    try {
      let failPermissionOnce = true;
      const service = new DesktopPreferencesService({
        userDataPath: () => root,
        legacyInstallationEvidence: vi.fn().mockResolvedValue(false),
        permissionEnforcer: async () => {
          if (failPermissionOnce) {
            failPermissionOnce = false;
            throw new Error("simulated permission failure");
          }
        },
      });
      await expect(service.initialize()).rejects.toThrow("settings file could not be saved");
      await expect(service.status()).resolves.toMatchObject({
        setup: { nonBlockingUpgrade: false },
      });

      const detectorAfterCoreStartup = vi.fn().mockResolvedValue(true);
      const reloaded = new DesktopPreferencesService({
        userDataPath: () => root,
        permissionEnforcer: noOpPermissionEnforcer,
        legacyInstallationEvidence: detectorAfterCoreStartup,
      });
      await expect(reloaded.status()).resolves.toMatchObject({
        setup: { nonBlockingUpgrade: false },
      });
      expect(detectorAfterCoreStartup).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("serializes concurrent updates without losing a completed step", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "candor-desktop-preferences-"));
    try {
      const service = new DesktopPreferencesService({
        userDataPath: () => root,
        permissionEnforcer: noOpPermissionEnforcer,
      });
      await Promise.all([
        service.setStepDisposition("license", "completed"),
        service.setStepDisposition("microphone", "completed"),
        service.setStepDisposition("shortcut", "deferred"),
      ]);
      const status = await service.status();
      expect(status.setup.completed).toEqual(["license", "microphone"]);
      expect(status.setup.deferred).toEqual(["shortcut"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("fails closed to an incomplete default for corrupt, oversized, or future settings", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "candor-desktop-preferences-"));
    const destination = path.join(root, "preferences", "desktop-preferences.json");
    try {
      await import("node:fs/promises").then(({ mkdir }) => mkdir(path.dirname(destination), { recursive: true }));
      await writeFile(destination, JSON.stringify({ schemaVersion: 5, setup: {} }), "utf8");
      const service = new DesktopPreferencesService({
        userDataPath: () => root,
        maximumBytes: 256,
        permissionEnforcer: noOpPermissionEnforcer,
      });
      await expect(service.read()).resolves.toEqual(defaultDesktopPreferences());
      await writeFile(destination, "x".repeat(300), "utf8");
      await expect(service.read()).resolves.toEqual(defaultDesktopPreferences());
      await writeFile(destination, "{broken", "utf8");
      await expect(service.read()).resolves.toEqual(defaultDesktopPreferences());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires bounded unique, non-overlapping step lists and derived progress", () => {
    expect(parseDesktopPreferences({
      schemaVersion: 2,
      setup: {
        progress: "in-progress",
        completed: ["license", "license"],
        deferred: [],
        lastStep: "license",
        existingUserPromptShown: false,
      },
    })).toBeNull();
    expect(parseDesktopPreferences({
      schemaVersion: 2,
      setup: {
        progress: "completed",
        completed: ["license"],
        deferred: [],
        lastStep: "license",
        existingUserPromptShown: false,
      },
    })).toBeNull();
    expect(parseDesktopPreferences({
      schemaVersion: 2,
      setup: {
        progress: "in-progress",
        completed: ["shortcut"],
        deferred: ["shortcut"],
        lastStep: "shortcut",
        existingUserPromptShown: false,
      },
    })).toBeNull();
    expect(parseDesktopPreferences({
      schemaVersion: 4,
      setup: {
        progress: "not-started",
        completed: [],
        deferred: [],
        lastStep: null,
        existingUserPromptShown: "yes",
        nonBlockingUpgrade: false,
      },
    })).toBeNull();
  });

  it("marks an updated step complete, optionally visits the next step, and validates final completion", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "candor-desktop-preferences-"));
    try {
      const service = new DesktopPreferencesService({
        userDataPath: () => root,
        permissionEnforcer: noOpPermissionEnforcer,
      });
      await service.updateStep("license", "microphone");
      await expect(service.status()).resolves.toMatchObject({
        setup: { completed: ["license"], lastStep: "microphone", progress: "in-progress" },
      });
      await expect(service.completeSetup()).rejects.toThrow("Every setup step");
      await service.updateStep("microphone");
      await service.deferStep("shortcut");
      await service.deferStep("system-audio");
      await service.updateStep("storage");
      await service.deferStep("local-ai");
      await expect(service.completeSetup()).resolves.toMatchObject({ setup: { progress: "completed" } });

      await service.updateStep("shortcut", "system-audio");
      await expect(service.status()).resolves.toMatchObject({
        setup: {
          completed: ["license", "microphone", "storage", "shortcut"],
          deferred: ["system-audio", "local-ai"],
          lastStep: "system-audio",
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
});
