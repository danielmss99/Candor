import { asBool, asObject, asString, type JsonObject, type LocalJsonValue } from "./contracts";

type CandorApi = NonNullable<Window["candor"]>;

export interface WaitForJobOptions {
  acknowledge?: boolean;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  onProgress?: (job: JsonObject) => void;
}

function acceptedJobId(value: unknown): string {
  const jobId = asString(asObject(value as LocalJsonValue).jobId);
  if (!/^[a-f0-9]{32}$/.test(jobId)) throw new Error("Candor did not return a valid local work id.");
  return jobId;
}

export async function waitForJob(
  api: CandorApi,
  accepted: unknown,
  options: WaitForJobOptions = {},
): Promise<LocalJsonValue> {
  const jobId = acceptedJobId(accepted);
  const pollIntervalMs = Math.max(100, options.pollIntervalMs ?? 500);

  return new Promise<LocalJsonValue>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      settled = true;
      if (timer !== undefined) globalThis.clearTimeout(timer);
      unsubscribe();
      options.signal?.removeEventListener("abort", onAbort);
    };
    const finish = async (job: JsonObject) => {
      if (settled || !asBool(job.terminal)) return false;
      cleanup();
      const state = asString(job.state);
      if (state === "completed") {
        const result = (job.result ?? null) as LocalJsonValue;
        if (options.acknowledge !== false) await api.app.acknowledgeJob(jobId).catch(() => undefined);
        resolve(result);
      } else {
        const error = asObject(job.error);
        reject(new Error(asString(error.message, state === "cancelled" ? "Local work was cancelled." : "Local work failed.")));
      }
      return true;
    };
    const inspect = async () => {
      try {
        const job = asObject(await api.app.getJob(jobId));
        options.onProgress?.(job);
        if (await finish(job)) return;
      } catch (error) {
        cleanup();
        reject(error);
        return;
      }
      if (!settled) timer = globalThis.setTimeout(() => void inspect(), pollIntervalMs);
    };
    const onAbort = () => {
      void api.ai.cancel(jobId).finally(() => {
        if (!settled) {
          cleanup();
          reject(new Error("Local work was cancelled."));
        }
      });
    };
    const unsubscribe = api.events.subscribe("jobs.changed", (payload) => {
      const job = asObject(payload as LocalJsonValue);
      if (asString(job.jobId) !== jobId) return;
      options.onProgress?.(job);
      if (asBool(job.terminal)) void inspect();
    });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    else void inspect();
  });
}
