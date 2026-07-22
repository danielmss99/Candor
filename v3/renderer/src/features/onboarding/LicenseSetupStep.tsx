import { asNumber, metric, type JsonObject } from "../../core/contracts";

interface LicenseSetupStepProps {
  busy: boolean;
  licenseState: string;
  licenseStatus: JsonObject;
  onContinue: () => void;
  onOpenApp: () => void;
}

export function LicenseSetupStep({ busy, licenseState, licenseStatus, onContinue, onOpenApp }: LicenseSetupStepProps) {
  const trialDays = asNumber(licenseStatus.trialDaysRemaining, -1);
  const licenseLabel = licenseState === "trial" && trialDays >= 0
    ? `${trialDays} trial days remaining`
    : licenseState === "activated"
      ? "Activated on this device"
      : "Local trial";
  return (
    <section className="setup-card" aria-labelledby="license-setup-title">
      <header><span>Step 1 of 6</span><h1 id="license-setup-title" tabIndex={-1}>Candor is yours</h1><p>{licenseLabel}. Normal app use does not require a persistent account or sign-in.</p></header>
      <dl className="setup-facts">
        <div><dt>Plan</dt><dd>{metric(licenseStatus.planName, "Candor Professional")}</dd></div>
        <div><dt>License</dt><dd>{metric(licenseStatus.licenseId, "Local trial")}</dd></div>
        <div><dt>Verification</dt><dd>{metric(licenseStatus.productionVerification, "pending")}</dd></div>
      </dl>
      <div className="setup-actions">
        <button className="secondary-button" type="button" onClick={onOpenApp} disabled={busy}>Set up later</button>
        <button className="primary-button" type="button" onClick={onContinue} disabled={busy}>Continue setup</button>
      </div>
    </section>
  );
}
