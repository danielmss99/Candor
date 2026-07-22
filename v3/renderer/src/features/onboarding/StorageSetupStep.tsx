interface StorageSetupStepProps {
  encrypted: boolean;
  busy: boolean;
  onBack: () => void;
  onContinue: () => void;
  onDefer: () => void;
}

export function StorageSetupStep({ encrypted, busy, onBack, onContinue, onDefer }: StorageSetupStepProps) {
  return (
    <section className="setup-card" aria-labelledby="storage-setup-title">
      <header><span>Step 5 of 6</span><h1 id="storage-setup-title" tabIndex={-1}>Confirm local storage</h1><p>Candor protects recordings, notes, transcripts, and reports on this device.</p></header>
      <dl className="setup-facts">
        <div><dt>Meeting data</dt><dd>{encrypted ? "Encrypted locally" : "Stored locally"}</dd></div>
        <div><dt>Protection</dt><dd>Managed by this computer</dd></div>
        <div><dt>Cloud upload</dt><dd>Off</dd></div>
      </dl>
      <div className="setup-actions">
        <button className="secondary-button" type="button" onClick={onBack} disabled={busy}>Back</button>
        <button className="text-button" type="button" onClick={onDefer} disabled={busy}>Set up later</button>
        <button className="primary-button" type="button" onClick={onContinue} disabled={busy}>Use local storage</button>
      </div>
    </section>
  );
}
