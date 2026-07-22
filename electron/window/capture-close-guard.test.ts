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
    const onCloseAborted = vi.fn();
    const guard = installCaptureCloseGuard(window as unknown as BrowserWindow, {
      phase: () => "idle",
      confirmStopAndQuit: vi.fn(async () => false),
      finalizeCapture: vi.fn(async () => undefined),
      activeBackgroundJobCount: vi.fn(async () => 0),
      confirmBackgroundJobs: vi.fn(async () => "keep-open" as const),
      pauseBackgroundJobs: vi.fn(async () => undefined),
      cancelBackgroundJobs: vi.fn(async () => undefined),
      shutdownCore,
      reportFailure: vi.fn(async () => undefined),
      onCloseAborted,
    });

    guard.requestClose();
    await settle();

    expect(shutdownCore).toHaveBeenCalledOnce();
    expect(guard.approved()).toBe(true);
    expect(window.isDestroyed()).toBe(true);
    expect(onCloseAborted).not.toHaveBeenCalled();
  });

  it("keeps recording when the user cancels close", async () => {
    const window = new FakeWindow();
    const finalizeCapture = vi.fn(async () => undefined);
    const shutdownCore = vi.fn(async () => undefined);
    const onCloseAborted = vi.fn();
    const guard = installCaptureCloseGuard(window as unknown as BrowserWindow, {
      phase: () => "recording",
      confirmStopAndQuit: vi.fn(async () => false),
      finalizeCapture,
      activeBackgroundJobCount: vi.fn(async () => 0),
      confirmBackgroundJobs: vi.fn(async () => "keep-open" as const),
      pauseBackgroundJobs: vi.fn(async () => undefined),
      cancelBackgroundJobs: vi.fn(async () => undefined),
      shutdownCore,
      reportFailure: vi.fn(async () => undefined),
      onCloseAborted,
    });

    guard.requestClose();
    await settle();

    expect(finalizeCapture).not.toHaveBeenCalled();
    expect(shutdownCore).not.toHaveBeenCalled();
    expect(guard.approved()).toBe(false);
    expect(window.isDestroyed()).toBe(false);
    expect(onCloseAborted).toHaveBeenCalledOnce();
  });

  it("finalizes capture before closing and stays open on failure", async () => {
    const safeWindow = new FakeWindow();
    const order: string[] = [];
    const safeGuard = installCaptureCloseGuard(safeWindow as unknown as BrowserWindow, {
      phase: () => "recording",
      confirmStopAndQuit: vi.fn(async () => true),
      finalizeCapture: vi.fn(async () => { order.push("finalize"); }),
      activeBackgroundJobCount: vi.fn(async () => 0),
      confirmBackgroundJobs: vi.fn(async () => "keep-open" as const),
      pauseBackgroundJobs: vi.fn(async () => undefined),
      cancelBackgroundJobs: vi.fn(async () => undefined),
      shutdownCore: vi.fn(async () => { order.push("shutdown"); }),
      reportFailure: vi.fn(async () => undefined),
    });

    safeGuard.requestClose();
    await settle();
    expect(order).toEqual(["finalize", "shutdown"]);
    expect(safeWindow.isDestroyed()).toBe(true);

    const failedWindow = new FakeWindow();
    const reportFailure = vi.fn(async () => undefined);
    const onCloseAborted = vi.fn();
    const failedGuard = installCaptureCloseGuard(failedWindow as unknown as BrowserWindow, {
      phase: () => "finalizing",
      confirmStopAndQuit: vi.fn(async () => true),
      finalizeCapture: vi.fn(async () => { throw new Error("CORE_CAPTURE_FINALIZE_TIMEOUT"); }),
      activeBackgroundJobCount: vi.fn(async () => 0),
      confirmBackgroundJobs: vi.fn(async () => "keep-open" as const),
      pauseBackgroundJobs: vi.fn(async () => undefined),
      cancelBackgroundJobs: vi.fn(async () => undefined),
      shutdownCore: vi.fn(async () => undefined),
      reportFailure,
      onCloseAborted,
    });

    failedGuard.requestClose();
    await settle();
    expect(reportFailure).toHaveBeenCalledOnce();
    expect(failedGuard.approved()).toBe(false);
    expect(failedWindow.isDestroyed()).toBe(false);
    expect(onCloseAborted).toHaveBeenCalledOnce();
  });

  it("requires an explicit choice when background jobs are active", async () => {
    const keepOpenWindow = new FakeWindow();
    const keepOpenShutdown = vi.fn(async () => undefined);
    const keepOpenGuard = installCaptureCloseGuard(keepOpenWindow as unknown as BrowserWindow, {
      phase: () => "idle",
      confirmStopAndQuit: vi.fn(async () => false),
      finalizeCapture: vi.fn(async () => undefined),
      activeBackgroundJobCount: vi.fn(async () => 2),
      confirmBackgroundJobs: vi.fn(async () => "keep-open" as const),
      pauseBackgroundJobs: vi.fn(async () => undefined),
      cancelBackgroundJobs: vi.fn(async () => undefined),
      shutdownCore: keepOpenShutdown,
      reportFailure: vi.fn(async () => undefined),
    });

    keepOpenGuard.requestClose();
    await settle();
    expect(keepOpenShutdown).not.toHaveBeenCalled();
    expect(keepOpenWindow.isDestroyed()).toBe(false);

    const pauseWindow = new FakeWindow();
    const pauseJobs = vi.fn(async () => undefined);
    const pauseShutdown = vi.fn(async () => undefined);
    const pauseGuard = installCaptureCloseGuard(pauseWindow as unknown as BrowserWindow, {
      phase: () => "idle",
      confirmStopAndQuit: vi.fn(async () => false),
      finalizeCapture: vi.fn(async () => undefined),
      activeBackgroundJobCount: vi.fn(async () => 1),
      confirmBackgroundJobs: vi.fn(async () => "pause-and-quit" as const),
      pauseBackgroundJobs: pauseJobs,
      cancelBackgroundJobs: vi.fn(async () => undefined),
      shutdownCore: pauseShutdown,
      reportFailure: vi.fn(async () => undefined),
    });

    pauseGuard.requestClose();
    await settle();
    expect(pauseJobs).toHaveBeenCalledOnce();
    expect(pauseShutdown).toHaveBeenCalledOnce();
    expect(pauseWindow.isDestroyed()).toBe(true);
  });
});
