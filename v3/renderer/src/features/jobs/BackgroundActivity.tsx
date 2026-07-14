import { useEffect, useRef, useState } from "react";
import { asBool, asNumber, asObject, asString, type JsonObject } from "../../core/contracts";

interface BackgroundActivityProps {
  jobs: JsonObject[];
  onCancel: (jobId: string) => void;
  onRetry: (jobId: string) => void;
  onCancelAll: () => void;
  onOpenMeeting: (recordingId: string) => void;
  onDismiss: (jobId: string) => void;
}

function jobLabel(job: JsonObject): string {
  const type = asString(job.type, "Local work");
  if (type === "transcription") return "Transcribing meeting";
  if (type === "recap") return "Creating recap";
  if (type === "ask") return "Answering from meeting";
  if (type === "export") return "Creating export";
  if (type === "dictionary-import") return "Installing dictionary";
  if (type === "dictionary-index") return "Preparing terminology";
  return type.replaceAll("-", " ");
}

function progressLabel(job: JsonObject): string {
  const progress = asObject(job.progress);
  const completed = asNumber(progress.completed);
  const total = asNumber(progress.total);
  if (total > 0) return `${Math.min(100, Math.round((completed / total) * 100))}%`;
  const stage = asString(job.stage);
  return stage ? stage.replaceAll("-", " ") : asString(job.state, "queued");
}

function etaLabel(job: JsonObject): string {
  const remainingMs = asNumber(job.estimatedRemainingMs, -1);
  if (remainingMs < 0) return "Estimating time remaining";
  if (remainingMs < 60_000) return "Less than a minute remaining";
  const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  return `About ${minutes} ${minutes === 1 ? "minute" : "minutes"} remaining`;
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
  const active = jobs.filter((job) => !asBool(job.terminal));
  const failed = jobs.filter((job) => asString(job.state) === "failed");
  const recentCompleted = jobs.filter((job) => asString(job.state) === "completed").slice(0, 2);
  const visible = [...active, ...failed, ...recentCompleted].slice(0, 8);
  const countLabel = active.length
    ? `${active.length} ${active.length === 1 ? "job" : "jobs"} running`
    : failed.length
      ? `${failed.length} ${failed.length === 1 ? "job needs" : "jobs need"} attention`
      : "Activity";

  useEffect(() => {
    const nextStates = new Map(jobs.map((job) => [asString(job.jobId), asString(job.state)]));
    const previous = previousStates.current;
    previousStates.current = nextStates;
    if (!previous) return;
    const changed = jobs.find((job) => {
      const jobId = asString(job.jobId);
      const state = asString(job.state);
      return asBool(job.terminal) && previous.get(jobId) !== state;
    });
    if (!changed) return;
    const state = asString(changed.state);
    setAnnouncement(
      state === "completed"
        ? `${jobLabel(changed)} completed locally.`
        : `${jobLabel(changed)} needs attention.`,
    );
    const timer = window.setTimeout(() => setAnnouncement(""), 6_000);
    return () => window.clearTimeout(timer);
  }, [jobs]);

  return (
    <div className="background-activity-wrap">
      {announcement ? <div className="background-job-notification" role="status">{announcement}</div> : null}
      <details className="background-activity">
      <summary aria-label={`Background activity, ${countLabel}`}>
        <span className={`status-dot ${failed.length ? "warning" : active.length ? "working" : "ok"}`} />
        {countLabel}
      </summary>
      <section className="background-activity-panel" aria-label="Background activity" aria-live="polite">
        <header>
          <div><strong>Background activity</strong><span>Processing stays on this device</span></div>
          {active.length > 1 ? <button type="button" aria-label="Cancel all background jobs" onClick={onCancelAll}>Cancel all</button> : null}
        </header>
        {visible.length ? visible.map((job) => {
          const jobId = asString(job.jobId);
          const recordingId = asString(job.recordingId);
          const state = asString(job.state);
          const error = asObject(job.error);
          const canRetry = (state === "failed" || state === "cancelled" || state === "paused") && asBool(job.retryable);
          return (
            <article className="background-job" key={jobId} data-state={state}>
              <div className="background-job-copy">
                <strong>{jobLabel(job)}</strong>
                <span>{state === "failed" ? asString(error.message, "Local work needs attention") : progressLabel(job)}</span>
                {!asBool(job.terminal) ? <small>{etaLabel(job)}</small> : null}
              </div>
              <div className="background-job-actions">
                {recordingId ? <button type="button" aria-label={`Open meeting for ${jobLabel(job)}`} onClick={() => onOpenMeeting(recordingId)}>Open meeting</button> : null}
                {!asBool(job.terminal) ? <button type="button" aria-label={`Cancel ${jobLabel(job)}`} onClick={() => onCancel(jobId)}>Cancel</button> : null}
                {canRetry ? <button type="button" className="primary" aria-label={`Retry ${jobLabel(job)}`} onClick={() => onRetry(jobId)}>Retry</button> : null}
                {asBool(job.terminal) ? <button type="button" aria-label={`Dismiss ${jobLabel(job)}`} onClick={() => onDismiss(jobId)}>Dismiss</button> : null}
              </div>
            </article>
          );
        }) : <p className="background-activity-empty">No background work yet.</p>}
      </section>
      </details>
    </div>
  );
}
