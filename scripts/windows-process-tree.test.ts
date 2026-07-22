import { describe, expect, it, vi } from "vitest";
import {
  collectWindowsProcessTree,
  findTrackedWindowsSurvivors,
  isSameWindowsProcess,
  parseWindowsProcessSnapshot,
  readWindowsProcessSnapshot,
  WindowsProcessTreeTracker,
  type WindowsProcessIdentity,
} from "../tests/e2e/windows-process-tree";

const electronPath = "C:\\repo\\node_modules\\electron\\dist\\electron.exe";
const corePath = "C:\\repo\\build\\core-bin\\candor-core.exe";

function processIdentity(
  pid: number,
  parentPid: number,
  executablePath = electronPath,
  creationDate = `2026-07-20T19:00:${String(pid % 60).padStart(2, "0")}.0000000Z`,
): WindowsProcessIdentity {
  return { pid, parentPid, creationDate, executablePath };
}

describe("Windows E2E process-tree tracking", () => {
  it("reads the current process through the fixed Windows identity snapshot", () => {
    if (process.platform !== "win32") return;
    const current = readWindowsProcessSnapshot({ pids: [process.pid] }).find((processIdentity) => processIdentity.pid === process.pid);
    expect(current?.creationDate).toBeTruthy();
    expect(current?.executablePath.toLocaleLowerCase("en-US")).toMatch(/node\.exe$/);
    expect(readWindowsProcessSnapshot({ pids: [2_147_483_647] })).toEqual([]);
  }, 15_000);

  it("parses both one-object and array snapshots while rejecting incomplete identities", () => {
    const root = processIdentity(100, 10);
    expect(parseWindowsProcessSnapshot(JSON.stringify(root))).toEqual([root]);
    expect(parseWindowsProcessSnapshot(JSON.stringify([
      root,
      { pid: 101, parentPid: 100, creationDate: "", executablePath: corePath },
      { pid: 102, parentPid: 100, creationDate: root.creationDate, executablePath: "" },
    ]))).toEqual([root]);
  });

  it("collects only the requested root ancestry and preserves cleanup depth", () => {
    const root = processIdentity(100, 10);
    const helper = processIdentity(101, 100);
    const core = processIdentity(102, 101, corePath);
    const sibling = processIdentity(200, 10);
    expect(collectWindowsProcessTree(root.pid, [root, helper, core, sibling])).toEqual([
      { ...root, depth: 0 },
      { ...helper, depth: 1 },
      { ...core, depth: 2 },
    ]);
  });

  it("matches PID, creation time, and executable path before treating a process as a survivor", () => {
    const root = { ...processIdentity(100, 10), depth: 0 };
    const reusedPid = processIdentity(100, 10, electronPath, "2026-07-20T20:00:00.0000000Z");
    const changedPath = processIdentity(100, 10, corePath, root.creationDate);
    expect(isSameWindowsProcess(root, { ...root, executablePath: electronPath.toUpperCase() })).toBe(true);
    expect(findTrackedWindowsSurvivors([root], [reusedPid])).toEqual([]);
    expect(findTrackedWindowsSurvivors([root], [changedPath])).toEqual([]);
  });

  it("reaps a tracked core after the Electron root has already exited", async () => {
    const root = processIdentity(100, 10, "C:\\Windows\\System32\\cmd.exe");
    const electron = processIdentity(101, 100);
    const core = processIdentity(102, 101, corePath);
    const snapshots = [[root, electron, core], [core], [core], []];
    const terminateProcess = vi.fn();
    const tracker = new WindowsProcessTreeTracker(root.pid, [electronPath, corePath], {
      readSnapshot: () => snapshots.shift() ?? [],
      terminateProcess,
      cleanupTimeoutMs: 100,
      pollIntervalMs: 0,
    });
    tracker.refresh();
    await expect(tracker.cleanup()).resolves.toEqual([core.pid]);
    expect(terminateProcess).toHaveBeenCalledWith(core.pid);
  });

  it("reaps exact survivors deepest-first without touching an unrelated same-image sibling", async () => {
    const root = processIdentity(100, 10);
    const helper = processIdentity(101, 100);
    const core = processIdentity(102, 101, corePath);
    const sibling = processIdentity(200, 10);
    const snapshots = [
      [root, helper, core, sibling],
      [root, helper, core, sibling],
      [core],
      [helper],
      [root],
      [sibling],
    ];
    const terminateProcess = vi.fn();
    const tracker = new WindowsProcessTreeTracker(root.pid, [electronPath, corePath], {
      readSnapshot: () => snapshots.shift() ?? [sibling],
      terminateProcess,
      cleanupTimeoutMs: 100,
      pollIntervalMs: 0,
    });
    tracker.refresh();
    await tracker.cleanup();
    expect(terminateProcess.mock.calls.map(([pid]) => pid)).toEqual([core.pid, helper.pid, root.pid]);
    expect(terminateProcess).not.toHaveBeenCalledWith(sibling.pid);
  });

  it("skips a reused PID and accepts a raced termination once the identity is absent", async () => {
    const root = processIdentity(100, 10);
    const reusedRoot = processIdentity(100, 10, electronPath, "2026-07-20T21:00:00.0000000Z");
    const snapshots = [[root], [reusedRoot]];
    const terminateProcess = vi.fn();
    const tracker = new WindowsProcessTreeTracker(root.pid, [electronPath], {
      readSnapshot: () => snapshots.shift() ?? [],
      terminateProcess,
      cleanupTimeoutMs: 0,
      pollIntervalMs: 0,
    });
    tracker.refresh();
    await expect(tracker.cleanup()).resolves.toEqual([]);
    expect(terminateProcess).not.toHaveBeenCalled();

    const exitedSnapshots = [[root], [root], [], []];
    const exitedTerminate = vi.fn();
    const exitedTracker = new WindowsProcessTreeTracker(root.pid, [electronPath], {
      readSnapshot: () => exitedSnapshots.shift() ?? [],
      terminateProcess: exitedTerminate,
      cleanupTimeoutMs: 0,
      pollIntervalMs: 0,
    });
    exitedTracker.refresh();
    await expect(exitedTracker.cleanup()).resolves.toEqual([]);
    expect(exitedTerminate).not.toHaveBeenCalled();

    const racedSnapshots = [[root], [root], [root], []];
    const racedTerminate = vi.fn();
    const racedTracker = new WindowsProcessTreeTracker(root.pid, [electronPath], {
      readSnapshot: () => racedSnapshots.shift() ?? [],
      terminateProcess: racedTerminate,
      cleanupTimeoutMs: 0,
      pollIntervalMs: 0,
    });
    racedTracker.refresh();
    await expect(racedTracker.cleanup()).resolves.toEqual([root.pid]);
    expect(racedTerminate).toHaveBeenCalledOnce();
  });

  it("fails closed when an exact tracked survivor remains after the deadline", async () => {
    const root = processIdentity(100, 10);
    const tracker = new WindowsProcessTreeTracker(root.pid, [electronPath], {
      readSnapshot: () => [root],
      terminateProcess: vi.fn(),
      cleanupTimeoutMs: 0,
      pollIntervalMs: 0,
    });
    tracker.refresh();
    await expect(tracker.cleanup()).rejects.toThrow("left 1 exact survivor");
  });
});
