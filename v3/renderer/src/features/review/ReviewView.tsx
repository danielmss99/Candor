import { useState, type ReactNode } from "react";
import { Eye, FileOutput, X } from "lucide-react";
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
  const [previewOpen, setPreviewOpen] = useState(props.reviewSection === "preview");
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
      return <div className="review-editor"><h2>{title}</h2><div className="review-item-list">{items.map((item) => { const key = recapItemKey(item); const state = props.reviewStates[key]; return <article key={key}><div><strong>{item.category || props.reviewSection}</strong><p>{item.text}</p></div><div className="review-actions"><button type="button" aria-pressed={state === "accepted"} onClick={() => props.onReviewItem(key, "accepted")}>Accept</button><button type="button" aria-pressed={state === "rejected"} onClick={() => props.onReviewItem(key, "rejected")}>Exclude</button></div></article>; })}{!items.length ? <p className="empty-state">Generate a recap to review this section.</p> : null}</div></div>;
    }
    const items = reviewItems("summary");
    return <div className="review-editor"><h2>Executive summary</h2><p className="review-subtitle">Edit the summary and choose which outcomes belong in the report.</p><textarea className="summary-editor" value={props.summaryDraft} onChange={(event) => props.onSummaryDraftChange(event.target.value)} placeholder="Generate a recap to begin review." /><div className="section-heading"><h3>Suggested outcomes</h3><button type="button" onClick={props.onGenerateRecap} disabled={!props.selectedRecordingId || props.busy}>Refresh recap</button></div><div className="review-item-list">{items.map((item) => { const key = recapItemKey(item); const state = props.reviewStates[key]; return <article key={key}><div><strong>{item.category || "Insight"}</strong><p>{item.text}</p></div><div className="review-actions"><button type="button" aria-pressed={state === "accepted"} onClick={() => props.onReviewItem(key, "accepted")}>Accept</button><button type="button" aria-pressed={state === "rejected"} onClick={() => props.onReviewItem(key, "rejected")}>Exclude</button></div></article>; })}{!items.length ? <p className="empty-state">No review items yet.</p> : null}</div></div>;
  };
  const primarySections: Array<[ReviewSection, string]> = [["summary", "Overview"], ["decisions", "Decisions"], ["actions", "Action items"]];
  const secondarySections: Array<[ReviewSection, string]> = [["questions", "Open questions"], ["risks", "Risks"], ["notes", "Manual notes"], ["transcript", "Transcript"]];
  const reviewed = Object.keys(props.reviewStates).length;
  const excluded = Object.values(props.reviewStates).filter((state) => state === "rejected").length;
  return <section className="review-mode" data-view="review"><header className="screen-heading review-heading"><div><h1>Review</h1><p>{props.title}</p></div><div className="screen-heading-actions"><button type="button" className="secondary-button" aria-expanded={previewOpen} onClick={() => setPreviewOpen((open) => !open)}><Eye size={16} aria-hidden="true" />Preview</button><button type="button" className="primary-button" onClick={props.onOpenExport}><FileOutput size={16} aria-hidden="true" />Export report</button></div></header><div className="review-workspace" data-preview-open={previewOpen}><nav className="review-navigation" aria-label="Review sections"><span>Review</span>{primarySections.map(([id, label]) => <button type="button" aria-current={props.reviewSection === id ? "page" : undefined} key={id} onClick={() => props.onSectionChange(id)}>{label}</button>)}<details className="review-more" open={secondarySections.some(([id]) => id === props.reviewSection)}><summary>More</summary><div>{secondarySections.map(([id, label]) => <button type="button" aria-current={props.reviewSection === id ? "page" : undefined} key={id} onClick={() => props.onSectionChange(id)}>{label}</button>)}</div></details><div className="review-progress"><strong>{reviewed} items reviewed</strong><span>{excluded ? `${excluded} excluded` : "Nothing excluded"}</span></div></nav><main className="review-main">{renderCenter()}</main>{previewOpen ? <aside className="review-preview"><div className="section-heading"><div><h2>Report preview</h2><span>{exportFormatLabel(props.exportFormat)}</span></div><button className="icon-button" type="button" onClick={() => setPreviewOpen(false)} aria-label="Close preview" title="Close preview"><X size={16} aria-hidden="true" /></button></div><DocumentPreview title={props.title} summary={props.summaryDraft || props.recap?.summary || ""} decisions={props.previewDecisions} actions={props.previewActions} risks={props.previewRisks} questions={props.previewQuestions} includeSummary={props.includeSummary} includeNotes={props.includeNotes} includeTranscript={props.includeTranscript} /></aside> : null}</div></section>;
}
