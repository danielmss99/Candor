import { asNumber, type BundledAiStatus, type JsonObject } from "../../core/contracts";

interface LocalAiSetupStepProps {
  modelStatus: JsonObject;
  bundledAiStatus: BundledAiStatus;
  aiModeStatus: string;
  instructReady: boolean;
  busy: boolean;
  finishing: boolean;
  onBack: () => void;
  onImportSpeechModel: () => void;
  onFinish: () => void;
}

export function LocalAiSetupStep({ modelStatus, bundledAiStatus, aiModeStatus, instructReady, busy, finishing, onBack, onImportSpeechModel, onFinish }: LocalAiSetupStepProps) {
  const verifiedModelCount = asNumber(modelStatus.verifiedModelCount);
  const speechReady = bundledAiStatus.speech.ready || verifiedModelCount > 0;
  const repairRequired = bundledAiStatus.repairRequired;
  const checking = bundledAiStatus.state === "checking";
  const statusUnavailable = bundledAiStatus.state === "unavailable";
  const description = checking
    ? "Checking the included local AI tools on this device."
    : repairRequired
      ? "Local AI needs an app repair, but your existing meetings remain available."
      : bundledAiStatus.speech.ready
        ? "Local transcription is included and verified for offline use."
        : statusUnavailable
          ? "Included AI status is unavailable. Recording, notes, and existing meetings still work locally."
          : "Add a verified speech model now, or finish setup and use local notes and recording.";
  const transcriptionLabel = checking ? "Checking..." : speechReady ? "Ready on this device" : "Not set up";
  const summaryLabel = checking ? "Checking..." : instructReady ? "Ready" : repairRequired ? "Needs app repair" : "Local fallback available";
  return (
    <section className="setup-card" aria-labelledby="local-ai-setup-title" aria-busy={finishing}>
      <header><span>Step 6 of 6</span><h1 id="local-ai-setup-title" tabIndex={-1}>Set up local AI</h1><p>{description}</p></header>
      <dl className="setup-facts">
        <div><dt>Transcription</dt><dd>{transcriptionLabel}</dd></div>
        <div><dt>Recap mode</dt><dd>{aiModeStatus}</dd></div>
        <div><dt>Enhanced summaries</dt><dd>{summaryLabel}</dd></div>
      </dl>
      <div className="setup-actions">
        <button className="secondary-button" type="button" onClick={onBack} disabled={busy}>Back</button>
        {!speechReady && !repairRequired && !checking ? <button className="secondary-button" type="button" onClick={onImportSpeechModel} disabled={busy}>Choose speech model</button> : null}
        <button className="primary-button" type="button" onClick={onFinish} disabled={busy}>{finishing ? "Saving setup..." : "Finish setup"}</button>
      </div>
      {finishing ? <p className="setup-status" role="status" aria-live="polite">Saving setup locally. This can take a few seconds.</p> : null}
    </section>
  );
}
