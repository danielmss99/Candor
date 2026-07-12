import type { ReactNode } from "react";
import { RecordGlyph } from "../../components/RecordAction";
import { EvidenceTimeline, FadePanel, type EvidenceMarker } from "../../meeting-motion";
import { formatDuration, type AiMode, type CompactMeetingPane, type RecapItem, type RecordingSummary } from "../../core/contracts";

interface LiveMeetingViewProps {
  title: string;
  selectedRecording: RecordingSummary | undefined;
  selectedRecordingId: string;
  activeRecordingId: string;
  activeCapture: boolean;
  consentReady: boolean;
  durationMs: number;
  audioUrl: string;
  markers: EvidenceMarker[];
  compactPane: CompactMeetingPane;
  notesPanelMode: "notes" | "suggestions";
  notesMarkdown: string;
  notesDirty: boolean;
  notesSaved: boolean;
  recapSuggestions: RecapItem[];
  aiMode: AiMode;
  aiModeStatus: string;
  captureStatusLabel: string;
  jobStatusLabel: string;
  busy: boolean;
  transcriptContent: ReactNode;
  onReview: () => void;
  onReviewConsent: () => void;
  onLoadAudio: () => void;
  onMarkMoment: (timeMs: number) => void;
  onCompactPaneChange: (pane: CompactMeetingPane) => void;
  onNotesPanelModeChange: (mode: "notes" | "suggestions") => void;
  onTranscribe: () => void;
  onNotesChange: (value: string) => void;
  onSaveNotes: () => void;
  onGenerateRecap: () => void;
  onAiModeChange: (mode: AiMode) => void;
  onStartStop: () => void;
}

export function LiveMeetingView({
  title,
  selectedRecording,
  selectedRecordingId,
  activeRecordingId,
  activeCapture,
  consentReady,
  durationMs,
  audioUrl,
  markers,
  compactPane,
  notesPanelMode,
  notesMarkdown,
  notesDirty,
  notesSaved,
  recapSuggestions,
  aiMode,
  aiModeStatus,
  captureStatusLabel,
  jobStatusLabel,
  busy,
  transcriptContent,
  onReview,
  onReviewConsent,
  onLoadAudio,
  onMarkMoment,
  onCompactPaneChange,
  onNotesPanelModeChange,
  onTranscribe,
  onNotesChange,
  onSaveNotes,
  onGenerateRecap,
  onAiModeChange,
  onStartStop,
}: LiveMeetingViewProps) {
  return (
    <section className="page-view live-meeting-view" data-view="meeting" data-compact-pane={compactPane}>
      <header className="screen-heading meeting-heading"><div><h1>{title}</h1><p>{selectedRecording ? `${formatDuration(selectedRecording.audioDurationMs)} local audio` : "Ready for a new local recording"}</p></div><button className="primary-button" type="button" onClick={onReview} disabled={!selectedRecordingId}>Review meeting</button></header>
      {!consentReady ? <div className="consent-callout" role="status"><div><strong>Recording consent required</strong><span>Local storage and microphone acknowledgement are not yet recorded.</span></div><button type="button" onClick={onReviewConsent}>Review consent</button></div> : null}
      <EvidenceTimeline active={activeCapture} durationMs={durationMs} audioUrl={audioUrl} markers={markers} canMark={Boolean(selectedRecordingId)} onLoadAudio={onLoadAudio} onMarkMoment={onMarkMoment} />
      <div className="compact-pane-switcher segmented-control" role="tablist" aria-label="Meeting workspace panes">
        <button type="button" role="tab" aria-selected={compactPane === "transcript"} onClick={() => onCompactPaneChange("transcript")}>Transcript</button>
        <button type="button" role="tab" aria-selected={compactPane === "notes"} onClick={() => { onCompactPaneChange("notes"); onNotesPanelModeChange("notes"); }}>Notes</button>
        <button type="button" role="tab" aria-selected={compactPane === "ai"} onClick={() => { onCompactPaneChange("ai"); onNotesPanelModeChange("suggestions"); }}>AI</button>
      </div>
      <div className="live-workspace-grid">
        <section className="live-transcript" aria-label="Live transcript"><div className="section-heading"><div><h2>Live transcript</h2><span className="success-text">{activeCapture ? "Following live" : "Stored locally"}</span></div><button type="button" onClick={onTranscribe} disabled={!selectedRecordingId || busy}>Transcribe locally</button></div>{transcriptContent}</section>
        <section className="meeting-notes-panel">
          <div className="panel-tabs" role="tablist" aria-label="Notes panel"><button type="button" role="tab" aria-selected={notesPanelMode === "notes"} onClick={() => onNotesPanelModeChange("notes")}>My notes</button><button type="button" role="tab" aria-selected={notesPanelMode === "suggestions"} onClick={() => onNotesPanelModeChange("suggestions")}>AI suggestions <span>{recapSuggestions.length}</span></button></div>
          {notesPanelMode === "notes" ? <FadePanel panelKey="notes"><div className="notes-editor-wrap"><textarea aria-label="Meeting notes" value={notesMarkdown} onChange={(event) => onNotesChange(event.target.value)} placeholder="Write local meeting notes..." /><div className="notes-footer"><span>{notesDirty ? "Unsaved" : notesSaved ? "Saved locally" : "Local draft"}</span><button type="button" onClick={onSaveNotes} disabled={!selectedRecordingId || !notesDirty || busy}>Save notes</button></div></div></FadePanel> : <FadePanel panelKey="suggestions"><div className="suggestion-pane"><div className="suggestion-list"><button className="secondary-button full-width" type="button" onClick={onGenerateRecap} disabled={!selectedRecordingId || busy}>Generate local suggestions</button>{recapSuggestions.map((item) => <article className="suggestion-row" key={`${item.category}-${item.segmentIndex}-${item.text}`}><strong>{item.category || "Insight"}</strong><p>{item.text}</p><span>{formatDuration(item.startMs)}</span></article>)}{!recapSuggestions.length ? <p className="empty-state">No AI suggestions generated.</p> : null}</div><div className="ai-mode-row"><div className="ai-mode-copy"><strong>Local AI</strong><span id="local-ai-mode-status">{aiModeStatus}</span></div><div className="segmented-control" role="group" aria-label="Local AI mode" aria-describedby="local-ai-mode-status"><button type="button" aria-pressed={aiMode === "quality"} onClick={() => onAiModeChange("quality")}>Quality</button><button type="button" aria-pressed={aiMode === "fast"} onClick={() => onAiModeChange("fast")}>Fast</button></div></div></div></FadePanel>}
        </section>
      </div>
      <footer className="recording-transport"><div><RecordGlyph active={activeCapture} /><strong>{captureStatusLabel}</strong><span>{activeRecordingId || selectedRecordingId || "No active session"}</span></div><div className="transport-actions"><button type="button" onClick={onStartStop} disabled={busy}>{activeCapture ? "Stop" : "Record"}</button><button type="button" onClick={onReview} disabled={!selectedRecordingId}>Review meeting</button></div><span className="success-text">{activeCapture ? "Writing durable chunks" : jobStatusLabel}</span></footer>
    </section>
  );
}
