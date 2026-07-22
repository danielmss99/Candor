import { spawnSync } from "node:child_process";
import path from "node:path";

export interface WindowsProcessIdentity {
  pid: number;
  parentPid: number;
  creationDate: string;
  executablePath: string;
}

export interface TrackedWindowsProcess extends WindowsProcessIdentity {
  depth: number;
}

export interface WindowsProcessSnapshotFilter {
  pids?: number[];
  executableNames?: string[];
}

interface WindowsProcessTreeTrackerOptions {
  readSnapshot?: (filter?: WindowsProcessSnapshotFilter) => WindowsProcessIdentity[];
  terminateProcess?: (pid: number) => void;
  cleanupTimeoutMs?: number;
  pollIntervalMs?: number;
}

function windowsProcessSnapshotScript(filter: WindowsProcessSnapshotFilter): string {
  const pids = filter.pids ?? [];
  const executableNames = filter.executableNames ?? [];
  const clauses: string[] = [];
  for (const pid of pids) {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Windows process snapshot received an invalid process ID.");
    clauses.push(`ProcessId = ${pid}`);
  }
  for (const executableName of executableNames) {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(executableName)) {
      throw new Error("Windows process snapshot received an invalid executable name.");
    }
    clauses.push(`Name = '${executableName}'`);
  }
  const preamble = "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue';";
  if (pids.length > 0 && executableNames.length === 0) {
    const requestedPids = pids.join(",");
    return `${preamble} $requested = @(${requestedPids}); Get-Process -Id $requested -ErrorAction SilentlyContinue | ForEach-Object { try { [pscustomobject]@{ pid = [int]$_.Id; parentPid = 0; creationDate = $_.StartTime.ToFileTimeUtc().ToString(); executablePath = [string]$_.Path } } catch {} } | ConvertTo-Json -Compress; exit 0`;
  }
  const query = clauses.length > 0
    ? `Get-CimInstance Win32_Process -Filter \"${clauses.join(" OR ")}\"`
    : "Get-CimInstance Win32_Process";
  return `${preamble} ${query} | ForEach-Object { $cimProcess = $_; $nativeProcess = Get-Process -Id $cimProcess.ProcessId -ErrorAction SilentlyContinue; if ($null -ne $nativeProcess) { try { [pscustomobject]@{ pid = [int]$cimProcess.ProcessId; parentPid = [int]$cimProcess.ParentProcessId; creationDate = $nativeProcess.StartTime.ToFileTimeUtc().ToString(); executablePath = [string]$nativeProcess.Path } } catch {} } } | ConvertTo-Json -Compress; exit 0`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function normalizeWindowsExecutablePath(value: string): string {
  return path.win32.normalize(value).toLocaleLowerCase("en-US");
}

export function parseWindowsProcessSnapshot(output: string): WindowsProcessIdentity[] {
  const parsed: unknown = JSON.parse(output);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.flatMap((row): WindowsProcessIdentity[] => {
    if (!row || typeof row !== "object") return [];
    const item = row as Record<string, unknown>;
    const pid = Number(item.pid);
    const parentPid = Number(item.parentPid);
    const creationDate = typeof item.creationDate === "string" ? item.creationDate : "";
    const executablePath = typeof item.executablePath === "string" ? item.executablePath : "";
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(parentPid) || parentPid < 0) return [];
    if (!creationDate || !executablePath) return [];
    return [{ pid, parentPid, creationDate, executablePath }];
  });
}

export function readWindowsProcessSnapshot(filter: WindowsProcessSnapshotFilter = {}): WindowsProcessIdentity[] {
  const filtered = (filter.pids?.length ?? 0) > 0 || (filter.executableNames?.length ?? 0) > 0;
  const result = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", windowsProcessSnapshotScript(filter)],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (result.error) throw new Error("Windows process identity snapshot failed.", { cause: result.error });
  if (result.status !== 0) {
    const detail = result.stderr.trim().replace(/\s+/g, " ").slice(0, 500);
    throw new Error(`Windows process identity snapshot returned no usable data (exit ${result.status ?? "unknown"})${detail ? `: ${detail}` : "."}`);
  }
  if (!result.stdout.trim()) {
    if (filtered) return [];
    throw new Error("Windows process identity snapshot returned no process rows.");
  }
  try {
    return parseWindowsProcessSnapshot(result.stdout);
  } catch (error) {
    throw new Error("Windows process identity snapshot was malformed.", { cause: error });
  }
}

export function collectWindowsProcessTree(rootPid: number, snapshot: WindowsProcessIdentity[]): TrackedWindowsProcess[] {
  const children = new Map<number, WindowsProcessIdentity[]>();
  for (const processIdentity of snapshot) {
    const siblings = children.get(processIdentity.parentPid) ?? [];
    siblings.push(processIdentity);
    children.set(processIdentity.parentPid, siblings);
  }

  const root = snapshot.find((processIdentity) => processIdentity.pid === rootPid);
  const queue: TrackedWindowsProcess[] = root ? [{ ...root, depth: 0 }] : [];
  for (const child of children.get(rootPid) ?? []) queue.push({ ...child, depth: 1 });
  const found: TrackedWindowsProcess[] = [];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current.pid)) continue;
    seen.add(current.pid);
    found.push(current);
    for (const child of children.get(current.pid) ?? []) {
      queue.push({ ...child, depth: current.depth + 1 });
    }
  }
  return found;
}

