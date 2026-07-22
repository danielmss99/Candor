import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";

const DEFAULT_REMOVE_MAX_RETRIES = 120;
const DEFAULT_REMOVE_RETRY_DELAY_MS = 250;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function waitForChildClose(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  let onClose;
  const closed = new Promise((resolve) => {
    onClose = () => resolve(true);
    child.once("close", onClose);
    // Close may race the listener registration. ChildProcess records exit or
    // signal state synchronously, so a second check closes that window.
    if (child.exitCode !== null || child.signalCode !== null) resolve(true);
  });
  const result = await Promise.race([
    closed,
    delay(timeoutMs).then(() => false),
  ]);
  if (!result && onClose) child.removeListener("close", onClose);
  return result;
}

export async function stopChildProcess(child, options = {}) {
  const platform = options.platform ?? process.platform;
  const gracefulTimeoutMs = options.gracefulTimeoutMs ?? 5_000;
  const forcedTimeoutMs = options.forcedTimeoutMs ?? 5_000;
  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;

  if (await waitForChildClose(child, gracefulTimeoutMs)) {
    return { forced: false };
  }

  if (platform === "win32" && child.pid) {
    spawnSyncImpl("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } else {
    child.kill("SIGKILL");
  }

  if (!(await waitForChildClose(child, forcedTimeoutMs))) {
    throw new Error("candor-core did not exit during smoke cleanup");
  }
  return { forced: true };
}

export function removeTemporaryDirectory(directory, options = {}) {
  const rmSyncImpl = options.rmSyncImpl ?? rmSync;
  rmSyncImpl(directory, {
    recursive: true,
    force: true,
    maxRetries: options.maxRetries ?? DEFAULT_REMOVE_MAX_RETRIES,
    retryDelay: options.retryDelay ?? DEFAULT_REMOVE_RETRY_DELAY_MS,
  });
}
