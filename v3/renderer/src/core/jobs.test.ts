import { describe, expect, it, vi } from "vitest";
import { waitForJob } from "./jobs";

function apiWithJobs(sequence: unknown[]) {
  const getJob = vi.fn();
  for (const value of sequence) getJob.mockResolvedValueOnce(value);
  return {
    app: {
      getJob,
      acknowledgeJob: vi.fn().mockResolvedValue({ acknowledged: true }),
    },
    ai: { cancel: vi.fn().mockResolvedValue({ cancelRequested: true }) },
    events: { subscribe: vi.fn().mockReturnValue(() => undefined) },
  } as unknown as NonNullable<Window["candor"]>;
}

describe("core job lifecycle", () => {
  it("returns a completed result and acknowledges it", async () => {
    const api = apiWithJobs([{ jobId: "a".repeat(32), state: "completed", terminal: true, result: { ok: true } }]);
    await expect(waitForJob(api, { jobId: "a".repeat(32) }, { pollIntervalMs: 100 })).resolves.toEqual({ ok: true });
    expect(api.app.acknowledgeJob).toHaveBeenCalledWith("a".repeat(32));
  });

  it("surfaces safe terminal failures without acknowledging", async () => {
    const api = apiWithJobs([{ jobId: "b".repeat(32), state: "failed", terminal: true, error: { message: "Local export failed." } }]);
    await expect(waitForJob(api, { jobId: "b".repeat(32) })).rejects.toThrow("Local export failed");
    expect(api.app.acknowledgeJob).not.toHaveBeenCalled();
  });
});
