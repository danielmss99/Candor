import type { RecapItem } from "../../core/contracts";

interface DocumentPreviewProps {
  title: string;
  summary: string;
  decisions: RecapItem[];
  actions: RecapItem[];
  risks: RecapItem[];
  questions: RecapItem[];
  includeSummary: boolean;
  includeNotes: boolean;
  includeTranscript: boolean;
}

export function DocumentPreview({
  title,
  summary,
  decisions,
  actions,
  risks,
  questions,
  includeSummary,
  includeNotes,
  includeTranscript,
}: DocumentPreviewProps) {
  return (
    <article className="document-preview" aria-label="Local report preview">
      <p className="document-kicker">{title.toUpperCase()}</p>
      <h3>Meeting Summary</h3>
      <p className="document-date">Local meeting report</p>
      {includeSummary ? <><h4>Executive Summary</h4><p>{summary || "Generate a local recap to populate this report."}</p></> : null}
      {decisions.length ? <><h4>Decisions</h4>{decisions.slice(0, 3).map((item) => <p key={`${item.segmentIndex}-${item.text}`}>- {item.text}</p>)}</> : null}
      {actions.length ? <><h4>Action Items</h4>{actions.slice(0, 3).map((item) => <p key={`${item.segmentIndex}-${item.text}`}>- {item.text}</p>)}</> : null}
      {risks.length ? <><h4>Risks</h4>{risks.slice(0, 2).map((item) => <p key={`${item.segmentIndex}-${item.text}`}>- {item.text}</p>)}</> : null}
      {questions.length ? <><h4>Open Questions</h4>{questions.slice(0, 2).map((item) => <p key={`${item.segmentIndex}-${item.text}`}>- {item.text}</p>)}</> : null}
      {includeNotes ? <p className="document-included">Manual notes included</p> : null}
      {includeTranscript ? <p className="document-included">Transcript appendix included</p> : null}
      <span className="document-page-number">Page 1</span>
    </article>
  );
}
