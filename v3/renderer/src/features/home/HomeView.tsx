import { ChevronRight, Cpu, FolderInput, HardDrive, MoreHorizontal } from "lucide-react";
import { EmptyState } from "../../components/EmptyState";
import { asNumber, asString, formatDuration, metric, type JsonObject, type RecordingSummary } from "../../core/contracts";
import { MediaImportControl } from "../media-import";

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
  onMediaImported: () => void | Promise<void>;
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
  onOpenLibrary,
  onImport,
  onMediaImported,
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
      <header className="screen-heading"><div><h1>Home</h1><p>Pick up where you left off.</p></div></header>
      <div className="home-command-row">
        <label className="quick-title-field"><span>Next recording</span><input value={recordingTitle} onChange={(event) => onRecordingTitleChange(event.target.value)} aria-label="Next recording title" /></label>
        <details className="command-menu"><summary aria-label="More home actions" title="More actions"><MoreHorizontal size={18} aria-hidden="true" /></summary><div><button type="button" onClick={onImport} disabled={busy || !importAvailable}><FolderInput size={16} aria-hidden="true" />Import previous Candor folder</button></div></details>
      </div>
      {recordingBlocked && !activeCapture ? <div className="home-warning" role="alert"><HardDrive size={17} aria-hidden="true" /><div><strong>Recording is unavailable</strong><span>Free storage space before starting another meeting.</span></div></div> : null}
      <MediaImportControl
        compact
        disabled={activeCapture || busy}
        disabledMessage={activeCapture
          ? "Finish the current recording before importing media."
          : busy
            ? "Wait for the current local operation to finish before importing media."
            : undefined}
        onImported={onMediaImported}
      />
      <section className="dashboard-section">
        <div className="section-heading"><h2>Recent meetings</h2><button type="button" onClick={onOpenLibrary}>View all</button></div>
        <div className="recent-meeting-list">
          {recordings.slice(0, 6).map((recording) => (
            <button className="meeting-row" type="button" key={recording.recordingId} onClick={() => onOpenRecording(recording.recordingId)}>
              <span className="meeting-row-main"><strong>{recording.label}</strong><small>{recording.transcriptSegmentCount ? `${recording.transcriptSegmentCount} transcript segments` : "Transcript not created"}</small></span>
              <span className="meeting-row-meta">{formatDuration(recording.audioDurationMs)}<ChevronRight size={16} aria-hidden="true" /></span>
            </button>
          ))}
          {!recordings.length ? <EmptyState title="No meetings yet" description="Use Record in the sidebar to capture your first conversation." /> : null}
        </div>
      </section>
      <footer className="home-health" aria-label="Workspace readiness"><span><HardDrive size={15} aria-hidden="true" /><strong>Storage</strong>{availableLabel}</span><span><Cpu size={15} aria-hidden="true" /><strong>Meeting assistance</strong>{instructReady ? "Ready" : aiModeStatus}</span><span><strong>Speech models</strong>{metric(verifiedModelCount, "0")} verified</span><span className="sr-only">{combinedCaptureAvailable ? "Microphone and system audio available" : "Microphone audio available"}</span><span className="sr-only">Storage status {storageLevel}</span></footer>
    </section>
  );
}
