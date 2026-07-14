import type { BrowserWindow } from "electron";
import type { CaptureGuardPhase } from "../core/core-client.js";

interface CloseEventLike {
  preventDefault(): void;
}

interface GuardedWindow {
  on(event: "close", listener: (event: CloseEventLike) => void): unknown;
  close(): void;
  isDestroyed(): boolean;
}

export interface CaptureCloseGuardDependencies {
  phase(): CaptureGuardPhase;
  confirmStopAndQuit(window: BrowserWindow, phase: CaptureGuardPhase): Promise<boolean>;
  finalizeCapture(): Promise<void>;
  activeBackgroundJobCount(): Promise<number>;
  confirmBackgroundJobs(
    window: BrowserWindow,
    activeCount: number,
  ): Promise<"keep-open" | "pause-and-quit" | "cancel-and-quit">;
  pauseBackgroundJobs(): Promise<void>;
  cancelBackgroundJobs(): Promise<void>;
  shutdownCore(): Promise<void>;
  reportFailure(window: BrowserWindow, message: string): Promise<void>;
}

export interface CaptureCloseGuard {
  approved(): boolean;
  requestClose(): void;
}

function closeFailureMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  if (value.includes("CORE_CAPTURE_FINALIZE_TIMEOUT")) {
    return "Candor is still finalizing the recording. Keep the app open and try again.";
  }
  return "Candor could not safely finalize the recording. The app will remain open.";
}

export function installCaptureCloseGuard(
  window: BrowserWindow,
  dependencies: CaptureCloseGuardDependencies,
): CaptureCloseGuard {
  const guardedWindow = window as unknown as GuardedWindow;
  let closeApproved = false;
  let closeInProgress = false;

  const approveAndClose = async () => {
    await dependencies.shutdownCore();
    closeApproved = true;
    if (!guardedWindow.isDestroyed()) guardedWindow.close();
  };

  guardedWindow.on("close", (event) => {
    if (closeApproved) return;
    event.preventDefault();
    if (closeInProgress) return;
    closeInProgress = true;

    void (async () => {
      try {
        const phase = dependencies.phase();
        if (phase !== "idle") {
          const confirmed = await dependencies.confirmStopAndQuit(window, phase);
          if (!confirmed) return;
          await dependencies.finalizeCapture();
        }
        const activeCount = await dependencies.activeBackgroundJobCount();
        if (activeCount > 0) {
          const decision = await dependencies.confirmBackgroundJobs(window, activeCount);
          if (decision === "keep-open") return;
          if (decision === "cancel-and-quit") await dependencies.cancelBackgroundJobs();
          else await dependencies.pauseBackgroundJobs();
        }
        await approveAndClose();
      } catch (error) {
        await dependencies.reportFailure(window, closeFailureMessage(error));
      } finally {
        closeInProgress = false;
      }
    })();
  });

  return {
    approved: () => closeApproved,
    requestClose: () => {
      if (!guardedWindow.isDestroyed()) guardedWindow.close();
    },
  };
}
