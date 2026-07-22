import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SUGGESTED_RECORDER_ACCELERATOR } from "./accelerator-policy.js";
import { ShortcutStore, defaultShortcutSettings, parseShortcutSettings } from "./shortcut-store.js";

describe("shortcut store", () => {
  it("defaults to the suggested accelerator in an explicitly disabled state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "candor-shortcut-store-"));
    try {
      const store = new ShortcutStore({ userDataPath: () => root });
      await expect(store.read()).resolves.toEqual(defaultShortcutSettings());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists a canonical accelerator atomically with private permissions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "candor-shortcut-store-"));
    try {
      const store = new ShortcutStore({ userDataPath: () => root });
      await store.write({ schemaVersion: 1, enabled: true, accelerator: "shift+cmdorctrl+space" });
      await expect(store.read()).resolves.toEqual({
        schemaVersion: 1,
        enabled: true,
        accelerator: SUGGESTED_RECORDER_ACCELERATOR,
      });
      const destination = path.join(root, "preferences", "recorder-shortcut.json");
      const serialized = await readFile(destination, "utf8");
      expect(serialized).not.toContain(root);
      if (process.platform !== "win32") {
        expect((await lstat(destination)).mode & 0o777).toBe(0o600);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed to disabled defaults for corrupt or unsafe persisted values", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "candor-shortcut-store-"));
    const destination = path.join(root, "preferences", "recorder-shortcut.json");
    try {
      await import("node:fs/promises").then(({ mkdir }) => mkdir(path.dirname(destination), { recursive: true }));
      await writeFile(destination, JSON.stringify({ schemaVersion: 1, enabled: true, accelerator: "Space" }), "utf8");
      const store = new ShortcutStore({ userDataPath: () => root });
      await expect(store.read()).resolves.toEqual(defaultShortcutSettings());
      await expect(store.write({ schemaVersion: 1, enabled: true, accelerator: "Alt+F4" })).rejects.toThrow(
        "Shortcut settings are invalid.",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unknown fields and future schemas", () => {
    expect(parseShortcutSettings({
      schemaVersion: 1,
      enabled: false,
      accelerator: SUGGESTED_RECORDER_ACCELERATOR,
      rawPath: "private",
    })).toBeNull();
    expect(parseShortcutSettings({
      schemaVersion: 2,
      enabled: false,
      accelerator: SUGGESTED_RECORDER_ACCELERATOR,
    })).toBeNull();
  });
});
