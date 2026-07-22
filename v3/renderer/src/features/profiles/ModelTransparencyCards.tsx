import type { TransparentModel } from "./types";

interface ModelTransparencyCardsProps {
  models: TransparentModel[];
  loading?: boolean;
}

function sizeLabel(bytes: number | null): string {
  if (bytes === null) return "Unavailable";
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
}

function verificationLabel(model: TransparentModel): string {
  if (model.verification === "verified") return "Verified locally";
  if (model.verification === "unverified") return "Not verified";
  return "Verification unavailable";
}

export function ModelTransparencyCards({ models, loading = false }: ModelTransparencyCardsProps) {
  return (
    <section className="profile-surface" aria-labelledby="model-transparency-heading" aria-busy={loading}>
      <div className="profile-section-heading"><div><h3 id="model-transparency-heading">Local model transparency</h3><p>See what Candor can verify and what the runtime has not measured yet.</p></div></div>
      {loading ? <p className="profile-empty" role="status">Checking local speech models...</p> : models.length === 0 ? <p className="profile-empty">No local speech model information is available.</p> : (
        <div className="model-card-grid">
          {models.map((model) => (
            <article className="model-card" key={model.modelId} data-verification={model.verification}>
              <header><div><strong>{model.modelId}</strong><span>{model.language ?? "Language support unavailable"}</span></div><em>{verificationLabel(model)}</em></header>
              <dl>
                <div><dt>Installed size</dt><dd>{sizeLabel(model.bytes)}</dd></div>
                <div><dt>Hardware</dt><dd>{model.hardware ?? "Requirement unavailable"}</dd></div>
                <div><dt>Warm state</dt><dd>{model.warm === true ? "Loaded in the runtime" : model.warm === false ? "Cold, loaded on demand" : "Signal unavailable"}</dd></div>
                <div><dt>Measured latency</dt><dd>{model.measuredLatencyMs === null ? "Not measured" : `30 s local inference: ${Math.round(model.measuredLatencyMs).toLocaleString()} ms`}</dd></div>
                <div><dt>Availability</dt><dd>{model.availability === "installed" ? "Installed locally" : model.availability === "not-installed" ? "Not installed" : "Unavailable"}</dd></div>
              </dl>
              {model.failureCode ? <p className="model-note">Status: {model.failureCode}</p> : null}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
