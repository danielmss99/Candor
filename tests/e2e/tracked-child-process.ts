export interface TrackedChildProcessLike {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  once(event: "exit", listener: (exitCode: number | null, signalCode: NodeJS.Signals | null) => void): unknown;
  off(event: "exit", listener: (exitCode: number | null, signalCode: NodeJS.Signals | null) => void): unknown;
}

export interface ExactProcessTreeTracker {
  refresh(): void;
  cleanup(): Promise<number[]>;
}

export interface TrackedChildExitResult {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  cleanupTerminatedPids: number[];
}

export class TrackedChildTimeoutError extends Error {
  constructor(readonly cleanupTerminatedPids: number[]) {
    super("Secondary Candor process did not yield to the primary instance lock.");
    this.name = "TrackedChildTimeoutError";
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function waitForTrackedChildExit(
  child: TrackedChildProcessLike,
  tracker: ExactProcessTreeTracker,
  options: { timeoutMs: number; cleanupExitTimeoutMs?: number },
): Promise<TrackedChildExitResult> {
  const timeoutMs = Math.max(10, Math.min(30_000, options.timeoutMs));
  const cleanupExitTimeoutMs = Math.max(10, Math.min(10_000, options.cleanupExitTimeoutMs ?? 5_000));
  let exitResult = child.exitCode !== null || child.signalCode !== null
    ? { exitCode: child.exitCode, signalCode: child.signalCode }
    : null;
  let resolveExit!: (result: { exitCode: number | null; signalCode: NodeJS.Signals | null }) => void;
  const exitPromise = new Promise<{ exitCode: number | null; signalCode: NodeJS.Signals | null }>((resolve) => {
    resolveExit = resolve;
  });
  const onExit = (exitCode: number | null, signalCode: NodeJS.Signals | null) => {
    exitResult = { exitCode, signalCode };
    resolveExit(exitResult);
  };
  child.once("exit", onExit);

  try {
    tracker.refresh();
    if (!exitResult) {
      exitResult = await Promise.race([
        exitPromise,
        delay(timeoutMs).then(() => null),
      ]);
    }

    if (exitResult) {
      const cleanupTerminatedPids = await tracker.cleanup();
      if (cleanupTerminatedPids.length > 0) {
        throw new Error(
          `Secondary Candor exited but left ${cleanupTerminatedPids.length} tracked descendant process(es).`,
        );
      }
      return { ...exitResult, cleanupTerminatedPids };
    }

    tracker.refresh();
    const cleanupTerminatedPids = await tracker.cleanup();
    const cleanupExit = child.exitCode !== null || child.signalCode !== null
      ? { exitCode: child.exitCode, signalCode: child.signalCode }
      : await Promise.race([
        exitPromise,
        delay(cleanupExitTimeoutMs).then(() => null),
      ]);
    if (!cleanupExit) {
      throw new Error("Tracked secondary Candor cleanup completed without an observed process exit.");
    }
    throw new TrackedChildTimeoutError(cleanupTerminatedPids);
  } finally {
    child.off("exit", onExit);
  }
}
