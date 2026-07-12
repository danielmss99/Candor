import type { ReactNode } from "react";
import { PrivacyReceipt } from "../privacy/PrivacyReceipt";
import { formatDuration, type DetailSection, type LocalAiAnswer, type LocalAiRecap, type MeetingPrivacyReceipt, type NetworkCapabilities, type RecordingSummary } from "../../core/contracts";

interface MeetingDetailViewProps {
  title: string;
  selectedRecording: RecordingSummary | undefined;
  selectedRecordingId: string;
  detailSection: DetailSection;
  transcriptContent: ReactNode;
  transcriptTotalCount: number;
  notesMarkdown: string;
  notesDirty: boolean;
  recap: LocalAiRecap | null;
  tracks: string[];
  selectedTrack: string;
  audioUrl: string;
  askQuestion: string;
  askAnswer: LocalAiAnswer | null;
  aiModeStatus: string;
  privacyReceipt: MeetingPrivacyReceipt | null;
  networkCapabilities: NetworkCapabilities;
  busy: boolean;
  onDetailSectionChange: (section: DetailSection) => void;
  onReview: () => void;
  onNotesChange: (value: string) => void;
  onSaveNotes: () => void;
  onGenerateRecap: () => void;
  onTrackChange: (track: string) => void;
  onLoadAudio: () => void;
  onAskQuestionChange: (value: string) => void;
  onAsk: () => void;
}

export function MeetingDetailView(props: MeetingDetailViewProps) {
  const renderContent = () => {
    if (props.detailSection === "transcript") return props.transcriptContent;
    if (props.detailSection === "notes") return <div className="detail-notes"><textarea aria-label="Meeting notes" value={props.notesMarkdown} onChange={(event) => props.onNotesChange(event.target.value)} /><button type="button" onClick={props.onSaveNotes} disabled={!props.notesDirty || props.busy}>Save notes</button></div>;
    if (props.detailSection === "actions") return <div className="structured-list"><h2>Action items</h2>{props.recap?.actions.map((item) => <article key={`${item.segmentIndex}-${item.text}`}><span className="check-box" aria-hidden="true" /><strong>{item.text}</strong><small>{item.speaker} at {formatDuration(item.startMs)}</small></article>)}{!props.recap?.actions.length ? <p className="empty-state">Generate a local recap to extract action items.</p> : null}</div>;
    if (props.detailSection === "audio") return <div className="audio-detail"><div className="track-tabs" role="tablist" aria-label="Audio tracks">{(props.tracks.length ? props.tracks : ["mic"]).map((track) => <button type="button" role="tab" aria-selected={props.selectedTrack === track} key={track} onClick={() => props.onTrackChange(track)}>{track}</button>)}</div><button type="button" className="secondary-button" onClick={props.onLoadAudio} disabled={!props.selectedRecordingId || props.busy}>Load local audio</button>{props.audioUrl ? <audio className="audio-player" controls src={props.audioUrl} /> : null}</div>;
    return <div className="summary-content"><div className="summary-copy"><div className="section-heading"><h2>Executive summary</h2><button type="button" onClick={props.onGenerateRecap} disabled={!props.selectedRecordingId || props.busy}>Generate local recap</button></div><p>{props.recap?.summary || "Generate a local recap from this meeting's transcript."}</p>{props.recap?.citations.length ? <ul className="recap-citations" aria-label="Recap citations">{props.recap.citations.map((citation) => <li key={`${citation.segmentIndex}-${citation.startMs}-${citation.text}`}><button type="button"><span>{formatDuration(citation.startMs)}</span>{citation.quote || citation.text}</button></li>)}</ul> : null}</div><div className="structured-list"><h2>Decisions</h2>{props.recap?.decisions.map((item) => <article key={`${item.segmentIndex}-${item.text}`}><span className="decision-mark" aria-hidden="true">OK</span><strong>{item.text}</strong><small>{formatDuration(item.startMs)}</small></article>)}{!props.recap?.decisions.length ? <p className="empty-state">No reviewed decisions yet.</p> : null}</div><div className="structured-list"><h2>Action items</h2>{props.recap?.actions.slice(0, 4).map((item) => <article key={`${item.segmentIndex}-${item.text}`}><span className="check-box" aria-hidden="true" /><strong>{item.text}</strong><small>{item.speaker}</small></article>)}{!props.recap?.actions.length ? <p className="empty-state">No reviewed actions yet.</p> : null}</div></div>;
  };
  const detailTabs: Array<[DetailSection, string]> = [["summary", "Summary"], ["transcript", "Transcript"], ["notes", "Notes"], ["actions", "Action items"], ["audio", "Audio"]];
  return (
    <section className="page-view" data-view="detail">
      <header className="screen-heading meeting-heading"><div><h1>{props.title}</h1><p>{props.selectedRecording ? `${formatDuration(props.selectedRecording.audioDurationMs)} local meeting` : "Select a meeting from the local library"}</p></div><button type="button" className="primary-button" onClick={props.onReview} disabled={!props.selectedRecordingId}>Review report</button></header>
      <div className="content-tabs" role="tablist" aria-label="Meeting detail sections">{detailTabs.map(([id, label]) => <button type="button" role="tab" aria-selected={props.detailSection === id} key={id} onClick={() => props.onDetailSectionChange(id)}>{label}</button>)}</div>
      <div className="detail-grid"><section className="detail-main">{renderContent()}</section><aside className="meeting-intelligence"><h2>Ask Candor</h2><div className="ask-control"><input value={props.askQuestion} onChange={(event) => props.onAskQuestionChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") props.onAsk(); }} placeholder="Ask about this meeting" /><button type="button" onClick={props.onAsk} disabled={!props.selectedRecordingId || props.busy}>Ask</button></div>{props.askAnswer ? <div className="answer-panel"><strong>{props.askAnswer.engine}</strong><p>{props.askAnswer.answer}</p>{props.askAnswer.citations.map((citation) => <button type="button" key={`${citation.segmentIndex}-${citation.startMs}`}>{formatDuration(citation.startMs)} {citation.quote || citation.text}</button>)}</div> : null}<h3>Meeting facts</h3><dl className="compact-facts"><div><dt>Audio</dt><dd>{props.selectedRecording ? formatDuration(props.selectedRecording.audioDurationMs) : "None"}</dd></div><div><dt>Transcript</dt><dd>{props.transcriptTotalCount} segments</dd></div><div><dt>Notes</dt><dd>{props.notesDirty ? "Unsaved" : "Local"}</dd></div><div><dt>AI</dt><dd>{props.aiModeStatus}</dd></div></dl><PrivacyReceipt receipt={props.privacyReceipt} network={props.networkCapabilities} compact /></aside></div>
    </section>
  );
}
