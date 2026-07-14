import { useState, type DragEvent } from "react";
import type {
  TerminologyCorrectionProposal,
  TerminologyStatus,
} from "../../core/contracts";

interface TerminologySettingsProps {
  status: TerminologyStatus;
  proposals: TerminologyCorrectionProposal[];
  selectedRecordingId: string;
  busy: boolean;
  onImport: () => void;
  onImportFile: (file: File) => void;
  onSetEnabled: (dictionaryId: string, enabled: boolean) => void;
  onAssignToMeeting: (dictionaryId: string, enabled: boolean) => void;
  onReview: () => void;
  onDecide: (proposalId: string, decision: "accepted" | "rejected") => void;
}

export function TerminologySettings(props: TerminologySettingsProps) {
  const [dragging, setDragging] = useState(false);

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files.item(0);
    if (file) props.onImportFile(file);
  };

  return (
    <section
      className="settings-group terminology-settings"
      aria-labelledby="terminology-heading"
      data-dragging={dragging || undefined}
      onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={handleDrop}
    >
      <div className="settings-group-heading">
        <div>
          <h3 id="terminology-heading">Domain dictionaries</h3>
          <p>{props.status.entryCount.toLocaleString()} preferred terms stored locally</p>
        </div>
        <button type="button" onClick={props.onImport} disabled={props.busy}>
          Import dictionary
        </button>
      </div>
      <div className="dictionary-drop-zone" aria-label="Drop a signed Candor dictionary package">
        <strong>Signed dictionary packages</strong>
        <span>Drop a .candordict file here</span>
      </div>
      {props.status.state === "corrupt" ? (
        <div className="inline-alert" role="alert">
          The encrypted dictionary store needs repair. Existing meetings were not changed.
        </div>
      ) : props.status.dictionaries.length === 0 ? (
        <div className="settings-empty-state">
          <strong>No dictionaries yet</strong>
          <span>Import a signed .candordict package or a plain TXT, CSV, or JSON terminology file.</span>
        </div>
      ) : (
        <div className="terminology-list">
          {props.status.dictionaries.map((dictionary) => (
            <article key={dictionary.dictionaryId}>
              <div>
                <strong>{dictionary.name}</strong>
                <small>{dictionary.entryCount.toLocaleString()} terms · {dictionaryTrustLabel(dictionary.trustLabel)}</small>
              </div>
              <label>
                <input
                  type="checkbox"
                  checked={dictionary.enabled}
                  disabled={props.busy}
                  onChange={(event) => props.onSetEnabled(dictionary.dictionaryId, event.target.checked)}
                />
                All meetings
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={dictionary.assignedToRecording}
                  disabled={props.busy || !props.selectedRecordingId}
                  onChange={(event) => props.onAssignToMeeting(dictionary.dictionaryId, event.target.checked)}
                />
                This meeting
              </label>
            </article>
          ))}
        </div>
      )}
      <div className="settings-row-title terminology-review-row">
        <div>
          <strong>Correction review</strong>
          <span>Drug names, dosages, and every other suggestion require approval.</span>
        </div>
        <button
          type="button"
          onClick={props.onReview}
          disabled={props.busy || !props.selectedRecordingId || props.status.dictionaryCount === 0}
        >
          Review suggestions
        </button>
      </div>
      {props.proposals.length ? (
        <div className="terminology-proposal-list" aria-live="polite">
          {props.proposals.map((proposal) => (
            <article key={proposal.proposalId}>
              <div>
                <span className={proposal.risk === "high" ? "risk-label high" : "risk-label"}>
                  {proposal.risk === "high" ? "High-risk term" : "Suggested term"}
                </span>
                <strong><del>{proposal.original}</del> <span aria-hidden="true">to</span> {proposal.proposed}</strong>
                <small>{proposal.confidence === "high" ? "High confidence" : "Review carefully"}</small>
              </div>
              <div className="settings-actions">
                <button type="button" onClick={() => props.onDecide(proposal.proposalId, "rejected")} disabled={props.busy}>Reject</button>
                <button type="button" className="primary-button" onClick={() => props.onDecide(proposal.proposalId, "accepted")} disabled={props.busy}>Accept</button>
              </div>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function dictionaryTrustLabel(trustLabel: string | null): string {
  if (trustLabel === "verified-candor-bundle") return "Verified by Candor";
  if (trustLabel === "verified-organization") return "Verified organization pack";
  if (trustLabel === "community-unverified") return "Community pack - unverified";
  return "Local dictionary";
}
