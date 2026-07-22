import type { ReplacementPreview } from "./types";

interface ReplacementPreviewResultProps {
  preview: ReplacementPreview;
  protectedApproved: boolean;
  busy: boolean;
  onProtectedApprovedChange(approved: boolean): void;
  onApply(): void;
}

export function ReplacementPreviewResult({ preview, protectedApproved, busy, onProtectedApprovedChange, onApply }: ReplacementPreviewResultProps) {
  return (
    <div className="replacement-result" aria-live="polite">
      <div><strong>{preview.replacementCount.toLocaleString()} replacement{preview.replacementCount === 1 ? "" : "s"}</strong><span>{preview.changed ? "Review the normalized text before applying." : "No rule matched this text."}</span></div>
      <label><span>Preview result</span><textarea rows={5} readOnly value={preview.previewText} /></label>
      {preview.protectedTermReviewRequired ? <label className="protected-review"><input type="checkbox" checked={protectedApproved} onChange={(event) => onProtectedApprovedChange(event.target.checked)} /><span><strong>Approve protected-term changes</strong><small>Review sensitive names, dosages, identifiers, and other protected terms before applying.</small></span></label> : null}
      {preview.changes.length ? <ul aria-label="Replacement change details">{preview.changes.map((change) => <li key={`${change.ruleId}-${change.ruleOrder}`}>{change.ruleId}: {change.replacementCount} change{change.replacementCount === 1 ? "" : "s"}{change.protectedTermReview ? ", protected review" : ""}</li>)}</ul> : null}
      <button type="button" className="primary-button" onClick={onApply} disabled={busy || preview.applied || (preview.protectedTermReviewRequired && !protectedApproved)}>{preview.applied ? "Applied" : "Approve and apply"}</button>
    </div>
  );
}
