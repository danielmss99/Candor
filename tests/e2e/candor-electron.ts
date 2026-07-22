import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { WindowsProcessTreeTracker } from "./windows-process-tree";
import { waitForTrackedChildExit } from "./tracked-child-process";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const electronExecutable = require("electron") as string;
const electronMain = path.join(repoRoot, "dist-v3", "electron", "main.js");
const secondaryCandorLauncher = path.join(repoRoot, "tests", "e2e", "secondary-candor-launcher.mjs");
const coreExecutable = path.join(
  repoRoot,
  "build",
  "core-bin",
  process.platform === "win32" ? "candor-core.exe" : "candor-core",
);
const deferredDataDirectoryCleanup = new Set<string>();

function transientCleanupError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "EPERM" || code === "EBUSY" || code === "ENOTEMPTY";
}

export function cleanupDeferredCandorDataDirs(): void {
  for (const dataDir of deferredDataDirectoryCleanup) {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 120, retryDelay: 250 });
    deferredDataDirectoryCleanup.delete(dataDir);
  }
}

interface LaunchCandorOptions {
  seedMeeting?: boolean;
  seedIncompleteSetup?: boolean;
  width?: number;
  height?: number;
  scaleFactor?: number;
}

interface CoreResponseLike {
  ok: boolean;
  result?: unknown;
  error?: { message?: string };
}

export interface CandorElectronSession {
  app: ElectronApplication;
  page: Page;
  dataDir: string;
  recordingId: string;
  close(): Promise<void>;
}

function seedIncompleteDesktopSetup(dataDir: string): void {
  const preferencesDirectory = path.join(dataDir, "electron-e2e", "preferences");
  mkdirSync(preferencesDirectory, { recursive: true });
  writeFileSync(
    path.join(preferencesDirectory, "desktop-preferences.json"),
    JSON.stringify({
      schemaVersion: 4,
      setup: {
        progress: "in-progress",
        completed: ["license"],
        deferred: [],
        lastStep: "microphone",
        existingUserPromptShown: false,
        nonBlockingUpgrade: false,
      },
    }),
    { encoding: "utf8", mode: 0o600 },
  );
}

export interface SecondaryCandorInstanceResult {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  cleanupTerminatedPids: number[];
}

