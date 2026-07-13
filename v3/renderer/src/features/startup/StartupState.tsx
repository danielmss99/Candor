export type StartupPhase = "loading" | "ready" | "failed";

export function startupFailureTitle(message: string): string {
  return /protocol|incompatible|version/i.test(message)
    ? "Candor's local service is incompatible"
    : "Candor's local service is unavailable";
}

interface StartupLoadingProps {
  message?: string;
}

export function StartupLoading({ message = "Opening local storage and checking for interrupted recordings." }: StartupLoadingProps) {
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
  title?: string;
  description?: string;
  actionLabel?: string;
}

export function StartupRecovery({ message, retrying, onRetry, title, description, actionLabel }: StartupRecoveryProps) {
  return (
    <main className="activation-shell loading-shell" data-view="core-recovery" aria-label="Candor local service recovery">
      <section className="setup-card core-recovery-card" role="alert">
        <header><span>Local recovery</span><h1>{title ?? startupFailureTitle(message)}</h1><p>{description ?? "Candor could not open the local processing service. Your existing data has not been changed."}</p></header>
        <div className="setup-status-row"><span className="status-dot" /><strong>{message}</strong></div>
        <div className="setup-actions"><button className="primary-button" type="button" onClick={onRetry} disabled={retrying}>{retrying ? "Working..." : actionLabel ?? "Try again"}</button></div>
      </section>
    </main>
  );
}

