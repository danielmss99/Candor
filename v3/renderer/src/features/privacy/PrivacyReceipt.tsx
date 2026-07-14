import { formatBytes, type MeetingPrivacyReceipt, type NetworkCapabilities } from "../../core/contracts";

interface PrivacyReceiptProps {
  receipt: MeetingPrivacyReceipt | null;
  network: NetworkCapabilities;
  compact?: boolean;
}

function readableEngine(value: string | null): string {
  if (!value) return "Local processing";
  if (value.includes("whisper")) return "Local transcription";
  if (value.includes("heuristic")) return "Heuristic fallback";
  if (value.includes("llama") || value.includes("local-llm")) return "Local language model";
  return value;
}

function readableFallbackReason(value: string | null | undefined): string {
  if (value === "llm-unavailable") return "Local AI unavailable";
  if (value === "runtime-failed") return "Local AI runtime failed";
  if (value === "model-corrupt") return "Local AI model needs repair";
  if (value === "resource-policy") return "Device resource policy";
  if (value === "user-requested") return "User selected fallback";
  return "No fallback";
}

export function PrivacyReceipt({ receipt, network, compact = false }: PrivacyReceiptProps) {
  if (!receipt) {
    return (
      <section className="privacy-receipt privacy-receipt-empty" aria-label="Meeting privacy receipt">
        <span className="receipt-seal" aria-hidden="true" />
        <div><strong>Privacy receipt</strong><p>Select a meeting to inspect its locally reported custody facts.</p></div>
      </section>
    );
  }

  const localCapabilities = receipt.network.capabilities.length
    ? receipt.network.capabilities
    : network.capabilities;
  const latestProcessing = receipt.processing[receipt.processing.length - 1];

  return (
    <section className={`privacy-receipt${compact ? " compact" : ""}`} aria-label="Meeting privacy receipt">
      <header>
        <span className="receipt-seal verified" aria-hidden="true" />
        <div><strong>Private on this computer</strong><p>Facts reported by Candor's local service for this meeting</p></div>
        <span className="receipt-status">Verified locally</span>
      </header>
      <dl className="receipt-facts">
        <div><dt>Audio</dt><dd>{receipt.storage.allAudioEncrypted ? "Encrypted" : "No encrypted audio"}</dd></div>
        <div><dt>Capture</dt><dd>{receipt.capture.channels.length ? receipt.capture.channels.join(" + ") : "No audio channels"}</dd></div>
        <div><dt>Transcript</dt><dd>{receipt.content.transcriptSegmentCount} segments</dd></div>
        <div><dt>Network</dt><dd>{receipt.network.externalCallsAttempted === 0 ? "No external calls" : `${receipt.network.externalCallsAttempted} attempts`}</dd></div>
      </dl>
      {!compact ? (
        <details>
          <summary>Technical evidence</summary>
          <dl className="receipt-technical">
            <div><dt>Storage</dt><dd>{receipt.storage.rootKind}, {receipt.storage.cipher ?? "cipher not reported"}</dd></div>
            <div><dt>Encrypted chunks</dt><dd>{receipt.storage.encryptedAudioChunkCount}</dd></div>
            <div><dt>Attribution</dt><dd>{receipt.capture.channelAttribution ? "Channel based" : "Not available"}</dd></div>
            <div><dt>Retention</dt><dd>{receipt.retention.policy}</dd></div>
            <div><dt>Deletion</dt><dd>{receipt.recording.deletionStatus}</dd></div>
            <div><dt>Latest processing</dt><dd>{latestProcessing ? `${readableEngine(latestProcessing.engine)} on ${new Date(latestProcessing.createdAtMs).toLocaleString()}` : "None"}</dd></div>
          </dl>
          {receipt.processing.length ? (
            <div className="receipt-event-list" aria-label="Local processing history">
              {receipt.processing.map((event, index) => (
                <article key={`${event.eventType}-${event.createdAtMs}-${index}`}>
                  <strong>{readableEngine(event.engine)}</strong>
                  <span>{event.modelId ?? "Built-in local method"}</span>
                  {event.aiProvenance ? (
                    <small>
                      {event.aiProvenance.fallbackUsed
                        ? `Fallback disclosed: ${readableFallbackReason(event.aiProvenance.fallbackReason)}`
                        : "Packaged Local AI"}
                      {` | Prompt ${event.aiProvenance.promptVersion} | ${new Date(event.aiProvenance.generatedAt).toLocaleString()}`}
                    </small>
                  ) : null}
                  {event.sha256 ? <code title={event.sha256}>Integrity {event.sha256.slice(0, 12)}...</code> : null}
                  {event.bytes !== null ? <small>{formatBytes(event.bytes)}</small> : null}
                </article>
              ))}
            </div>
          ) : null}
          <div className="network-capability-list" aria-label="Network capability policy">
            {localCapabilities.map((capability) => (
              <div key={capability.id}><strong>{capability.label}</strong><span>{capability.mode === "denied" ? "Blocked" : capability.mode === "disabled" ? "Off" : "Local only"}</span></div>
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}
