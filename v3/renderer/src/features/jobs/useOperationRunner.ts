import { useCallback, useEffect, useRef, useState } from "react";
import { useLocalJob } from "../ai/useLocalJob";
import type { JobKind } from "../../state/operation-machines";
import { ExclusiveActionRegistry } from "../../state/request-coordinator";

export function operationErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type RunOperation = (
  label: string,
  task: () => Promise<void>,
  exclusiveScope?: string,
  jobKind?: JobKind,
) => Promise<void>;

export function useOperationRunner(onCaptureFailure: (message: string) => void) {
  const exclusiveActions = useRef(new ExclusiveActionRegistry());
  const captureFailure = useRef(onCaptureFailure);
  const localJob = useLocalJob();
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    captureFailure.current = onCaptureFailure;
  }, [onCaptureFailure]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(""), 5000);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  const acquire = useCallback((scope: string) => exclusiveActions.current.acquire(scope), []);

  const run: RunOperation = useCallback(async (
    label: string,
    task: () => Promise<void>,
    exclusiveScope = label,
    jobKind?: JobKind,
  ) => {
    const release = acquire(exclusiveScope);
    if (!release) {
      setNotice(`${label} is already in progress`);
      return;
    }
    const requestId = jobKind ? localJob.begin(jobKind) : 0;
    setBusy(label);
    setError("");
    setNotice("");
    try {
      await task();
      if (jobKind) localJob.complete(requestId);
    } catch (reason) {
      const message = operationErrorMessage(reason);
      setError(message);
      if (exclusiveScope === "capture") captureFailure.current(message);
      if (jobKind) localJob.fail(requestId, message);
    } finally {
      setBusy("");
      release();
    }
  }, [acquire, localJob]);

  return {
    busy,
    notice,
    error,
    jobMachine: localJob.state,
    job: localJob,
    acquire,
    run,
    setBusy,
    setNotice,
    setError,
  };
}
