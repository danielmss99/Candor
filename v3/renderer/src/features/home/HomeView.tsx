import { EmptyState } from "../../components/EmptyState";
import { RecordAction } from "../../components/RecordAction";
import { VerificationText } from "../../meeting-motion";
import { asNumber, asString, formatDuration, metric, type JsonObject, type RecordingSummary } from "../../core/contracts";

interface HomeViewProps {
  recordings: RecordingSummary[];
  activeCapture: boolean;
  combinedCaptureAvailable: boolean;
  busy: boolean;
  recordingBlocked: boolean;
  storageHealth: JsonObject;
  importAvailable: boolean;
  recordingTitle: string;
  instructReady: boolean;
  verifiedModelCount: unknown;
  aiModeStatus: string;
  onStartRecording: () => void;
  onOpenLibrary: () => void;
  onImport: () => void;
  onRecordingTitleChange: (value: string) => void;
  onOpenRecording: (recordingId: string) => void;
}

export function HomeView({
  recordings,
  activeCapture,
  combinedCaptureAvailable,
  busy,
  recordingBlocked,
  storageHealth,
  importAvailable,
  recordingTitle,
  instructReady,
  verifiedModelCount,
  aiModeStatus,
  onStartRecording,
  onOpenLibrary,
  onImport,
  onRecordingTitleChange,
  onOpenRecording,
}: HomeViewProps) {
  const storageLevel = asString(storageHealth.level, "unavailable");
  const availableBytes = asNumber(storageHealth.availableBytes, -1);
  const availableLabel = availableBytes >= 1024 ** 3
    ? `${(availableBytes / 1024 ** 3).toFixed(1)} GiB free`
    : availableBytes >= 0
      ? `${Math.floor(availableBytes / 1024 ** 2)} MiB free`
      : "Space check unavailable";
  return (
    <section className="page-view" data-view="home">
      <header className="screen-heading"><h1>Home</h1><p>Your local meeting workspace</p></header>
      <section className="dashboard-actions" aria-label="Quick actions">
        <RecordAction variant="dashboard" active={activeCapture} captureLabel={combinedCaptureAvailable ? "Microphone and system audio" : "Microphone audio"} onClick={onStartRecording} disabled={busy || (recordingBlocked && !activeCapture)} />
        <button className="surface-action" type="button" onClick={onOpenLibrary}>Open meetings</button>
        <button className="surface-action" type="button" onClick={onImport} disabled={busy || !importAvailable}>Import v2 folder</button>
        <label className="quick-title-field"><span>Next recording title</span><input value={recordingTitle} onChange={(event) => onRecordingTitleChange(event.target.value)} /></label>
      </section>
      <section className="dashboard-section">
        <div className="section-heading"><h2>Recent meetings</h2><button type="button" onClick={onOpenLibrary}>View all</button></div>
        <div className="recent-meeting-grid">
          {recordings.slice(0, 4).map((recording) => (
            <button className="meeting-card" type="button" key={recording.recordingId} onClick={() => onOpenRecording(recording.recordingId)}>
              <strong>{recording.label}</strong><span>{formatDuration(recording.audioDurationMs)} local audio</span><small>{recording.transcriptSegmentCount} transcript segments</small>
            </button>
          ))}
          {!recordings.length ? <EmptyState title="No meetings yet" description="Record your first meeting. Audio, transcripts, and notes stay on this computer." actionLabel={recordingBlocked ? undefined : "Start a meeting"} onAction={recordingBlocked ? undefined : onStartRecording} /> : null}
        </div>
      </section>
      <section className="dashboard-section">
        <h2>Storage and privacy</h2>
        <div className="status-grid">
          <div className={`status-panel ${storageLevel === "ok" ? "verified" : storageLevel}`}><strong>Encrypted local storage</strong><p>{recordings.length} meetings stored</p><span>Protected on this device | {availableLabel}</span></div>
          <div className={`status-panel ${instructReady ? "verified" : ""}`}><VerificationText value={instructReady ? "Local AI ready" : "Fast local analysis ready"} /><p>{metric(verifiedModelCount, "0")} verified speech models</p><span>{aiModeStatus}</span></div>
        </div>
      </section>
    </section>
  );
}
