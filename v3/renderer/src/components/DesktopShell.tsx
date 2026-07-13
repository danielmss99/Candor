import type { ReactNode } from "react";
import { RecordAction } from "./RecordAction";
import type { AppView, RecordingSummary } from "../core/contracts";

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
  children: ReactNode;
  onHome: () => void;
  onStartRecording: () => void;
  onNavigate: (view: AppView) => void;
  onOpenRecording: (recordingId: string) => void;
  onCloseMeeting: (recordingId: string) => void;
  onDismissNotice: () => void;
  onDismissError: () => void;
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
  children,
  onHome,
  onStartRecording,
  onNavigate,
  onOpenRecording,
  onCloseMeeting,
  onDismissNotice,
  onDismissError,
}: DesktopShellProps) {
  const navigation: Array<[AppView, string]> = [["home", "Home"], ["library", "Meetings"], ["settings", "Settings"]];
  const openTabs = openMeetingIds.map((id) => recordings.find((recording) => recording.recordingId === id)).filter((recording): recording is RecordingSummary => Boolean(recording));
  const overflowMeetings = recordings.filter((recording) => !openMeetingIds.includes(recording.recordingId));

  return (
    <main className="candor-desktop">
      <header className="session-rail">
        <button className="wordmark" type="button" onClick={onHome}><img src="./candor-mark.png" width="28" height="28" alt="" aria-hidden="true" /><span>Candor</span></button>
        <div className="session-tabs" role="tablist" aria-label="Open meetings">
          {openTabs.length ? openTabs.map((recording) => <div className="session-tab" key={recording.recordingId} data-active={selectedRecordingId === recording.recordingId}><button type="button" role="tab" aria-selected={selectedRecordingId === recording.recordingId} onClick={() => onOpenRecording(recording.recordingId)}><span className="tab-dot" />{recording.label}</button><button className="tab-close" type="button" aria-label={`Close ${recording.label}`} title="Close meeting tab" onClick={() => onCloseMeeting(recording.recordingId)}>x</button></div>) : <div className="session-tab placeholder" data-active="true"><button type="button" role="tab" aria-selected="true" onClick={() => onNavigate("meeting")}><span className="tab-dot" />New local meeting</button></div>}
          {overflowMeetings.length ? <details className="session-overflow"><summary aria-label="Open another meeting" title="More meetings">+{overflowMeetings.length}</summary><div>{overflowMeetings.slice(0, 12).map((recording) => <button type="button" key={recording.recordingId} onClick={() => onOpenRecording(recording.recordingId)}>{recording.label}</button>)}</div></details> : null}
        </div>
        <span className="local-only-status"><span className="status-dot ok" />Local only</span>
      </header>
      <div className="desktop-body">
        <aside className="desktop-sidebar" aria-label="Candor navigation">
          <RecordAction variant="sidebar" active={activeCapture} captureLabel={combinedCaptureAvailable ? "Mic + system audio" : "Microphone audio"} onClick={onStartRecording} disabled={busy} />
          <nav className="desktop-nav" aria-label="Primary"><span>WORKSPACE</span>{navigation.map(([id, label]) => <button type="button" aria-current={view === id ? "page" : undefined} key={id} onClick={() => onNavigate(id)}>{label}</button>)}</nav>
          <footer><strong><span className="status-dot ok" />Local processing active</strong><span>No meeting data leaves this device</span></footer>
        </aside>
        <section className="desktop-content">
          <div className="message-stack" aria-live="polite">
            {notice ? <div className="app-message success" role="status"><span>{notice}</span><button type="button" aria-label="Dismiss notification" title="Dismiss" onClick={onDismissNotice}>x</button></div> : null}
            {error ? <div className="app-message error" role="alert"><span>{error}</span><button type="button" aria-label="Dismiss error" title="Dismiss" onClick={onDismissError}>x</button></div> : null}
          </div>
          {children}
        </section>
      </div>
    </main>
  );
}
