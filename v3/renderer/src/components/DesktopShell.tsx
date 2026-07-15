import type { ReactNode } from "react";
import { Activity, BookOpenText, HardDrive, Home, Moon, Settings, Sun, X } from "lucide-react";
import { RecordAction } from "./RecordAction";
import { BackgroundActivity } from "../features/jobs/BackgroundActivity";
import { useAppearance } from "../features/appearance/useAppearance";
import type { AppView, PersistentAlert, RecordingSummary } from "../core/contracts";

interface DesktopShellProps {
  view: AppView;
  recordings: RecordingSummary[];
  openMeetingIds: string[];
  selectedRecordingId: string;
  activeCapture: boolean;
  combinedCaptureAvailable: boolean;
  busy: boolean;
  notice: string;
  error: string;
  persistentAlerts?: PersistentAlert[];
  jobs?: BackgroundTask[];
  custodyStatus?: "verified" | "attention" | "unavailable";
  children: ReactNode;
  onHome: () => void;
  onStartRecording: () => void;
  onNavigate: (view: AppView) => void;
  onOpenRecording: (recordingId: string) => void;
  onCloseMeeting: (recordingId: string) => void;
  onDismissNotice: () => void;
  onDismissError: () => void;
  onOpenPrivacy?: () => void;
  onCancelJob?: (jobId: string) => void;
  onRetryJob?: (jobId: string) => void;
  onCancelAllJobs?: () => void;
  onAcknowledgeJob?: (jobId: string) => void;
}

export function DesktopShell({
  view,
  recordings,
  openMeetingIds,
  selectedRecordingId,
  activeCapture,
  combinedCaptureAvailable,
  busy,
  notice,
  error,
  persistentAlerts = [],
  jobs = [],
  custodyStatus = "unavailable",
  children,
  onHome,
  onStartRecording,
  onNavigate,
  onOpenRecording,
  onCloseMeeting,
  onDismissNotice,
  onDismissError,
  onOpenPrivacy = () => onNavigate("settings"),
  onCancelJob = () => undefined,
  onRetryJob = () => undefined,
  onCancelAllJobs = () => undefined,
  onAcknowledgeJob = () => undefined,
}: DesktopShellProps) {
  const { appearance, toggleAppearance } = useAppearance();
  const navigation: Array<[AppView, string, typeof Home]> = [["home", "Home", Home], ["library", "Meetings", BookOpenText], ["settings", "Settings", Settings]];
  const openTabs = openMeetingIds.map((id) => recordings.find((recording) => recording.recordingId === id)).filter((recording): recording is RecordingSummary => Boolean(recording));
  const visibleMeetings = openTabs.slice(0, 3);
  const overflowMeetings = openTabs.slice(3);
  const custodyLabel = custodyStatus === "verified" ? "On this device" : custodyStatus === "attention" ? "Review custody" : "Custody unavailable";

  return (
    <main className="candor-desktop" data-appearance={appearance}>
      <aside className="desktop-sidebar" aria-label="Candor navigation">
        <button className="wordmark" type="button" onClick={onHome}><img src="./candor-mark.png" width="26" height="26" alt="" aria-hidden="true" /><span>Candor</span></button>
        {activeCapture ? <div className="sidebar-recording-status" role="status"><span className="status-dot recording" /><span><strong>Recording</strong><small>Use the meeting controls to stop</small></span></div> : <RecordAction variant="sidebar" active={false} captureLabel={combinedCaptureAvailable ? "Mic + system audio" : "Microphone audio"} onClick={onStartRecording} disabled={busy} />}
        <nav className="desktop-nav" aria-label="Primary">{navigation.map(([id, label, Icon]) => <button type="button" aria-current={view === id ? "page" : undefined} key={id} onClick={() => onNavigate(id)}><Icon size={16} aria-hidden="true" /><span>{label}</span></button>)}</nav>
        {visibleMeetings.length ? <nav className="open-meetings" aria-label="Open meetings"><header><span>Open</span>{overflowMeetings.length ? <em>{openTabs.length}</em> : null}</header>{visibleMeetings.map((recording) => <div className="open-meeting-row" key={recording.recordingId} data-active={selectedRecordingId === recording.recordingId}><button type="button" aria-current={selectedRecordingId === recording.recordingId ? "page" : undefined} onClick={() => onOpenRecording(recording.recordingId)}><span className="tab-dot" /><span className="open-meeting-label">{recording.label}</span></button><button type="button" className="icon-button" aria-label={`Close ${recording.label}`} title="Close meeting" onClick={() => onCloseMeeting(recording.recordingId)}><X size={14} aria-hidden="true" /></button></div>)}{overflowMeetings.length ? <details className="open-meeting-overflow"><summary>More meetings</summary><div>{overflowMeetings.map((recording) => <button type="button" key={recording.recordingId} onClick={() => onOpenRecording(recording.recordingId)}>{recording.label}</button>)}</div></details> : null}</nav> : null}
        <div className="sidebar-spacer" />
        <BackgroundActivity jobs={jobs} onCancel={onCancelJob} onRetry={onRetryJob} onCancelAll={onCancelAllJobs} onOpenMeeting={onOpenRecording} onDismiss={onAcknowledgeJob} />
        <footer className="sidebar-footer">
          <details className="custody-control" data-status={custodyStatus}><summary><HardDrive size={15} aria-hidden="true" /><span>{custodyLabel}</span></summary><div><strong>{custodyStatus === "verified" ? "Local custody verified" : custodyStatus === "attention" ? "Custody needs attention" : "Custody status unavailable"}</strong><p>{custodyStatus === "verified" ? "Candor's local runtime reports no external meeting-data calls." : "Open Privacy to inspect the latest measured status."}</p><button type="button" onClick={onOpenPrivacy}>Open Privacy</button></div></details>
          <button type="button" className="appearance-toggle icon-button" onClick={toggleAppearance} aria-label={`Switch to ${appearance === "dark" ? "light" : "dark"} mode`} title={`Switch to ${appearance === "dark" ? "light" : "dark"} mode`}>{appearance === "dark" ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}</button>
        </footer>
      </aside>
      <section className="desktop-content">
          <div className="message-stack" aria-live="polite">
            {notice ? <div className="app-message success" role="status"><span>{notice}</span><button className="icon-button" type="button" aria-label="Dismiss notification" title="Dismiss" onClick={onDismissNotice}><X size={15} aria-hidden="true" /></button></div> : null}
            {error ? <div className="app-message error" role="alert"><span>{error}</span><button className="icon-button" type="button" aria-label="Dismiss error" title="Dismiss" onClick={onDismissError}><X size={15} aria-hidden="true" /></button></div> : null}
          </div>
          {persistentAlerts.length ? <div className="system-alert-stack" aria-label="Local system status">{persistentAlerts.map((alert) => <section className={`system-alert ${alert.severity}`} role={alert.severity === "error" ? "alert" : "status"} key={alert.id}><Activity size={17} aria-hidden="true" /><div><strong>{alert.title}</strong><span>{alert.message}</span></div>{alert.actions?.length ? <div className="system-alert-actions">{alert.actions.map((action) => <button type="button" className={action.primary ? "primary" : ""} onClick={action.onActivate} key={action.label}>{action.label}</button>)}</div> : null}</section>)}</div> : null}
          {children}
      </section>
    </main>
  );
}
