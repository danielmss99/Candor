import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  removeTemporaryDirectory,
  stopChildProcess,
  waitForChildClose,
} from "./child-process-cleanup.mjs";

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.exitCode = null;
    this.signalCode = null;
    this.pid = 4242;
    this.kill = vi.fn();
  }

  closeNormally() {
    this.exitCode = 0;
    this.emit("close", 0, null);
  }

  closeFromSignal() {
    this.signalCode = "SIGKILL";
    this.emit("close", null, "SIGKILL");
  }
}

describe("child process cleanup", () => {
  it("waits for a graceful close without sending another signal", async () => {
    const child = new FakeChild();
    setTimeout(() => child.closeNormally(), 5);
    await expect(stopChildProcess(child, {
      platform: "win32",
      gracefulTimeoutMs: 100,
      forcedTimeoutMs: 100,
    })).resolves.toEqual({ forced: false });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("forces and then awaits the complete Windows process-tree close", async () => {
    const child = new FakeChild();
    const spawnSyncImpl = vi.fn(() => {
      setTimeout(() => child.closeFromSignal(), 5);
      return { status: 0 };
    });
    await expect(stopChildProcess(child, {
      platform: "win32",
      gracefulTimeoutMs: 5,
      forcedTimeoutMs: 100,
      spawnSyncImpl,
    })).resolves.toEqual({ forced: true });
    expect(spawnSyncImpl).toHaveBeenCalledWith(
      "taskkill",
      ["/PID", "4242", "/T", "/F"],
      { stdio: "ignore", windowsHide: true },
    );
  });

  it("reports a child that remains live after bounded cleanup", async () => {
    const child = new FakeChild();
    await expect(stopChildProcess(child, {
      platform: "linux",
      gracefulTimeoutMs: 5,
      forcedTimeoutMs: 5,
    })).rejects.toThrow("did not exit during smoke cleanup");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(await waitForChildClose(child, 1)).toBe(false);
  });

  it("removes temporary data with bounded Windows lock retries", () => {
    const rmSyncImpl = vi.fn();
    removeTemporaryDirectory("C:\\Temp\\candor-smoke", { rmSyncImpl });
    expect(rmSyncImpl).toHaveBeenCalledWith("C:\\Temp\\candor-smoke", {
      recursive: true,
      force: true,
      maxRetries: 120,
      retryDelay: 250,
    });
  });
});
