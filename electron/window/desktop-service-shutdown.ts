export interface DesktopCoreShutdown {
  shutdown(): Promise<void>;
}

export interface DesktopShortcutShutdown {
  suspendForShutdownSync(): void;
  resumeAfterShutdownFailure(): Promise<unknown>;
}

export interface DesktopServiceShutdownOptions {
  core: DesktopCoreShutdown;
  shortcuts: DesktopShortcutShutdown;
  shouldShutdownServices(): boolean;
}

export async function shutdownDesktopServicesForClose(
  options: DesktopServiceShutdownOptions,
): Promise<boolean> {
  if (!options.shouldShutdownServices()) return false;
  options.shortcuts.suspendForShutdownSync();
  try {
    await options.core.shutdown();
    return true;
  } catch (error) {
    await options.shortcuts.resumeAfterShutdownFailure();
    throw error;
  }
}
