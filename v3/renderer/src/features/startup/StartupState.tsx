export type StartupPhase = "loading" | "ready" | "failed";

export function startupFailureTitle(message: string): string {
  return /protocol|incompatible|version/i.test(message)
    ? "Candor core is incompatible"
    : "Candor core is unavailable";
}

interface StartupLoadingProps {
  message?: string;
}

export function StartupLoading({ message = "Opening the local vault and checking for interrupted recordings." }: StartupLoadingProps) {
  return (
    <main className="activation-shell loading-shell" data-view="startup-loading" aria-label="Starting Candor">
      <section className="setup-card" role="status" aria-live="polite">
        <header><span>Starting locally</span><h1>Opening Candor</h1><p>{message}</p></header>
      </section>
    </main>
  );
}

interface StartupRecoveryProps {
  message: string;
  retrying: boolean;
  onRetry: () => void;
}

export function StartupRecovery({ message, retrying, onRetry }: StartupRecoveryProps) {
  return (
    <main className="activation-shell loading-shell" data-view="core-recovery" aria-label="Candor core recovery">
      <section className="setup-card core-recovery-card" role="alert">
        <header><span>Local core</span><h1>{startupFailureTitle(message)}</h1><p>Candor could not open the local processing service. Your existing vault has not been changed.</p></header>
        <div className="setup-status-row"><span className="status-dot" /><strong>{message}</strong></div>
        <div className="setup-actions"><button className="primary-button" type="button" onClick={onRetry} disabled={retrying}>{retrying ? "Retrying..." : "Retry local core"}</button></div>
      </section>
    </main>
  );
}

