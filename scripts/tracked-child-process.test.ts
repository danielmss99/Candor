import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  TrackedChildTimeoutError,
  waitForTrackedChildExit,
  type ExactProcessTreeTracker,
  type TrackedChildProcessLike,
} from "../tests/e2e/tracked-child-process";

class FakeChild extends EventEmitter implements TrackedChildProcessLike {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  exit(exitCode: number | null, signalCode: NodeJS.Signals | null = null): void {
    this.exitCode = exitCode;
    this.signalCode = signalCode;
    this.emit("exit", exitCode, signalCode);
  }
}

describe("tracked secondary-process supervision", () => {
  it("verifies exact-tree cleanup after a successful process exit", async () => {
    const child = new FakeChild();
    const tracker: ExactProcessTreeTracker = {
      refresh: vi.fn(() => child.exit(0)),
      cleanup: vi.fn(async () => []),
    };

    await expect(waitForTrackedChildExit(child, tracker, { timeoutMs: 100 })).resolves.toEqual({
      exitCode: 0,
      signalCode: null,
      cleanupTerminatedPids: [],
    });
    expect(tracker.refresh).toHaveBeenCalledOnce();
    expect(tracker.cleanup).toHaveBeenCalledOnce();
    expect(child.listenerCount("exit")).toBe(0);
  });

  it("cleans the exact tracked tree, observes exit, and then reports timeout", async () => {
    const child = new FakeChild();
    const tracker: ExactProcessTreeTracker = {
      refresh: vi.fn(),
      cleanup: vi.fn(async () => {
        child.exit(1);
        return [321, 322];
      }),
    };

    const result = waitForTrackedChildExit(child, tracker, {
      timeoutMs: 10,
      cleanupExitTimeoutMs: 100,
    });
    await expect(result).rejects.toEqual(expect.objectContaining({
      name: "TrackedChildTimeoutError",
      cleanupTerminatedPids: [321, 322],
    } satisfies Partial<TrackedChildTimeoutError>));
    expect(tracker.refresh).toHaveBeenCalledTimes(2);
    expect(tracker.cleanup).toHaveBeenCalledOnce();
    expect(child.listenerCount("exit")).toBe(0);
  });

  it("fails closed when cleanup cannot produce an observed child exit", async () => {
    const child = new FakeChild();
    const tracker: ExactProcessTreeTracker = {
      refresh: vi.fn(),
      cleanup: vi.fn(async () => [321]),
    };

    await expect(waitForTrackedChildExit(child, tracker, {
      timeoutMs: 10,
      cleanupExitTimeoutMs: 10,
    })).rejects.toThrow("without an observed process exit");
    expect(child.listenerCount("exit")).toBe(0);
  });
});
