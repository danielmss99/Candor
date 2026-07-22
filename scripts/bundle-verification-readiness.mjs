function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function waitForBundleVerification(readStatus, options = {}) {
  const timeoutMs = options.timeoutMs ?? 8_000;
  const pollIntervalMs = options.pollIntervalMs ?? 10;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? delay;
  const startedAt = now();

  while (true) {
    const status = await readStatus();
    if (status?.state !== "checking") return status;

    const elapsedMs = now() - startedAt;
    if (elapsedMs >= timeoutMs) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for bundled AI verification`);
    }

    await wait(Math.min(pollIntervalMs, timeoutMs - elapsedMs));
  }
}
