import { useTrustHistory } from "./useTrustHistory";
import type { ProcessingReceipt, TranscriptComparison, TranscriptComparisonView, TranscriptRevision, TrustHistoryController } from "./types";

function formatTime(milliseconds: number): string {
  if (!milliseconds) return "Not reported";
  const value = new Date(milliseconds);
  return Number.isNaN(value.getTime()) ? "Not reported" : value.toLocaleString();
}

function formatDuration(milliseconds: number): string {
  if (!milliseconds) return "Not reported";
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  return `${(milliseconds / 1_000).toFixed(2)} s`;
}

function formatOffset(milliseconds: number | null): string {
  if (milliseconds === null) return "Time unavailable";
  const totalSeconds = Math.floor(milliseconds / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function sourceLabel(source: TranscriptRevision["source"]): string {
  if (source === "initial") return "Initial transcription";
  if (source === "reprocess") return "Reprocessed";
  if (source === "import") return "Imported media";
  if (source === "review") return "Protected-term review";
  if (source === "ai-cleanup") return "Local AI cleanup";
  return "Source not reported";
}

function kindLabel(kind: TranscriptRevision["kind"]): string {
  if (kind === "raw-asr") return "Original speech recognition";
  if (kind === "normalized") return "Deterministic cleanup";
  if (kind === "ai-cleaned") return "AI-cleaned transcript";
  if (kind === "legacy") return "Legacy transcript";
  return "Transcript type unavailable";
}

function shortHash(value: string | null): string {
  return value ? `${value.slice(0, 12)}…` : "Not reported";
}

function ComparisonMetadata({ value }: { value: TranscriptComparison | null }) {
  if (!value) return <p className="history-muted">Comparison metadata was not recorded for this attempt.</p>;
  return (
    <div className="history-comparison">
      <p>
        {value.changed
          ? "Normalization changed the transcript representation."
          : "Raw and normalized transcript representations matched."}
      </p>
      <div className="history-comparison-grid" role="group" aria-label="Raw versus normalized transcript metadata">
        <div>
          <strong>Raw output</strong>
          <span>{value.rawTextBytes.toLocaleString()} bytes</span>
          <span>{value.rawSegmentCount.toLocaleString()} segments</span>
          <code title={value.rawTextSha256}>{shortHash(value.rawTextSha256)}</code>
        </div>
        <div>
          <strong>Normalized output</strong>
          <span>{value.normalizedTextBytes.toLocaleString()} bytes</span>
          <span>{value.normalizedSegmentCount.toLocaleString()} segments</span>
          <code title={value.normalizedTextSha256}>{shortHash(value.normalizedTextSha256)}</code>
        </div>
      </div>
      <small>These integrity hashes and counts describe the complete revision. A bounded encrypted text comparison is shown in revision detail when available.</small>
    </div>
  );
}

function ComparisonContent({ value }: { value: TranscriptComparisonView }) {
  if (!value.available) {
    return (
      <p className="history-muted" role="note">
        Raw pre-normalization text was not captured for this legacy revision.
      </p>
    );
  }
  return (
    <section className="history-comparison-content" aria-labelledby="history-comparison-content-heading">
      <div className="history-subheading">
        <h5 id="history-comparison-content-heading">Raw versus normalized text</h5>
        <span>Encrypted locally</span>
      </div>
      <div className="history-comparison-text-grid">
        <div>
          <strong>Raw speech-model output</strong>
          <pre>{value.rawText}</pre>
        </div>
        <div>
          <strong>Normalized transcript</strong>
          <pre>{value.normalizedText}</pre>
        </div>
      </div>
      {value.rawTextTruncated || value.normalizedTextTruncated ? (
        <p className="history-muted" role="note">
          This comparison is a bounded preview. Integrity hashes and byte counts describe the complete revision.
        </p>
      ) : null}
    </section>
  );
}

function ReceiptCard({ receipt }: { receipt: ProcessingReceipt }) {
  return (
    <article className="history-receipt">
      <header>
        <div>
          <strong>{receipt.operation}</strong>
          <span>Attempt {receipt.attempt || "not reported"}</span>
        </div>
        <span className="history-status" data-outcome={receipt.outcome}>{receipt.outcome}</span>
      </header>
      <dl>
        <div><dt>Engine</dt><dd>{receipt.engine}</dd></div>
        <div><dt>Stage</dt><dd>{receipt.stage}</dd></div>
        <div><dt>Model</dt><dd>{receipt.modelId ?? "Not reported"}</dd></div>
        <div><dt>Model integrity</dt><dd><code title={receipt.modelSha256 ?? undefined}>{shortHash(receipt.modelSha256)}</code></dd></div>
        <div><dt>Started</dt><dd>{formatTime(receipt.startedAtMs)}</dd></div>
        <div><dt>Finished</dt><dd>{formatTime(receipt.finishedAtMs)}</dd></div>
        <div><dt>Elapsed</dt><dd>{formatDuration(receipt.elapsedMs)}</dd></div>
        <div><dt>Revision</dt><dd>{receipt.revisionId ?? "None created"}</dd></div>
        <div><dt>Input revision</dt><dd>{receipt.inputRevisionId ?? "Direct source"}</dd></div>
        <div><dt>Input type</dt><dd>{receipt.inputRevisionKind ?? "Not applicable"}</dd></div>
        <div><dt>Validation</dt><dd>{receipt.validationResult}</dd></div>
        <div><dt>Fallback</dt><dd>{receipt.fallbackApplied ? "Used" : "No"}</dd></div>
      </dl>
      {receipt.errorCode || receipt.errorSummary ? (
        <div className="history-receipt-error" role="note">
          <strong>{receipt.errorCode ?? "Processing error"}</strong>
          <span>{receipt.errorSummary ?? "No error explanation was recorded."}</span>
        </div>
      ) : null}
      <ComparisonMetadata value={receipt.comparison} />
    </article>
  );
}

export function TrustHistoryView({ controller }: { controller: TrustHistoryController }) {
  const { history, protectedTermReview, viewedRevision } = controller;
  if (controller.loading && !history) {
    return <section className="history-surface" aria-busy="true"><p role="status">Loading transcript history…</p></section>;
  }

  if (!history) {
    return (
      <section className="history-surface history-empty">
        <h3>Transcript history unavailable</h3>
        <p>{controller.error || "Candor has no transcript history to show for this meeting."}</p>
        <button type="button" onClick={() => void controller.refreshHistory()}>Try again</button>
      </section>
    );
  }

  return (
    <section className="history-workspace" aria-labelledby="trust-history-heading">
      <header className="history-heading">
        <div>
          <h3 id="trust-history-heading">Trust History</h3>
          <p>Review immutable transcript revisions and the local processing evidence behind them.</p>
        </div>
        <button
          type="button"
          onClick={() => void controller.reprocess()}
          disabled={controller.busy || !history.originalAudioRetained}
        >
          Reprocess original audio
        </button>
      </header>

      <p className="history-assurance">
        Reprocessing uses the original retained audio and creates a new revision. It never overwrites an existing transcript.
      </p>
      {!history.originalAudioRetained ? (
        <p className="history-warning" role="note">Original audio is not retained, so this meeting cannot be reprocessed.</p>
      ) : null}
      {protectedTermReview?.reviewRequired ? (
        <section className="history-protected-review" aria-labelledby="protected-term-review-heading">
          <div className="history-subheading">
            <div>
              <h4 id="protected-term-review-heading">Protected-term review</h4>
              <p>
                Review {protectedTermReview.replacementCount.toLocaleString()} proposed replacement{protectedTermReview.replacementCount === 1 ? "" : "s"} before Candor changes the current transcript.
              </p>
            </div>
            <span>{protectedTermReview.ruleSetId} v{protectedTermReview.ruleSetVersion}</span>
          </div>
          <ol className="history-protected-preview">
            {protectedTermReview.previewSegments.map((segment, index) => (
              <li key={`${segment.channel}-${segment.startMs}-${index}`}>
                <span>{formatOffset(segment.startMs)} · {segment.speaker ?? segment.channel}</span>
                <div>
                  <strong>Current</strong>
                  <p>{segment.before || "Removed text"}</p>
                </div>
                <div>
                  <strong>After approval</strong>
                  <p>{segment.after || "Remove this segment"}</p>
                </div>
              </li>
            ))}
          </ol>
          {protectedTermReview.previewTruncated ? (
            <p className="history-muted" role="note">
              Showing the first {protectedTermReview.previewSegments.length} of {protectedTermReview.changedSegmentCount.toLocaleString()} changed segments.
            </p>
          ) : null}
          <div className="history-actions">
            <button
              type="button"
              onClick={() => void controller.applyProtectedTermReview()}
              disabled={controller.busy}
            >
              Apply in a new revision
            </button>
            <span>The current revision is retained and can be restored.</span>
          </div>
        </section>
      ) : protectedTermReview ? (
        <p className="history-assurance" role="status">No protected-term replacements are waiting for review.</p>
      ) : null}
      <div className="history-live-region" aria-live="polite" aria-atomic="true">
        {controller.notice ? <p className="history-notice">{controller.notice}</p> : null}
        {controller.reprocessJob ? <p>Job {controller.reprocessJob.jobId} is {controller.reprocessJob.state}.</p> : null}
        {controller.error ? <p className="history-error" role="alert">{controller.error}</p> : null}
      </div>

      <div className="history-layout">
        <section className="history-revisions" aria-labelledby="revision-list-heading">
          <div className="history-subheading">
            <h4 id="revision-list-heading">Transcript revisions</h4>
            <span>{history.revisions.length}</span>
          </div>
          {history.revisions.length === 0 ? (
            <p className="history-muted">No transcript revision has been created yet.</p>
          ) : (
            <ol>
              {[...history.revisions].reverse().map((revision) => {
                const current = history.currentRevisionId === revision.revisionId;
                const currentCleaned = history.currentCleanedRevisionId === revision.revisionId;
                const viewed = viewedRevision?.revision.revisionId === revision.revisionId;
                return (
                  <li key={revision.revisionId} data-current={current}>
                    <div>
                      <strong>Version {revision.version || "unknown"}</strong>
                      {current ? <span className="history-current">Current transcript</span> : null}
                      {currentCleaned ? <span className="history-current">Current cleaned text</span> : null}
                      <span>{sourceLabel(revision.source)}</span>
                      <span>{kindLabel(revision.kind)}</span>
                      <span>{formatTime(revision.createdAtMs)}</span>
                      <span>{revision.modelId ?? revision.engine}</span>
                    </div>
                    <div className="history-actions">
                      <button
                        type="button"
                        aria-pressed={viewed}
                        onClick={() => void controller.viewRevision(revision.revisionId)}
                        disabled={controller.revisionLoading && viewed}
                      >
                        {viewed ? "Viewing transcript" : "View transcript"}
                      </button>
                      <button
                        type="button"
                        onClick={() => void controller.selectRevision(revision.revisionId)}
                        disabled={revision.kind === "ai-cleaned" || current || controller.busy}
                      >
                        {revision.kind === "ai-cleaned" ? "Kept separate from evidence" : current ? "Selected as current" : "Use as current transcript"}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        <section className="history-transcript" aria-labelledby="viewed-revision-heading" aria-busy={controller.revisionLoading}>
          <h4 id="viewed-revision-heading">Revision transcript</h4>
          {controller.revisionLoading && !viewedRevision ? <p role="status">Loading revision transcript…</p> : null}
          {viewedRevision ? (
            <>
              <div className="history-revision-summary">
                <strong>Version {viewedRevision.revision.version}</strong>
                <span>{viewedRevision.current ? "Current transcript" : "Historical transcript"}</span>
                {viewedRevision.currentCleaned ? <span>Current cleaned text</span> : null}
                <span>{kindLabel(viewedRevision.revision.kind)}</span>
                <span>{viewedRevision.segmentCount.toLocaleString()} segments</span>
              </div>
              <ComparisonMetadata value={viewedRevision.revision.comparison} />
              <ComparisonContent value={viewedRevision.comparisonView} />
              {viewedRevision.hasMore ? (
                <p className="history-muted" role="note">
                  Showing {viewedRevision.returnedSegmentCount.toLocaleString()} of {viewedRevision.segmentCount.toLocaleString()} segments in this bounded revision view.
                </p>
              ) : null}
              {viewedRevision.segments.length === 0 ? (
                <p className="history-muted">This revision has no readable transcript segments.</p>
              ) : (
                <ol className="history-segments">
                  {viewedRevision.segments.map((segment, index) => (
                    <li key={`${segment.startMs ?? "unknown"}-${index}`}>
                      <span>{formatOffset(segment.startMs)}</span>
                      <div>
                        {segment.speaker ? <strong>{segment.speaker}</strong> : null}
                        <p>{segment.text}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </>
          ) : controller.revisionLoading ? null : (
            <p className="history-muted">Choose a revision to view its transcript.</p>
          )}
        </section>
      </div>

      <section className="history-receipts" aria-labelledby="processing-receipts-heading">
        <div className="history-subheading">
          <h4 id="processing-receipts-heading">Processing receipts</h4>
          <span>{history.processingReceipts.length}</span>
        </div>
        {history.processingReceipts.length === 0 ? (
          <p className="history-muted">No processing receipt was recorded for this meeting.</p>
        ) : (
          <div className="history-receipt-grid">
            {[...history.processingReceipts].reverse().map((receipt) => <ReceiptCard key={receipt.receiptId} receipt={receipt} />)}
          </div>
        )}
      </section>
    </section>
  );
}

export function TrustHistoryPanel({ recordingId, onTranscriptRevisionChanged }: { recordingId: string; onTranscriptRevisionChanged?: () => void | Promise<void> }) {
  return <TrustHistoryView controller={useTrustHistory(recordingId, onTranscriptRevisionChanged)} />;
}
