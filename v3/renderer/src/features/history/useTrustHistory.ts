import { useCallback, useEffect, useRef, useState } from "react";
import { waitForJob } from "../../core/jobs";
import { parseProtectedTermReview, parseTranscriptRevisionDetail, parseTrustHistory } from "./history-parsers";
import type { ProtectedTermReview, ReprocessJob, TranscriptRevisionDetail, TrustHistory, TrustHistoryController } from "./types";

function message(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : "Candor could not complete that request.";
}

function candorApi(): NonNullable<typeof window.candor> {
  const api = window.candor;
  if (!api) throw new Error("Candor's secure desktop connection is unavailable.");
  return api;
}

function parseJob(value: unknown): ReprocessJob | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  return typeof item.jobId === "string"
    ? { jobId: item.jobId, state: typeof item.state === "string" ? item.state : "queued" }
    : null;
}

export async function runReprocessJob(
  api: NonNullable<typeof window.candor>,
  recordingId: string,
  onProgress: (job: ReprocessJob) => void,
): Promise<ReprocessJob> {
  const accepted = parseJob(await api.transcript.reprocess({ recordingId }));
  if (!accepted) throw new Error("Candor did not return a valid reprocessing job.");
  onProgress(accepted);
  await waitForJob(api, accepted, {
    onProgress: (job) => onProgress({ jobId: job.jobId, state: job.state }),
  });
  const completed = { jobId: accepted.jobId, state: "completed" };
  onProgress(completed);
  return completed;
}

export function useTrustHistory(
  recordingId: string,
  onTranscriptRevisionChanged?: () => void | Promise<void>,
): TrustHistoryController {
  const [history, setHistory] = useState<TrustHistory | null>(null);
  const [viewedRevision, setViewedRevision] = useState<TranscriptRevisionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [revisionLoading, setRevisionLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reprocessJob, setReprocessJob] = useState<ReprocessJob | null>(null);
  const [protectedTermReview, setProtectedTermReview] = useState<ProtectedTermReview | null>(null);
  const historyRequestVersion = useRef(0);
  const revisionRequestVersion = useRef(0);
  const mutationInFlight = useRef(false);

  const viewRevision = useCallback(async (revisionId: string) => {
    const request = ++revisionRequestVersion.current;
    setRevisionLoading(true);
    setError("");
    try {
      const parsed = parseTranscriptRevisionDetail(
        await candorApi().meetings.getTranscriptRevision(recordingId, revisionId),
      );
      if (!parsed) throw new Error("Candor returned an unreadable transcript revision.");
      if (request === revisionRequestVersion.current) setViewedRevision(parsed);
    } catch (nextError) {
      if (request === revisionRequestVersion.current) setError(message(nextError));
    } finally {
      if (request === revisionRequestVersion.current) setRevisionLoading(false);
    }
  }, [recordingId]);

  const refreshHistory = useCallback(async () => {
    const request = ++historyRequestVersion.current;
    setLoading(true);
    setError("");
    try {
      const [historyValue, protectedTermReviewValue] = await Promise.all([
        candorApi().meetings.getTrustHistory(recordingId),
        candorApi().meetings.getProtectedTermReview(recordingId),
      ]);
      const parsed = parseTrustHistory(historyValue);
      const parsedProtectedTermReview = parseProtectedTermReview(protectedTermReviewValue);
      if (!parsed) throw new Error("Candor returned unreadable transcript history.");
      if (!parsedProtectedTermReview) throw new Error("Candor returned an unreadable protected-term review.");
      if (request !== historyRequestVersion.current) return;
      setHistory(parsed);
      setProtectedTermReview(parsedProtectedTermReview);
      const preferredRevision = parsed.currentRevisionId ?? parsed.revisions.at(-1)?.revisionId;
      if (preferredRevision) await viewRevision(preferredRevision);
      else setViewedRevision(null);
    } catch (nextError) {
      if (request !== historyRequestVersion.current) return;
      setError(message(nextError));
      setHistory(null);
      setProtectedTermReview(null);
      setViewedRevision(null);
    } finally {
      if (request === historyRequestVersion.current) setLoading(false);
    }
  }, [recordingId, viewRevision]);

  useEffect(() => {
    setHistory(null);
    setViewedRevision(null);
    setProtectedTermReview(null);
    setNotice("");
    setReprocessJob(null);
    void refreshHistory();
    return () => {
      historyRequestVersion.current += 1;
      revisionRequestVersion.current += 1;
    };
  }, [refreshHistory]);

  const selectRevision = useCallback(async (revisionId: string) => {
    if (mutationInFlight.current) return;
    mutationInFlight.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await candorApi().meetings.selectTranscriptRevision(recordingId, revisionId);
      await refreshHistory();
      await onTranscriptRevisionChanged?.();
      setNotice("Current transcript changed. Every older revision is still retained.");
    } catch (nextError) {
      setError(message(nextError));
    } finally {
      mutationInFlight.current = false;
      setBusy(false);
    }
  }, [onTranscriptRevisionChanged, recordingId, refreshHistory]);

  const reprocess = useCallback(async () => {
    if (mutationInFlight.current) return;
    mutationInFlight.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const job = await runReprocessJob(candorApi(), recordingId, setReprocessJob);
      setReprocessJob(job);
      await refreshHistory();
      await onTranscriptRevisionChanged?.();
      setNotice("Reprocessing completed from the original audio. Existing transcript revisions were not overwritten.");
    } catch (nextError) {
      setError(message(nextError));
    } finally {
      mutationInFlight.current = false;
      setBusy(false);
    }
  }, [onTranscriptRevisionChanged, recordingId, refreshHistory]);

  const applyProtectedTermReview = useCallback(async () => {
    if (mutationInFlight.current || !protectedTermReview?.reviewRequired) return;
    const { revisionId, previewToken } = protectedTermReview;
    if (!revisionId || !previewToken) {
      setError("Candor could not verify the protected-term preview.");
      return;
    }
    mutationInFlight.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await candorApi().meetings.applyProtectedTermReview(recordingId, revisionId, previewToken);
      await refreshHistory();
      await onTranscriptRevisionChanged?.();
      setNotice("Protected terms were applied in a new transcript revision. The prior revision is still retained.");
    } catch (nextError) {
      setError(message(nextError));
    } finally {
      mutationInFlight.current = false;
      setBusy(false);
    }
  }, [onTranscriptRevisionChanged, protectedTermReview, recordingId, refreshHistory]);

  return {
    history,
    viewedRevision,
    protectedTermReview,
    loading,
    revisionLoading,
    busy,
    error,
    notice,
    reprocessJob,
    refreshHistory,
    viewRevision,
    selectRevision,
    reprocess,
    applyProtectedTermReview,
  };
}