export function isSameWindowsProcess(left: WindowsProcessIdentity, right: WindowsProcessIdentity): boolean {
  return left.pid === right.pid
    && left.creationDate === right.creationDate
    && normalizeWindowsExecutablePath(left.executablePath) === normalizeWindowsExecutablePath(right.executablePath);
}

export function findTrackedWindowsSurvivors(
  tracked: Iterable<TrackedWindowsProcess>,
  snapshot: WindowsProcessIdentity[],
): TrackedWindowsProcess[] {
  const currentByPid = new Map(snapshot.map((processIdentity) => [processIdentity.pid, processIdentity]));
  return [...tracked].filter((processIdentity) => {
    const current = currentByPid.get(processIdentity.pid);
    return Boolean(current && isSameWindowsProcess(processIdentity, current));
  });
}

function terminateExactWindowsProcess(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Refusing to terminate an invalid Windows process ID.");
  const result = spawnSync("taskkill", ["/PID", String(pid), "/F"], {
    stdio: "ignore",
    windowsHide: true,
  });
  if (result.error) throw new Error(`Unable to terminate tracked Windows process ${pid}.`, { cause: result.error });
  // A nonzero status can mean the exact process exited between revalidation and taskkill.
  // The next identity snapshot decides whether cleanup succeeded.
}

export class WindowsProcessTreeTracker {
  readonly #rootPid: number;
  readonly #allowedExecutablePaths: Set<string>;
  readonly #allowedExecutableNames: string[];
  readonly #tracked = new Map<string, TrackedWindowsProcess>();
  readonly #readSnapshot: (filter?: WindowsProcessSnapshotFilter) => WindowsProcessIdentity[];
  readonly #terminateProcess: (pid: number) => void;
  readonly #cleanupTimeoutMs: number;
  readonly #pollIntervalMs: number;
  #rootIdentity: WindowsProcessIdentity | null = null;

  constructor(rootPid: number, allowedExecutablePaths: string[], options: WindowsProcessTreeTrackerOptions = {}) {
    if (!Number.isSafeInteger(rootPid) || rootPid <= 0) throw new Error("A valid Electron root process ID is required.");
    this.#rootPid = rootPid;
    this.#allowedExecutablePaths = new Set(allowedExecutablePaths.map(normalizeWindowsExecutablePath));
    this.#allowedExecutableNames = [...new Set(allowedExecutablePaths.map((value) => path.win32.basename(value)))];
    this.#readSnapshot = options.readSnapshot ?? readWindowsProcessSnapshot;
    this.#terminateProcess = options.terminateProcess ?? terminateExactWindowsProcess;
    this.#cleanupTimeoutMs = options.cleanupTimeoutMs ?? 5_000;
    this.#pollIntervalMs = options.pollIntervalMs ?? 100;
  }

  refresh(): void {
    const snapshot = this.#readSnapshot({
      pids: [this.#rootPid],
      executableNames: this.#allowedExecutableNames,
    });
    const currentRoot = snapshot.find((processIdentity) => processIdentity.pid === this.#rootPid);
    if (!this.#rootIdentity) {
      if (!currentRoot) throw new Error(`Electron launcher identity ${this.#rootPid} was unavailable during E2E process tracking.`);
      this.#rootIdentity = currentRoot;
    } else if (!currentRoot || !isSameWindowsProcess(this.#rootIdentity, currentRoot)) {
      // Once the original root exits, its PID can be reused. Existing identities remain
      // eligible for cleanup, but no new descendants are accepted from that PID.
      return;
    }

    for (const processIdentity of collectWindowsProcessTree(this.#rootPid, snapshot)) {
      if (processIdentity.depth !== 0 && !this.#isAllowed(processIdentity.executablePath)) continue;
      this.#tracked.set(this.#key(processIdentity), processIdentity);
    }
  }

  async cleanup(): Promise<number[]> {
    const terminated = new Set<number>();
    const deadline = Date.now() + this.#cleanupTimeoutMs;
    while (true) {
      const trackedPids = [...new Set([...this.#tracked.values()].map((processIdentity) => processIdentity.pid))];
      const survivors = findTrackedWindowsSurvivors(this.#tracked.values(), this.#readSnapshot({ pids: trackedPids }))
        .sort((left, right) => right.depth - left.depth || right.pid - left.pid);
      if (survivors.length === 0) return [...terminated];

      for (const survivor of survivors) {
        const revalidated = findTrackedWindowsSurvivors(
          [survivor],
          this.#readSnapshot({ pids: [survivor.pid] }),
        );
        if (revalidated.length === 0) continue;
        this.#terminateProcess(survivor.pid);
        terminated.add(survivor.pid);
      }
      if (Date.now() >= deadline) {
        const remaining = findTrackedWindowsSurvivors(this.#tracked.values(), this.#readSnapshot({ pids: trackedPids }));
        if (remaining.length > 0) {
          throw new Error(`Tracked Electron process cleanup left ${remaining.length} exact survivor(s).`);
        }
        return [...terminated];
      }
      await delay(this.#pollIntervalMs);
    }
  }

  #isAllowed(executablePath: string): boolean {
    return this.#allowedExecutablePaths.has(normalizeWindowsExecutablePath(executablePath));
  }

  #key(processIdentity: WindowsProcessIdentity): string {
    return `${processIdentity.pid}\0${processIdentity.creationDate}\0${normalizeWindowsExecutablePath(processIdentity.executablePath)}`;
  }
}
