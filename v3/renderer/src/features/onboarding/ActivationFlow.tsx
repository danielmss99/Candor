import { asBool, asNumber, asObject, metric, type JsonObject, type OnboardingStep } from "../../core/contracts";

interface ActivationGateProps {
  licenseKey: string;
  licenseEmail: string;
  licenseKeyInvalid: boolean;
  licenseBusy: boolean;
  licenseStatus: JsonObject;
  onLicenseKeyChange: (value: string) => void;
  onLicenseEmailChange: (value: string) => void;
  onLicenseKeyBlur: () => void;
  onActivate: () => void;
  onStartTrial: () => void;
  onContinueLocal: () => void;
}

export function ActivationGate({ licenseKey, licenseEmail, licenseKeyInvalid, licenseBusy, licenseStatus, onLicenseKeyChange, onLicenseEmailChange, onLicenseKeyBlur, onActivate, onStartTrial, onContinueLocal }: ActivationGateProps) {
  return (
    <main className="activation-shell" data-view="activation" aria-label="Candor activation onboarding">
      <section className="activation-hero">
        <p className="activation-kicker">Candor Professional</p><h1>Welcome to Candor</h1><p>Private meeting intelligence that runs on your computer. No subscription, no meeting bot, no cloud account for normal use.</p>
        <div className="activation-proof-grid" aria-label="Ownership promises"><article><strong>Buy it once</strong><span>Activate this device with a local license record.</span></article><article><strong>Start locally</strong><span>Use a trial without creating an account.</span></article><article><strong>Stay private</strong><span>Recording, notes, AI, and exports remain local by default.</span></article></div>
      </section>
      <section className="activation-card" aria-label="Activate Candor">
        <form onSubmit={(event) => { event.preventDefault(); onActivate(); }}>
          <header><h2>Activate License</h2><p>Enter your purchase key, or start a local trial while production licensing is connected.</p></header>
          <label className="activation-field" htmlFor="candor-license-key"><span>License key <em>required for activation</em></span><input id="candor-license-key" value={licenseKey} onBlur={onLicenseKeyBlur} onChange={(event) => onLicenseKeyChange(event.target.value)} aria-invalid={licenseKeyInvalid} aria-describedby="candor-license-key-help" autoCapitalize="characters" autoCorrect="off" spellCheck={false} placeholder="CANDOR-DEV-LOCAL" /><small id="candor-license-key-help" role={licenseKeyInvalid ? "alert" : undefined}>{licenseKeyInvalid ? "Enter a license key or choose Start Trial." : "Development accepts CANDOR-DEV keys until production verification is connected."}</small></label>
          <label className="activation-field" htmlFor="candor-license-email"><span>Purchase email <em>optional</em></span><input id="candor-license-email" type="email" value={licenseEmail} onChange={(event) => onLicenseEmailChange(event.target.value)} autoComplete="email" placeholder="you@example.com" /><small>Stored as a local hash only when provided.</small></label>
          <div className="activation-actions"><button className="primary-button" type="submit" disabled={licenseBusy}>{licenseBusy ? "Activating..." : "Activate License"}</button><button className="secondary-button" type="button" onClick={onStartTrial} disabled={licenseBusy}>Start Trial</button><button className="text-button" type="button" onClick={onContinueLocal} disabled={licenseBusy}>Open local workspace</button></div>
          <p className="activation-data-access">Existing local meetings always remain available to open, export, and delete.</p>
        </form>
        <dl className="activation-facts"><div><dt>Account required</dt><dd>No</dd></div><div><dt>Storage</dt><dd>{asBool(licenseStatus.secureStorageAvailable) ? "OS protected" : "Local metadata"}</dd></div><div><dt>Network</dt><dd>Disabled by default</dd></div></dl>
      </section>
    </main>
  );
}

interface OnboardingSetupProps {
  step: OnboardingStep;
  licenseState: string;
  licenseStatus: JsonObject;
  captureStatus: JsonObject;
  consentStatus: JsonObject;
  vaultStatus: JsonObject;
  modelStatus: JsonObject;
  aiModeStatus: string;
  instructAssetsReady: boolean;
  busy: string;
  onStepChange: (step: OnboardingStep) => void;
  onCompleteMic: () => void;
  onCompleteSystemAudio: () => void;
  onCompleteStorage: () => void;
  onImportSpeechModel: () => void;
  onFinish: () => void;
}

function OnboardingProgress({ step }: { step: OnboardingStep }) {
  const steps: Array<[OnboardingStep, string]> = [["yours", "License"], ["microphone", "Microphone"], ["system-audio", "System audio"], ["storage", "Storage"], ["local-ai", "Local AI"]];
  const activeIndex = Math.max(0, steps.findIndex(([id]) => id === step));
  return <ol className="onboarding-progress" aria-label="Setup progress">{steps.map(([id, label], index) => <li key={id} data-active={id === step} data-complete={index < activeIndex}><span>{index + 1}</span><strong>{label}</strong></li>)}</ol>;
}

