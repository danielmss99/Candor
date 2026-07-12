import type { ReactNode } from "react";
import { DocumentPreview } from "../export/DocumentPreview";
import { exportFormatLabel, recapItemKey, type ExportFormat, type LocalAiRecap, type RecapItem, type ReviewSection } from "../../core/contracts";

interface ReviewViewProps {
  title: string;
  reviewSection: ReviewSection;
  reviewStates: Record<string, "accepted" | "rejected">;
  summaryDraft: string;
  recap: LocalAiRecap | null;
  notesMarkdown: string;
  notesDirty: boolean;
  transcriptContent: ReactNode;
  exportFormat: ExportFormat;
  includeSummary: boolean;
  includeNotes: boolean;
  includeTranscript: boolean;
  previewDecisions: RecapItem[];
  previewActions: RecapItem[];
  previewRisks: RecapItem[];
  previewQuestions: RecapItem[];
  selectedRecordingId: string;
  busy: boolean;
  onSectionChange: (section: ReviewSection) => void;
  onSummaryDraftChange: (value: string) => void;
  onNotesChange: (value: string) => void;
  onSaveNotes: () => void;
  onGenerateRecap: () => void;
  onReviewItem: (key: string, state: "accepted" | "rejected") => void;
  onOpenExport: () => void;
}

export function ReviewView(props: ReviewViewProps) {
  const reviewItems = (section: ReviewSection): RecapItem[] => {
    if (!props.recap) return [];
    if (section === "decisions") return props.recap.decisions;
    if (section === "actions") return props.recap.actions;
    if (section === "questions") return props.recap.questions;
    if (section === "risks") return props.recap.risks;
    return [...props.recap.decisions, ...props.recap.actions].slice(0, 4);
  };
  const renderCenter = () => {
    if (props.reviewSection === "notes") return <div className="review-editor"><h2>Manual notes</h2><textarea aria-label="Meeting notes" value={props.notesMarkdown} onChange={(event) => props.onNotesChange(event.target.value)} /><button type="button" onClick={props.onSaveNotes} disabled={!props.notesDirty || props.busy}>Save notes</button></div>;
    if (props.reviewSection === "transcript") return <div className="review-editor"><h2>Transcript</h2>{props.transcriptContent}</div>;
    if (props.reviewSection === "preview") return <div className="review-editor"><h2>Export preview</h2><p className="empty-state">The verified local document preview remains visible beside this review area.</p><button type="button" className="primary-button" onClick={props.onOpenExport}>Open export flow</button></div>;
    if (props.reviewSection !== "summary") {
      const items = reviewItems(props.reviewSection);
      const title = props.reviewSection === "actions" ? "Action items" : props.reviewSection === "questions" ? "Open questions" : props.reviewSection[0].toUpperCase() + props.reviewSection.slice(1);
      return <div className="review-editor"><h2>{title}</h2><div className="review-item-list">{items.map((item) => { const key = recapItemKey(item); const state = props.reviewStates[key]; return <article key={key}><div><strong>{item.category || props.reviewSection}</strong><p>{item.text}</p></div><div className="review-actions"><button type="button" aria-pressed={state === "accepted"} onClick={() => props.onReviewItem(key, "accepted")}>Accept</button><button type="button" aria-pressed={state === "rejected"} onClick={() => props.onReviewItem(key, "rejected")}>Reject</button></div></article>; })}{!items.length ? <p className="empty-state">Generate a local recap to review this section.</p> : null}</div></div>;
    }
    const items = reviewItems("summary");
    return <div className="review-editor"><h2>Executive summary</h2><p className="review-subtitle">Review local AI output before export.</p><textarea className="summary-editor" value={props.summaryDraft} onChange={(event) => props.onSummaryDraftChange(event.target.value)} placeholder="Generate a local recap to begin review." /><div className="section-heading"><h3>AI review</h3><button type="button" onClick={props.onGenerateRecap} disabled={!props.selectedRecordingId || props.busy}>Refresh recap</button></div><div className="review-item-list">{items.map((item) => { const key = recapItemKey(item); const state = props.reviewStates[key]; return <article key={key}><div><strong>{item.category || "Insight"}</strong><p>{item.text}</p></div><div className="review-actions"><button type="button" aria-pressed={state === "accepted"} onClick={() => props.onReviewItem(key, "accepted")}>Accept</button><button type="button" aria-pressed={state === "rejected"} onClick={() => props.onReviewItem(key, "rejected")}>Reject</button></div></article>; })}{!items.length ? <p className="empty-state">No AI review items yet.</p> : null}</div></div>;
  };
  const sections: Array<[ReviewSection, string]> = [["summary", "Executive summary"], ["decisions", "Decisions"], ["actions", "Action items"], ["questions", "Open questions"], ["risks", "Risks"], ["notes", "Manual notes"], ["transcript", "Transcript"], ["preview", "Export preview"]];
  const reviewed = Object.keys(props.reviewStates).length;
  return <section className="review-mode" data-view="review"><nav className="review-navigation" aria-label="Review sections"><span>REVIEW SECTIONS</span>{sections.map(([id, label]) => <button type="button" aria-current={props.reviewSection === id ? "page" : undefined} key={id} onClick={() => props.onSectionChange(id)}>{label}</button>)}<div className="review-progress"><strong>{Math.min(8, reviewed)} of 8 sections reviewed</strong><span>{Object.values(props.reviewStates).filter((state) => state === "rejected").length} items need attention</span></div></nav><main className="review-main">{renderCenter()}</main><aside className="review-preview"><div className="section-heading"><div><h2>Export preview</h2><span>{exportFormatLabel(props.exportFormat)}, local</span></div><button type="button" onClick={props.onOpenExport}>Edit</button></div><DocumentPreview title={props.title} summary={props.summaryDraft || props.recap?.summary || ""} decisions={props.previewDecisions} actions={props.previewActions} risks={props.previewRisks} questions={props.previewQuestions} includeSummary={props.includeSummary} includeNotes={props.includeNotes} includeTranscript={props.includeTranscript} /><button type="button" className="primary-button full-width" onClick={props.onOpenExport}>Export report</button></aside></section>;
}
