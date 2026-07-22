import { formatBytes } from "../../core/contracts";
import type { LocalModelCatalogEntry, LocalModelCatalogState, ModelDownloadProgress } from "./model-library";

interface LocalModelLibraryProps {
  catalog: LocalModelCatalogState;
  progress: ModelDownloadProgress | null;
  activeCapture: boolean;
  busy: boolean;
  selectedModelId: string;
  onDownload: (modelId: string) => void;
  onCancel: (modelId: string) => void;
  onImportSpeechModel: (modelId: string) => void;
  onSelectSpeechModel: (modelId: string) => void;
  onOpenManualSetup: () => void;
}

function capabilityLabel(entry: LocalModelCatalogEntry): string {
  return entry.capability === "speech" ? "Speech to text" : "Transcript cleanup and summaries";
}

function stateLabel(entry: LocalModelCatalogEntry): string {
  if (entry.verified) return "Verified and ready";
  if (entry.installed) return "Integrity check required";
  if (entry.releaseState === "release-gated") return "Release checks required";
  if (entry.releaseState === "manual-only") return "Manual setup";
  return "Available to download";
}

function actionFor(entry: LocalModelCatalogEntry, props: LocalModelLibraryProps) {
  const downloading = props.progress?.modelId === entry.modelId
    && ["downloading", "verifying", "verification-queued"].includes(props.progress.state);
  const anyDownloadActive = Boolean(props.catalog.activeDownloadModelId)
    || Boolean(props.progress && ["downloading", "verifying", "verification-queued"].includes(props.progress.state));
  if (downloading) {
    return <button type="button" onClick={() => props.onCancel(entry.modelId)}>Cancel</button>;
  }
  if (entry.verified && entry.capability === "speech") {
    const selected = props.selectedModelId === entry.modelId;
    return (
      <>
        <span className="model-library-ready" role="status">Ready</span>
        <button
          type="button"
          aria-pressed={selected}
          disabled={props.busy}
          onClick={() => props.onSelectSpeechModel(entry.modelId)}
        >
          {selected ? "Current transcription default" : "Use for transcription"}
        </button>
      </>
    );
  }
  if (entry.verified) return <span className="model-library-ready" role="status">Ready</span>;
  if (entry.releaseState === "release-gated") {
    return <button type="button" disabled aria-describedby={`model-note-${entry.modelId}`}>Release checks required</button>;
  }
  if (entry.downloadAvailable) {
    return (
      <button
        type="button"
        disabled={props.activeCapture || props.busy || anyDownloadActive}
        onClick={() => props.onDownload(entry.modelId)}
      >
        Download
      </button>
    );
  }
  if (entry.capability === "speech") {
    return <button type="button" disabled={props.busy} onClick={() => props.onImportSpeechModel(entry.modelId)}>Import file</button>;
  }
  return <button type="button" disabled={props.busy} onClick={props.onOpenManualSetup}>Open manual setup</button>;
}

function modelCard(entry: LocalModelCatalogEntry, props: LocalModelLibraryProps) {
  const progress = props.progress?.modelId === entry.modelId ? props.progress : null;
  const percent = progress?.totalBytes ? Math.min(100, (progress.bytesReceived / progress.totalBytes) * 100) : 0;
  return (
    <article className="model-library-card" key={entry.modelId} aria-labelledby={`model-title-${entry.modelId}`}>
      <div className="model-library-card-heading">
        <div>
          <span className="model-library-capability">{capabilityLabel(entry)}</span>
          <h4 id={`model-title-${entry.modelId}`}>{entry.displayName}</h4>
          <p>{entry.releaseNote}</p>
        </div>
        <span className={`model-library-state ${entry.releaseState}`}>{stateLabel(entry)}</span>
      </div>
      <dl className="model-library-facts">
        <div><dt>Runtime</dt><dd>{entry.engine}</dd></div>
        <div><dt>Publisher</dt><dd>{entry.publisher}</dd></div>
        <div><dt>Languages</dt><dd>{entry.languages.join(", ") || "Not stated"}</dd></div>
        <div><dt>Size</dt><dd>{entry.bytes === null ? "Pending release proof" : formatBytes(entry.bytes)}</dd></div>
        <div><dt>License</dt><dd>{entry.licenseExpression}</dd></div>
        <div><dt>Device</dt><dd>{entry.hardware}</dd></div>
      </dl>
      <p className="model-library-source" id={`model-note-${entry.modelId}`}>
        Source: {entry.distributionSource}, pinned revision {entry.revision.slice(0, 12)}
      </p>
      {entry.defaultEligible ? (
        <p className="model-library-source">
          {props.catalog.recommendedDefaultModelId === entry.modelId
            ? "Verified recommended default for transcription and new custom meeting profiles."
            : "Eligible as a default after local verification."}
        </p>
      ) : null}
      {entry.modelId === "parakeet-tdt-0.6b-v3-int8" ? (
        <p className="model-library-source">
          NVIDIA Parakeet TDT 0.6B V3 by NVIDIA, converted for sherpa-onnx and provided under CC BY 4.0. Runtime notices are included with Candor.
        </p>
      ) : null}
      {progress && progress.totalBytes > 0 ? (
        <div className="model-download-progress" role="status" aria-live="polite">
          <progress max={progress.totalBytes} value={progress.bytesReceived} aria-label={`${entry.displayName} download progress`} />
          <span>{progress.state === "downloading" ? `${Math.round(percent)}% downloaded` : progress.state.replace("-", " ")}</span>
        </div>
      ) : null}
      <div className="model-library-actions">{actionFor(entry, props)}</div>
    </article>
  );
}

export function LocalModelLibrary(props: LocalModelLibraryProps) {
  const speech = props.catalog.models.filter((entry) => entry.capability === "speech");
  const text = props.catalog.models.filter((entry) => entry.capability === "text-processing");
  return (
    <section className="settings-group local-model-library" aria-labelledby="local-model-library-heading">
      <div className="settings-group-heading">
        <div>
          <h3 id="local-model-library-heading">Downloadable local models</h3>
          <p>Choose a model explicitly. Candor downloads only from its packaged catalog and verifies the exact size and SHA-256 before installation.</p>
        </div>
        <span className="settings-status-label">Local processing only</span>
      </div>
      {props.activeCapture ? <p className="model-library-capture-note" role="status">Downloads are unavailable while a recording is active.</p> : null}
      {!props.catalog.loaded ? <p role="status">Loading the packaged model catalog...</p> : null}
      <div className="model-library-section">
        <h4>Transcription models</h4>
        <div className="model-library-grid">{speech.map((entry) => modelCard(entry, props))}</div>
      </div>
      <div className="model-library-section">
        <h4>Cleanup and summary models</h4>
        <p>These run after speech recognition to make the transcript easier to read and then create a grounded meeting summary.</p>
        <div className="model-library-grid">{text.map((entry) => modelCard(entry, props))}</div>
      </div>
    </section>
  );
}
