import type { ReactNode } from "react";
import { MoreHorizontal, ShieldCheck, Trash2 } from "lucide-react";
import { PrivacyReceipt } from "../privacy/PrivacyReceipt";
import { TrustHistoryPanel } from "../history";
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
  askQuestion: string;
  askAnswer: LocalAiAnswer | null;
  aiModeStatus: string;
  privacyReceipt: MeetingPrivacyReceipt | null;
  networkCapabilities: NetworkCapabilities;
  busy: boolean;
  onDetailSectionChange: (section: DetailSection) => void;
  onReview: () => void;
  onDelete: () => void;
  onNotesChange: (value: string) => void;
  onSaveNotes: () => void;
  onGenerateRecap: () => void;
  onRetryRecapWithLocalAi: () => void;
  onAskQuestionChange: (value: string) => void;
  onAsk: () => void;
  onRetryAskWithLocalAi: () => void;
  onTranscriptRevisionChanged: () => void | Promise<void>;
}

export function MeetingDetailView(props: MeetingDetailViewProps) {
  const renderContent = () => {
    if (props.detailSection === "history") return <TrustHistoryPanel recordingId={props.selectedRecordingId} onTranscriptRevisionChanged={props.onTranscriptRevisionChanged} />;
    if (props.detailSection === "transcript") return props.transcriptContent;
    if (props.detailSection === "notes") return <div className="detail-notes"><textarea aria-label="Meeting notes" value={props.notesMarkdown} onChange={(event) => props.onNotesChange(event.target.value)} /><button type="button" onClick={props.onSaveNotes} disabled={!props.notesDirty || props.busy}>Save notes</button></div>;
    return <div className="summary-content"><div className="summary-copy"><div className="section-heading"><h2>Summary</h2><button type="button" onClick={props.onGenerateRecap} disabled={!props.selectedRecordingId || props.busy}>Generate recap</button></div>{props.recap?.provenance?.fallbackUsed ? <div className="inline-alert" role="status"><div><strong>Created with the local fallback</strong><span>Local AI was unavailable. This result remains saved while you retry.</span></div><button type="button" onClick={props.onRetryRecapWithLocalAi} disabled={props.busy}>Retry with Local AI</button></div> : null}<p>{props.recap?.summary || "Generate a recap from this meeting's transcript."}</p>{props.recap?.citations.length ? <ul className="recap-citations" aria-label="Recap citations">{props.recap.citations.map((citation) => <li key={`${citation.segmentIndex}-${citation.startMs}-${citation.text}`}><span>{formatDuration(citation.startMs)}</span><p>{citation.quote || citation.text}</p></li>)}</ul> : null}</div><div className="structured-list"><h2>Decisions</h2>{props.recap?.decisions.map((item) => <article key={`${item.segmentIndex}-${item.text}`}><span className="decision-mark" aria-hidden="true">OK</span><strong>{item.text}</strong><small>{formatDuration(item.startMs)}</small></article>)}{!props.recap?.decisions.length ? <p className="empty-state">No reviewed decisions yet.</p> : null}</div><div className="structured-list"><h2>Action items</h2>{props.recap?.actions.slice(0, 4).map((item) => <article key={`${item.segmentIndex}-${item.text}`}><span className="check-box" aria-hidden="true" /><strong>{item.text}</strong><small>{item.speaker}</small></article>)}{!props.recap?.actions.length ? <p className="empty-state">No reviewed actions yet.</p> : null}</div></div>;
  };
  const detailTabs: Array<[DetailSection, string]> = [["summary", "Summary"], ["transcript", "Transcript"], ["history", "History"], ["notes", "Notes"]];
  return (
    <section className="page-view" data-view="detail">
      <header className="screen-heading meeting-heading"><div><h1>{props.title}</h1><p>{props.selectedRecording ? `${formatDuration(props.selectedRecording.audioDurationMs)} recording` : "Select a meeting"}</p></div><div className="screen-heading-actions"><details className="command-menu"><summary aria-label="More meeting actions" title="More actions"><MoreHorizontal size={18} aria-hidden="true" /></summary><div><button type="button" className="danger-menu-item" onClick={props.onDelete} disabled={!props.selectedRecordingId || props.selectedRecording?.state !== "finished" || props.busy}><Trash2 size={15} aria-hidden="true" />Delete meeting</button></div></details><button type="button" className="primary-button" onClick={props.onReview} disabled={!props.selectedRecordingId}>Review report</button></div></header>
      <div className="content-tabs" role="tablist" aria-label="Meeting detail sections">{detailTabs.map(([id, label]) => <button type="button" role="tab" aria-selected={props.detailSection === id} key={id} onClick={() => props.onDetailSectionChange(id)}>{label}</button>)}</div>
      <div className="detail-grid"><section className="detail-main">{renderContent()}</section><aside className="meeting-intelligence"><h2>Ask Candor</h2><div className="ask-control"><input value={props.askQuestion} onChange={(event) => props.onAskQuestionChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") props.onAsk(); }} placeholder="Ask about this meeting" /><button type="button" onClick={props.onAsk} disabled={!props.selectedRecordingId || props.busy}>Ask</button></div>{props.askAnswer ? <div className="answer-panel">{props.askAnswer.provenance?.fallbackUsed ? <div className="inline-alert" role="status"><strong>Created with the local fallback</strong><button type="button" onClick={props.onRetryAskWithLocalAi} disabled={props.busy}>Retry with Local AI</button></div> : null}<strong>{props.askAnswer.provenance?.engine === "local-llm" ? "Local AI" : "Local fallback"}</strong><p>{props.askAnswer.answer}</p>{props.askAnswer.citations.map((citation) => <span className="answer-citation" key={`${citation.segmentIndex}-${citation.startMs}`}><strong>{formatDuration(citation.startMs)}</strong>{citation.quote || citation.text}</span>)}</div> : null}<h3>Meeting facts</h3><dl className="compact-facts"><div><dt>Audio</dt><dd>{props.selectedRecording ? formatDuration(props.selectedRecording.audioDurationMs) : "None"}</dd></div><div><dt>Transcript</dt><dd>{props.transcriptTotalCount} segments</dd></div><div><dt>Notes</dt><dd>{props.notesDirty ? "Unsaved" : "Saved"}</dd></div><div><dt>AI</dt><dd>{props.aiModeStatus}</dd></div></dl><details className="meeting-proof-disclosure"><summary><ShieldCheck size={15} aria-hidden="true" />Meeting proof</summary><PrivacyReceipt receipt={props.privacyReceipt} network={props.networkCapabilities} compact /></details></aside></div>
    </section>
  );
}
