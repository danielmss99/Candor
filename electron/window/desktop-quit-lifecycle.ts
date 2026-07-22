export interface FinalLiveTranscriptShutdown {
  dispose(): void;
}

export interface FinalShortcutShutdown {
  disposeSync(): void;
}

export interface FinalCoreShutdown {
  shutdown(): Promise<void>;
}

export interface DesktopFinalShutdownServices {
  liveTranscriptEvents: FinalLiveTranscriptShutdown;
  shortcuts: FinalShortcutShutdown;
  core: FinalCoreShutdown;
}

export interface DesktopFinalQuitControl {
  preventQuit(): void;
  requestQuit(): void;
}

/**
 * Tracks a requested quit separately from final process teardown. Electron can
 * cancel `before-quit` while a recording close prompt is open, so irreversible
 * service disposal belongs exclusively to `will-quit`.
 */
export class DesktopQuitLifecycle {
  private quitRequested = false;
  private finalization: Promise<void> | null = null;
  private finalized = false;

  markBeforeQuit(): void {
    this.quitRequested = true;
  }

  cancelQuit(): void {
    this.quitRequested = false;
  }

  shouldShutdownServicesOnClose(platform: NodeJS.Platform): boolean {
    return platform !== "darwin" || this.quitRequested;
  }

  holdFinalQuit(
    services: DesktopFinalShutdownServices,
    control: DesktopFinalQuitControl,
  ): Promise<void> | null {
    if (this.finalized) return null;
    control.preventQuit();
    if (!this.finalization) {
      this.finalization = this.finalizeServices(services).then(() => {
        this.finalized = true;
        control.requestQuit();
      });
    }
    return this.finalization;
  }

  private async finalizeServices(services: DesktopFinalShutdownServices): Promise<void> {
    try {
      services.liveTranscriptEvents.dispose();
    } catch {
      // Final process teardown must continue through every fixed service.
    }
    try {
      services.shortcuts.disposeSync();
    } catch {
      // The bounded core shutdown remains required even if disposal fails.
    }
    await services.core.shutdown().catch(() => undefined);
  }
}