function launchEnvironment(dataDir: string, scaleFactor: number): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  return {
    ...inherited,
    CANDOR_E2E: "1",
    CANDOR_E2E_SCALE_FACTOR: String(scaleFactor),
    CANDOR_V3_DATA_DIR: dataDir,
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForChildExit(child: ReturnType<ElectronApplication["process"]>, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  let exited = false;
  await Promise.race([
    new Promise<void>((resolve) => {
      child.once("exit", () => {
        exited = true;
        resolve();
      });
    }),
    delay(timeoutMs),
  ]);
  return exited || child.exitCode !== null || child.signalCode !== null;
}

function forceOwnedElectronTree(child: ReturnType<ElectronApplication["process"]>): void {
  if (process.platform === "win32" && child.pid) {
    const result = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (result.error) throw new Error("Unable to terminate the owned Electron process tree.", { cause: result.error });
    return;
  }
  child.kill("SIGKILL");
}

export async function launchSecondaryCandorInstance(
  dataDir: string,
  options: { scaleFactor?: number; timeoutMs?: number } = {},
): Promise<SecondaryCandorInstanceResult> {
  if (process.platform !== "win32") {
    throw new Error("The exact-identity second-instance proof currently requires Windows.");
  }
  const child = spawn(process.execPath, [secondaryCandorLauncher, electronExecutable, electronMain], {
    cwd: repoRoot,
    env: launchEnvironment(dataDir, options.scaleFactor ?? 1),
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  const timeoutMs = Math.max(1_000, Math.min(30_000, options.timeoutMs ?? 10_000));
  if (!child.pid) throw new Error("Secondary Candor launcher did not expose a Windows process ID.");
  const tracker = new WindowsProcessTreeTracker(
    child.pid,
    [process.execPath, electronExecutable, coreExecutable],
  );

  try {
    tracker.refresh();
    await waitForChildOutputLine(child, (line) => line === "ready", 5_000);
    const spawned = waitForChildOutputLine(child, (line) => /^spawned:\d+$/.test(line), 5_000);
    child.stdin?.write("launch\n");
    await spawned;
    return await waitForTrackedChildExit(child, tracker, { timeoutMs });
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin?.write("abort\n");
      child.stdin?.end();
    }
    try {
      await tracker.cleanup();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (!(await waitForChildExit(child, 5_000))) {
      cleanupErrors.push(new Error("Tracked secondary Candor launcher remained alive after cleanup."));
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], "Secondary Candor launch and exact-identity cleanup failed.");
    }
    throw error;
  }
}

function waitForChildOutputLine(
  child: ReturnType<typeof spawn>,
  accept: (line: string) => boolean,
  timeoutMs: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let buffered = "";
    const stdout = child.stdout;
    if (!stdout) {
      reject(new Error("Secondary Candor launcher stdout is unavailable."));
      return;
    }
    const finish = (callback: () => void) => {
      clearTimeout(timeout);
      stdout.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
      callback();
    };
    const onData = (chunk: Buffer | string) => {
      buffered += chunk.toString();
      while (buffered.includes("\n")) {
        const newline = buffered.indexOf("\n");
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (accept(line)) {
          finish(() => resolve(line));
          return;
        }
      }
    };
    const onError = (error: Error) => finish(() => reject(error));
    const onExit = () => finish(() => reject(new Error("Secondary Candor launcher exited before its process handshake.")));
    const timeout = setTimeout(() => {
      finish(() => reject(new Error("Secondary Candor launcher process handshake timed out.")));
    }, timeoutMs);
    stdout.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function cleanupSessionDataDirectory(dataDir: string): void {
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  } catch (error) {
    if (!transientCleanupError(error)) throw error;
    // Chromium and antivirus scanners can briefly retain closed profile files on Windows.
    // Defer only this exact test directory; the spec-level teardown retries and must succeed.
    deferredDataDirectoryCleanup.add(dataDir);
  }
}

async function closeElectronApplication(
  app: ElectronApplication,
  tracker: WindowsProcessTreeTracker | null,
): Promise<void> {
  const child = app.process();
  const cleanupErrors: unknown[] = [];
  await app.evaluate(({ app: electronApp }) => {
    electronApp.quit();
  }).catch(() => undefined);

  // Candor's close guard first drains or terminates the local core. Give that bounded
  // shutdown path time to finish. Windows cleanup then checks every captured identity,
  // even when Electron itself exited first.
  const rootExited = await waitForChildExit(child, 12_000);
  if (tracker) {
    try {
      await tracker.cleanup();
    } catch (error) {
      cleanupErrors.push(error);
      if (!rootExited && child.exitCode === null) {
        try {
          forceOwnedElectronTree(child);
        } catch (forceError) {
          cleanupErrors.push(forceError);
        }
      }
    }
  } else if (!rootExited && child.exitCode === null) {
    try {
      forceOwnedElectronTree(child);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  if (!(await waitForChildExit(child, 5_000))) {
    cleanupErrors.push(new Error("Electron process tree did not exit during E2E cleanup"));
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, "Electron E2E cleanup encountered multiple failures.");
}

async function seedLocalMeeting(dataDir: string): Promise<string> {
  const previousDataDir = process.env.CANDOR_V3_DATA_DIR;
  process.env.CANDOR_V3_DATA_DIR = dataDir;
  const { CoreClient } = await import("../../dist-v3/electron/core/core-client.js");
  const { privateCoreMethods } = await import("../../dist-v3/electron/core/protocol.js");
  const core = new CoreClient({
    executablePath: () => coreExecutable,
    allowedMethods: privateCoreMethods,
    isDev: false,
  });
  const call = async (method: string, params: unknown = null): Promise<unknown> => {
    const response = await core.call(method, params, 15_000) as CoreResponseLike;
    if (!response.ok) throw new Error(response.error?.message ?? `${method} failed`);
    return response.result ?? null;
  };

  try {
    await core.ensureHandshake();
    const started = await call("recording.durable.start", { label: "Product Strategy Sync" });
    const recordingId = typeof started === "object" && started !== null
      ? Reflect.get(started, "recordingId")
      : null;
    if (typeof recordingId !== "string" || !recordingId) {
      throw new Error("Electron test fixture did not receive a recording ID.");
    }
    const segments = [
      ["Alex Morgan", "Decision: keep the report editable and local.", 2_000],
      ["Priya Mehta", "Action: validate the desktop workflow with keyboard access.", 7_000],
      ["Daniel Moss", "The transcript and notes should remain visible together.", 12_000],
    ] as const;
    for (const [index, [speaker, text, startMs]] of segments.entries()) {
      await call("recording.durable.writeTranscriptSegment", {
        recordingId,
        channel: index % 2 === 0 ? "mic" : "system",
        speaker,
        text,
        startMs,
        durationMs: 3_000,
        confidence: 0.98,
      });
    }
    await call("recording.notes.save", {
      recordingId,
      markdown: "- Keep reports editable\n- Validate keyboard access\n- Preserve local evidence",
    });
    await call("recording.durable.finish", { recordingId });
    return recordingId;
  } finally {
    await core.shutdown();
    if (previousDataDir === undefined) delete process.env.CANDOR_V3_DATA_DIR;
    else process.env.CANDOR_V3_DATA_DIR = previousDataDir;
  }
}

export async function launchCandor(options: LaunchCandorOptions = {}): Promise<CandorElectronSession> {
  const dataDir = mkdtempSync(path.join(tmpdir(), "candor-electron-e2e-"));
  let app: ElectronApplication | null = null;
  let tracker: WindowsProcessTreeTracker | null = null;
  try {
    const recordingId = options.seedMeeting ? await seedLocalMeeting(dataDir) : "";
    if (options.seedIncompleteSetup) seedIncompleteDesktopSetup(dataDir);
    app = await electron.launch({
      executablePath: electronExecutable,
      args: [electronMain],
      cwd: repoRoot,
      env: launchEnvironment(dataDir, options.scaleFactor ?? 1),
    });
    const launchedApp = app;
    if (process.platform === "win32") {
      const rootPid = launchedApp.process().pid;
      if (!rootPid) throw new Error("Electron E2E launch did not expose a Windows process ID.");
      tracker = new WindowsProcessTreeTracker(rootPid, [electronExecutable, coreExecutable]);
      tracker.refresh();
    }

    const page = await launchedApp.firstWindow({ timeout: 30_000 });
    await page.waitForLoadState("domcontentloaded");
    tracker?.refresh();
    await launchedApp.evaluate(({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows()[0];
      window?.setSize(size.width, size.height);
    }, { width: options.width ?? 1366, height: options.height ?? 768 });

    return {
      app: launchedApp,
      page,
      dataDir,
      recordingId,
      async close() {
        await closeElectronApplication(launchedApp, tracker);
        cleanupSessionDataDirectory(dataDir);
      },
    };
  } catch (launchError) {
    let cleanupError: unknown = null;
    if (app) {
      try {
        await closeElectronApplication(app, tracker);
      } catch (error) {
        cleanupError = error;
      }
    }
    if (!cleanupError) {
      try {
        cleanupSessionDataDirectory(dataDir);
      } catch (error) {
        cleanupError = error;
      }
    }
    if (cleanupError) {
      throw new AggregateError([launchError, cleanupError], "Candor E2E launch and cleanup both failed.");
    }
    throw launchError;
  }
}
