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
  return job.stage ? job.stage.replaceAll("-", " ") : "Running";
}

function etaLabel(job: BackgroundTask): string | null {
  if (job.state !== "running" || typeof job.estimatedRemainingMs !== "number") return null;
  const remainingMs = job.estimatedRemainingMs;
  if (remainingMs < 60_000) return "Less than a minute remaining";
  const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  return `About ${minutes} ${minutes === 1 ? "minute" : "minutes"} remaining`;
}

export function terminalTaskAnnouncement(job: BackgroundTask): string {
  if (job.state === "completed") return `${jobLabel(job)} completed.`;
  if (job.state === "cancelled") return `${jobLabel(job)} cancelled.`;
  return `${jobLabel(job)} needs attention.`;
}

export const CANCELLABLE_TASK_STATES = new Set<BackgroundTask["state"]>([
  "queued",
  "running",
  "paused",
]);

export function terminalTasksAnnouncement(jobs: BackgroundTask[]): string {
  if (jobs.length === 1) return terminalTaskAnnouncement(jobs[0]);
  const completed = jobs.filter((job) => job.state === "completed").length;
  const failed = jobs.filter((job) => job.state === "failed").length;
  const cancelled = jobs.filter((job) => job.state === "cancelled").length;
  return [
    completed ? `${completed} background ${completed === 1 ? "task" : "tasks"} completed.` : "",
    failed ? `${failed} background ${failed === 1 ? "task needs" : "tasks need"} attention.` : "",
    cancelled ? `${cancelled} background ${cancelled === 1 ? "task was" : "tasks were"} cancelled.` : "",
  ].filter(Boolean).join(" ");
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
  const [cancelAllConfirmationOpen, setCancelAllConfirmationOpen] = useState(false);
  const active = jobs.filter((job) => !job.terminal);
  const failed = jobs.filter((job) => job.state === "failed");
  const inProgress = active.filter((job) => job.state !== "queued");
  const queued = active.filter((job) => job.state === "queued");
  const recent = jobs
    .filter((job) => job.state === "completed" || job.state === "cancelled")
    .slice(0, 4);
  const cancellable = active.filter((job) => CANCELLABLE_TASK_STATES.has(job.state));
  const sections = [
    { id: "attention", label: "Needs attention", jobs: failed },
    { id: "progress", label: "In progress", jobs: inProgress },
    { id: "waiting", label: "Waiting", jobs: queued },
    { id: "recent", label: "Recently completed", jobs: recent },
  ].filter((section) => section.jobs.length > 0);
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
  const summaryLabels = [
    failed.length ? `${failed.length} ${failed.length === 1 ? "task needs" : "tasks need"} attention` : "",
    ...activeStateLabels,
  ].filter(Boolean);
  const countLabel = summaryLabels.length
    ? summaryLabels.join(" / ")
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
    const changed = jobs.filter((job) => job.terminal && previous.get(job.jobId) !== job.state);
    if (!changed.length) return;
    setAnnouncement(terminalTasksAnnouncement(changed));
    const timer = window.setTimeout(() => setAnnouncement(""), 6_000);
    return () => window.clearTimeout(timer);
  }, [jobs]);

  const confirmCancelAll = () => {
    setCancelAllConfirmationOpen(false);
    onCancelAll();
  };

  const renderJob = (job: BackgroundTask) => {
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
          <span>{state === "failed" ? job.error?.message ?? "Work needs attention" : progressLabel(job)}</span>
          {eta ? <small>{eta}</small> : null}
        </div>
        <div className="background-job-actions">
          {recordingId ? <button type="button" aria-label={`Open meeting for ${jobLabel(job)}`} onClick={() => onOpenMeeting(recordingId)}>Open meeting</button> : null}
          {CANCELLABLE_TASK_STATES.has(state) ? <button type="button" aria-label={`Cancel ${jobLabel(job)}`} onClick={() => onCancel(jobId)}>Cancel</button> : null}
          {canRetry ? <button type="button" className="primary" aria-label={`${retryLabel} ${jobLabel(job)}`} onClick={() => onRetry(jobId)}>{retryLabel}</button> : null}
          {job.terminal ? <button type="button" aria-label={`Dismiss ${jobLabel(job)}`} onClick={() => onDismiss(jobId)}>Dismiss</button> : null}
        </div>
      </article>
    );
  };

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
          <div><strong>Activity</strong><span>{countLabel}</span></div>
          {cancellable.length > 1 ? <button type="button" aria-label="Cancel all cancellable background tasks" onClick={() => setCancelAllConfirmationOpen(true)}>Cancel all</button> : null}
        </header>
        {sections.length ? sections.map((section) => (
          <div className="background-task-section" key={section.id} data-section={section.id}>
            <h3>{section.label}</h3>
            {section.jobs.map(renderJob)}
          </div>
        )) : <p className="background-activity-empty">Nothing running.</p>}
        {cancelAllConfirmationOpen ? (
          <div className="background-cancel-confirmation" role="dialog" aria-modal="true" aria-labelledby="cancel-all-background-title">
            <div>
              <h3 id="cancel-all-background-title">Cancel {cancellable.length} background tasks?</h3>
              <p>Completed and already-cancelling tasks will not be changed.</p>
              <div className="background-cancel-actions">
                <button type="button" onClick={() => setCancelAllConfirmationOpen(false)}>Keep tasks</button>
                <button type="button" className="primary" onClick={confirmCancelAll}>Cancel tasks</button>
              </div>
            </div>
          </div>
        ) : null}
      </section>
      </details>
    </div>
  );
}
