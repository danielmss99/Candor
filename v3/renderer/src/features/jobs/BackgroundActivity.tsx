import { useEffect, useRef, useState } from "react";

interface BackgroundActivityProps {
  jobs: BackgroundTask[];
  onCancel: (jobId: string) => void;
  onRetry: (jobId: string) => void;
  onCancelAll: () => void;
  onOpenMeeting: (recordingId: string) => void;
  onDismiss: (jobId: string) => void;
}

function jobLabel(job: BackgroundTask): string {
  const type = job.type;
  if (type === "transcription") return "Transcribing meeting";
  if (type === "recap") return "Creating recap";
  if (type === "ask") return "Answering from meeting";
  if (type === "export") return "Creating export";
  if (type === "dictionary-import") return "Installing dictionary";
  if (type === "dictionary-index") return "Preparing terminology";
  if (type === "legacy-import") return "Importing previous meetings";
  if (type === "local-ai-benchmark") return "Testing Local AI";
  if (type === "local-ai-component-import") return "Installing Local AI";
  if (type === "speech-model-import") return "Installing speech recognition";
  return "Checking speech recognition";
}

function progressLabel(job: BackgroundTask): string {
  if (job.state === "queued") return "Waiting to start";
  if (job.state === "paused") return "Paused";
  if (job.state === "cancelling") return "Cancelling";
  if (job.state === "completed") return "Ready";
  if (job.state === "cancelled") return "Cancelled";
  const progress = job.progress;
  if (progress?.unit === "percent") return `${Math.min(100, progress.completed)}%`;
  if (progress?.total && progress.total > 0) {
    return `${progress.completed} of ${progress.total} ${progress.unit}`;
  }
  if (progress) return `${progress.completed} ${progress.unit}`;
  return job.stage ? job.stage.replaceAll("-", " ") : "Running locally";
}

function etaLabel(job: BackgroundTask): string | null {
  if (job.state !== "running" || typeof job.estimatedRemainingMs !== "number") return null;
  const remainingMs = job.estimatedRemainingMs;
  if (remainingMs < 60_000) return "Less than a minute remaining";
  const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  return `About ${minutes} ${minutes === 1 ? "minute" : "minutes"} remaining`;
}

export function terminalTaskAnnouncement(job: BackgroundTask): string {
  if (job.state === "completed") return `${jobLabel(job)} completed locally.`;
  if (job.state === "cancelled") return `${jobLabel(job)} cancelled.`;
  return `${jobLabel(job)} needs attention.`;
}

export function BackgroundActivity({
  jobs,
  onCancel,
  onRetry,
  onCancelAll,
  onOpenMeeting,
  onDismiss,
}: BackgroundActivityProps) {
  const previousStates = useRef<Map<string, string> | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const active = jobs.filter((job) => !job.terminal);
  const failed = jobs.filter((job) => job.state === "failed");
  const recentCompleted = jobs.filter((job) => job.state === "completed").slice(0, 2);
  const recentCancelled = jobs.filter((job) => job.state === "cancelled").slice(0, 2);
  const visible = [...active, ...failed, ...recentCompleted, ...recentCancelled].slice(0, 8);
  const runningCount = active.filter((job) => job.state === "running").length;
  const queuedCount = active.filter((job) => job.state === "queued").length;
  const pausedCount = active.filter((job) => job.state === "paused").length;
  const cancellingCount = active.filter((job) => job.state === "cancelling").length;
  const activeStateLabels = [
    runningCount ? `${runningCount} running` : "",
    queuedCount ? `${queuedCount} queued` : "",
    pausedCount ? `${pausedCount} paused` : "",
    cancellingCount ? `${cancellingCount} cancelling` : "",
  ].filter(Boolean);
  const countLabel = activeStateLabels.length
    ? activeStateLabels.join(" / ")
    : active.length
      ? `${active.length} background ${active.length === 1 ? "task" : "tasks"}`
    : failed.length
      ? `${failed.length} ${failed.length === 1 ? "task needs" : "tasks need"} attention`
      : "Activity";

  useEffect(() => {
    const nextStates = new Map(jobs.map((job) => [job.jobId, job.state]));
    const previous = previousStates.current;
    previousStates.current = nextStates;
    if (!previous) return;
    const changed = jobs.find((job) => {
      return job.terminal && previous.get(job.jobId) !== job.state;
    });
    if (!changed) return;
    setAnnouncement(terminalTaskAnnouncement(changed));
    const timer = window.setTimeout(() => setAnnouncement(""), 6_000);
    return () => window.clearTimeout(timer);
  }, [jobs]);

  return (
    <div className="background-activity-wrap">
      {announcement ? <div className="background-job-notification" role="status">{announcement}</div> : null}
      <details className="background-activity">
      <summary aria-label={`Background tasks, ${countLabel}`}>
        <span className={`status-dot ${failed.length ? "warning" : active.length ? "working" : "ok"}`} />
        {countLabel}
      </summary>
      <section className="background-activity-panel" aria-label="Background tasks" aria-live="polite">
        <header>
          <div><strong>Background tasks</strong><span>Processing stays on this device</span></div>
          {active.length > 1 ? <button type="button" aria-label="Cancel all background tasks" onClick={onCancelAll}>Cancel all</button> : null}
        </header>
        {visible.length ? visible.map((job) => {
          const jobId = job.jobId;
          const recordingId = job.recordingId ?? "";
          const state = job.state;
          const canRetry = (state === "failed" || state === "cancelled" || state === "paused") && job.retryable;
          const retryLabel = state === "paused" ? "Resume" : "Retry";
          const eta = etaLabel(job);
          return (
            <article className="background-job" key={jobId} data-state={state}>
              <div className="background-job-copy">
                <strong>{jobLabel(job)}</strong>
                <span>{state === "failed" ? job.error?.message ?? "Local work needs attention" : progressLabel(job)}</span>
                {eta ? <small>{eta}</small> : null}
              </div>
              <div className="background-job-actions">
                {recordingId ? <button type="button" aria-label={`Open meeting for ${jobLabel(job)}`} onClick={() => onOpenMeeting(recordingId)}>Open meeting</button> : null}
                {!job.terminal && state !== "cancelling" ? <button type="button" aria-label={`Cancel ${jobLabel(job)}`} onClick={() => onCancel(jobId)}>Cancel</button> : null}
                {canRetry ? <button type="button" className="primary" aria-label={`${retryLabel} ${jobLabel(job)}`} onClick={() => onRetry(jobId)}>{retryLabel}</button> : null}
                {job.terminal ? <button type="button" aria-label={`Dismiss ${jobLabel(job)}`} onClick={() => onDismiss(jobId)}>Dismiss</button> : null}
              </div>
            </article>
          );
        }) : <p className="background-activity-empty">No background tasks yet.</p>}
      </section>
      </details>
    </div>
  );
}
