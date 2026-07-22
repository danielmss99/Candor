interface SystemAudioSetupStepProps {
  implemented: boolean;
  consentReady: boolean;
  busy: boolean;
  onBack: () => void;
  onContinue: () => void;
  onDefer: () => void;
}

export function SystemAudioSetupStep({ implemented, consentReady, busy, onBack, onContinue, onDefer }: SystemAudioSetupStepProps) {
  const ready = implemented && consentReady;
  const label = !implemented
    ? "System audio capture is unavailable on this operating system build"
    : consentReady
      ? "System audio consent saved"
      : "System audio consent required";
  return (
    <section className="setup-card" aria-labelledby="system-audio-setup-title">
      <header><span>Step 4 of 6</span><h1 id="system-audio-setup-title" tabIndex={-1}>Set up system audio</h1><p>Capture meeting audio played by this computer when the operating system supports it.</p></header>
      <div className="setup-status-row" role="status"><span className={ready ? "status-dot ok" : "status-dot"} aria-hidden="true" /><strong>{label}</strong></div>
      <p className="setup-privacy-note">Candor requests this source only after you visibly start a recording. It does not capture other applications in the background.</p>
      <div className="setup-actions">
        <button className="secondary-button" type="button" onClick={onBack} disabled={busy}>Back</button>
        <button className="text-button" type="button" onClick={onDefer} disabled={busy}>Set up later</button>
        <button className="primary-button" type="button" onClick={onContinue} disabled={busy}>{!implemented || consentReady ? "Continue" : "Acknowledge system audio"}</button>
      </div>
    </section>
  );
}
