import type { BrowserWindow } from "electron";
import { describe, expect, it, vi } from "vitest";
import { installCaptureCloseGuard } from "./capture-close-guard.js";

class FakeWindow {
  private closeListener: ((event: { preventDefault(): void }) => void) | null = null;
  private destroyed = false;
  closeAttempts = 0;

  on(_event: "close", listener: (event: { preventDefault(): void }) => void) {
    this.closeListener = listener;
  }

  close() {
    this.closeAttempts += 1;
    let prevented = false;
    this.closeListener?.({ preventDefault: () => { prevented = true; } });
    if (!prevented) this.destroyed = true;
  }

  isDestroyed() {
    return this.destroyed;
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("capture close guard", () => {
  it("closes an idle app only after core shutdown", async () => {
    const window = new FakeWindow();
    const shutdownCore = vi.fn(async () => undefined);
    const guard = installCaptureCloseGuard(window as unknown as BrowserWindow, {
      phase: () => "idle",
      confirmStopAndQuit: vi.fn(async () => false),
      finalizeCapture: vi.fn(async () => undefined),
      shutdownCore,
      reportFailure: vi.fn(async () => undefined),
    });

    guard.requestClose();
    await settle();

    expect(shutdownCore).toHaveBeenCalledOnce();
    expect(guard.approved()).toBe(true);
    expect(window.isDestroyed()).toBe(true);
  });

  it("keeps recording when the user cancels close", async () => {
    const window = new FakeWindow();
    const finalizeCapture = vi.fn(async () => undefined);
    const shutdownCore = vi.fn(async () => undefined);
    const guard = installCaptureCloseGuard(window as unknown as BrowserWindow, {
      phase: () => "recording",
      confirmStopAndQuit: vi.fn(async () => false),
      finalizeCapture,
      shutdownCore,
      reportFailure: vi.fn(async () => undefined),
    });

    guard.requestClose();
    await settle();

    expect(finalizeCapture).not.toHaveBeenCalled();
    expect(shutdownCore).not.toHaveBeenCalled();
    expect(guard.approved()).toBe(false);
    expect(window.isDestroyed()).toBe(false);
  });

  it("finalizes capture before closing and stays open on failure", async () => {
    const safeWindow = new FakeWindow();
    const order: string[] = [];
    const safeGuard = installCaptureCloseGuard(safeWindow as unknown as BrowserWindow, {
      phase: () => "recording",
      confirmStopAndQuit: vi.fn(async () => true),
      finalizeCapture: vi.fn(async () => { order.push("finalize"); }),
      shutdownCore: vi.fn(async () => { order.push("shutdown"); }),
      reportFailure: vi.fn(async () => undefined),
    });

    safeGuard.requestClose();
    await settle();
    expect(order).toEqual(["finalize", "shutdown"]);
    expect(safeWindow.isDestroyed()).toBe(true);

    const failedWindow = new FakeWindow();
    const reportFailure = vi.fn(async () => undefined);
    const failedGuard = installCaptureCloseGuard(failedWindow as unknown as BrowserWindow, {
      phase: () => "finalizing",
      confirmStopAndQuit: vi.fn(async () => true),
      finalizeCapture: vi.fn(async () => { throw new Error("CORE_CAPTURE_FINALIZE_TIMEOUT"); }),
      shutdownCore: vi.fn(async () => undefined),
      reportFailure,
    });

    failedGuard.requestClose();
    await settle();
    expect(reportFailure).toHaveBeenCalledOnce();
    expect(failedGuard.approved()).toBe(false);
    expect(failedWindow.isDestroyed()).toBe(false);
  });
});
