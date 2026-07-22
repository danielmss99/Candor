import { describe, expect, it, vi } from "vitest";
import { shutdownDesktopServicesForClose } from "./desktop-service-shutdown.js";

describe("desktop service shutdown", () => {
  it("keeps services alive when closing a macOS window without quitting", async () => {
    const core = { shutdown: vi.fn(async () => undefined) };
    const shortcuts = {
      suspendForShutdownSync: vi.fn(),
      resumeAfterShutdownFailure: vi.fn(async () => undefined),
    };
    await expect(shutdownDesktopServicesForClose({
      core,
      shortcuts,
      shouldShutdownServices: () => false,
    })).resolves.toBe(false);
    expect(shortcuts.suspendForShutdownSync).not.toHaveBeenCalled();
    expect(core.shutdown).not.toHaveBeenCalled();
  });

  it("suspends shortcuts before core shutdown", async () => {
    const order: string[] = [];
    const core = { shutdown: vi.fn(async () => { order.push("core"); }) };
    const shortcuts = {
      suspendForShutdownSync: vi.fn(() => { order.push("shortcuts"); }),
      resumeAfterShutdownFailure: vi.fn(async () => undefined),
    };
    await expect(shutdownDesktopServicesForClose({
      core,
      shortcuts,
      shouldShutdownServices: () => true,
    })).resolves.toBe(true);
    expect(order).toEqual(["shortcuts", "core"]);
  });

  it("restores shortcut registration when core shutdown fails and the window stays open", async () => {
    const error = new Error("core shutdown failed");
    const core = { shutdown: vi.fn(async () => { throw error; }) };
    const shortcuts = {
      suspendForShutdownSync: vi.fn(),
      resumeAfterShutdownFailure: vi.fn(async () => undefined),
    };
    await expect(shutdownDesktopServicesForClose({
      core,
      shortcuts,
      shouldShutdownServices: () => true,
    })).rejects.toBe(error);
    expect(shortcuts.suspendForShutdownSync).toHaveBeenCalledOnce();
    expect(shortcuts.resumeAfterShutdownFailure).toHaveBeenCalledOnce();
  });
});
