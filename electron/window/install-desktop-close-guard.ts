import { dialog, type BrowserWindow } from "electron";
import type { CoreClient } from "../core/core-client.js";
import type { GlobalShortcutService } from "../shortcuts/global-shortcut-service.js";
import { installCaptureCloseGuard } from "./capture-close-guard.js";
import { shutdownDesktopServicesForClose } from "./desktop-service-shutdown.js";

export interface DesktopCloseGuardOptions {
  core: CoreClient;
  shortcuts: GlobalShortcutService;
  e2eMode: boolean;
  shouldShutdownServicesOnClose(): boolean;
  onCloseAborted?(): void;
}

function activeCountFromResult(value: unknown): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  const activeCount = (value as Record<string, unknown>).activeCount;
  return typeof activeCount === "number" && Number.isSafeInteger(activeCount)
    ? activeCount
    : 0;
}

export function installDesktopCloseGuard(
  window: BrowserWindow,
  options: DesktopCloseGuardOptions,
): void {
  installCaptureCloseGuard(window, {
    phase: () => options.core.captureGuardPhase(),
    confirmStopAndQuit: async (target, phase) => {
      const detail = phase === "recording"
        ? "Candor is recording. Stop and save the recording before quitting?"
        : "Candor is changing recording state. Wait for a durable save before quitting?";
      const result = await dialog.showMessageBox(target, {
        type: "warning",
        title: "Recording in progress",
        message: "Keep Candor open until the recording is safe.",
        detail,
        buttons: ["Keep recording", "Stop, save, and quit"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      return result.response === 1;
    },
    finalizeCapture: () => options.core.finalizeCaptureForClose(),
    activeBackgroundJobCount: async () => {
      if (options.e2eMode) return 0;
      const response = await options.core.call("jobs.activeSummary", null);
      if (!response.ok) throw new Error(response.error?.code ?? "JOB_SUMMARY_FAILED");
      return activeCountFromResult(response.result);
    },
    confirmBackgroundJobs: async (target, activeCount) => {
      const noun = activeCount === 1 ? "job is" : "jobs are";
      const result = await dialog.showMessageBox(target, {
        type: "question",
        title: "Background processing is still in progress",
        message: `${activeCount} local ${noun} still running.`,
        detail: "Keep Candor open to finish now, pause safely until the next launch, or cancel the jobs without deleting meeting data.",
        buttons: ["Keep Candor running", "Pause and close", "Cancel jobs and close"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (result.response === 1) return "pause-and-quit";
      if (result.response === 2) return "cancel-and-quit";
      return "keep-open";
    },
    pauseBackgroundJobs: async () => {
      const response = await options.core.call("jobs.pauseAll", null);
      if (!response.ok) throw new Error(response.error?.code ?? "JOB_PAUSE_FAILED");
    },
    cancelBackgroundJobs: async () => {
      const response = await options.core.call("jobs.cancelAll", null);
      if (!response.ok) throw new Error(response.error?.code ?? "JOB_CANCEL_FAILED");
    },
    shutdownCore: async () => void await shutdownDesktopServicesForClose({
      core: options.core,
      shortcuts: options.shortcuts,
      shouldShutdownServices: options.shouldShutdownServicesOnClose,
    }),
    reportFailure: async (target, message) => {
      await dialog.showMessageBox(target, {
        type: "error",
        title: "Recording not yet safe to close",
        message,
        buttons: ["Keep Candor open"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
    },
    onCloseAborted: options.onCloseAborted,
  });
}