function SetupStep({ step, licenseState, licenseStatus, captureStatus, consentStatus, vaultStatus, modelStatus, aiModeStatus, instructAssetsReady, busy, onStepChange, onCompleteMic, onCompleteSystemAudio, onCompleteStorage, onImportSpeechModel, onFinish }: OnboardingSetupProps) {
  const systemImplemented = asBool(asObject(asObject(captureStatus.sources).system).implemented);
  const verifiedModelCount = asNumber(modelStatus.verifiedModelCount);
  const trialDays = asNumber(licenseStatus.trialDaysRemaining, -1);
  const licenseLabel = licenseState === "trial" && trialDays >= 0 ? `${trialDays} trial days remaining` : licenseState === "activated" ? "Activated on this device" : "Local trial";
  if (step === "microphone") return <section className="setup-card"><header><span>Step 2</span><h1>Microphone Permission</h1><p>Candor needs explicit local consent before recording microphone audio.</p></header><div className="setup-status-row"><span className={asBool(consentStatus.readyForMicRecording) ? "status-dot ok" : "status-dot"} /><strong>{asBool(consentStatus.readyForMicRecording) ? "Microphone consent saved" : "Microphone consent required"}</strong></div><div className="setup-actions"><button className="secondary-button" type="button" onClick={() => onStepChange("yours")}>Back</button><button className="primary-button" type="button" onClick={onCompleteMic} disabled={busy === "consent"}>{asBool(consentStatus.readyForMicRecording) ? "Continue" : "Acknowledge Microphone"}</button></div></section>;
  if (step === "system-audio") return <section className="setup-card"><header><span>Step 3</span><h1>System Audio</h1><p>Enable meeting audio capture from this computer when the OS capture path is available.</p></header><div className="setup-status-row"><span className={systemImplemented && asBool(consentStatus.readyForSystemAudioRecording) ? "status-dot ok" : "status-dot"} /><strong>{!systemImplemented ? "System audio capture unavailable on this OS build" : asBool(consentStatus.readyForSystemAudioRecording) ? "System audio consent saved" : "System audio consent required"}</strong></div><div className="setup-actions"><button className="secondary-button" type="button" onClick={() => onStepChange("microphone")}>Back</button><button className="primary-button" type="button" onClick={onCompleteSystemAudio} disabled={busy === "consent"}>{!systemImplemented || asBool(consentStatus.readyForSystemAudioRecording) ? "Continue" : "Acknowledge System Audio"}</button></div></section>;
  if (step === "storage") return <section className="setup-card"><header><span>Step 4</span><h1>Local Storage</h1><p>Candor uses protected local storage for recordings, notes, transcripts, and report data.</p></header><dl className="setup-facts"><div><dt>Encryption</dt><dd>{metric(vaultStatus.backend, "SQLCipher")}</dd></div><div><dt>OS key storage</dt><dd>{metric(vaultStatus.osKeyStorage, "Checking")}</dd></div><div><dt>Raw paths exposed</dt><dd>{asBool(vaultStatus.rawPathExposed) ? "Yes" : "No"}</dd></div></dl><div className="setup-actions"><button className="secondary-button" type="button" onClick={() => onStepChange("system-audio")}>Back</button><button className="primary-button" type="button" onClick={onCompleteStorage} disabled={busy === "storage"}>Use Local Storage</button></div></section>;
  if (step === "local-ai") return <section className="setup-card"><header><span>Step 5</span><h1>Local AI Setup</h1><p>Choose a verified speech model now, or use fast local analysis and finish setup.</p></header><dl className="setup-facts"><div><dt>Speech models</dt><dd>{verifiedModelCount} verified</dd></div><div><dt>Recap mode</dt><dd>{aiModeStatus}</dd></div><div><dt>Enhanced summaries</dt><dd>{instructAssetsReady ? "Ready" : "Optional"}</dd></div></dl><div className="setup-actions"><button className="secondary-button" type="button" onClick={onImportSpeechModel} disabled={Boolean(busy)}>Choose Speech Model</button><button className="primary-button" type="button" onClick={onFinish}>Finish Setup</button></div></section>;
  return <section className="setup-card"><header><span>Step 1</span><h1>Candor is yours</h1><p>{licenseLabel}. Normal app use does not require a persistent account or sign-in.</p></header><dl className="setup-facts"><div><dt>Plan</dt><dd>{metric(licenseStatus.planName, "Candor Professional")}</dd></div><div><dt>License</dt><dd>{metric(licenseStatus.licenseId, "Local trial")}</dd></div><div><dt>Verification</dt><dd>{metric(licenseStatus.productionVerification, "pending")}</dd></div></dl><div className="setup-actions"><button className="secondary-button" type="button" onClick={onFinish}>Open App</button><button className="primary-button" type="button" onClick={() => onStepChange("microphone")}>Continue Setup</button></div></section>;
}

export function OnboardingSetup(props: OnboardingSetupProps) {
  return <main className="activation-shell setup-shell" data-view="onboarding" aria-label="Candor first run setup"><aside className="setup-side"><button className="wordmark setup-wordmark" type="button" onClick={() => props.onStepChange("yours")}><img src="./candor-mark.png" width="28" height="28" alt="" aria-hidden="true" /><span>Candor</span></button><OnboardingProgress step={props.step} /><p>Everything here is local setup. The License Portal remains optional and is not required for normal use.</p></aside><section className="setup-main"><SetupStep {...props} /></section></main>;
}
