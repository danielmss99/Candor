import { useEffect, useRef, useState } from "react";
import { asArray, asBool, asObject, asString, type BundledAiStatus, type JsonObject, type OnboardingStep } from "../../core/contracts";
import { LicenseSetupStep } from "./LicenseSetupStep";
import { LocalAiSetupStep } from "./LocalAiSetupStep";
import { MicrophoneSetupStep } from "./MicrophoneSetupStep";
import { OnboardingProgress } from "./SetupProgress";
import { ShortcutSetupStep } from "./ShortcutSetupStep";
import { StorageSetupStep } from "./StorageSetupStep";
import { SystemAudioSetupStep } from "./SystemAudioSetupStep";
import type { NativeSetupApi } from "./setup-api";
import { persistedSetupStep, SETUP_STEPS, type PersistedSetupStep } from "./setup-types";
import type { MicrophoneSetupController } from "./useMicrophoneSetup";
import { useMicrophoneSetup } from "./useMicrophoneSetup";
import type { ShortcutSetupController } from "./useShortcutSetup";
import { useShortcutSetup } from "./useShortcutSetup";

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
  error?: string;
  onDismissError?: () => void;
}

export function FirstRunOperationError({ error, onDismiss }: { error?: string; onDismiss?: () => void }) {
  if (!error) return null;
  return (
    <div className="setup-inline-error first-run-operation-error" role="alert">
      <p>{error}</p>
      {onDismiss ? <button className="text-button" type="button" onClick={onDismiss}>Dismiss</button> : null}
    </div>
  );
}

export function ActivationGate({ licenseKey, licenseEmail, licenseKeyInvalid, licenseBusy, licenseStatus, onLicenseKeyChange, onLicenseEmailChange, onLicenseKeyBlur, onActivate, onStartTrial, onContinueLocal, error, onDismissError }: ActivationGateProps) {
  return (
    <main className="activation-shell" data-view="activation" aria-label="Candor activation onboarding">
      <section className="activation-hero">
        <p className="activation-kicker">Candor Professional</p><h1>Welcome to Candor</h1><p>Private meeting intelligence that runs on your computer. No subscription, no meeting bot, no cloud account for normal use.</p>
        <div className="activation-proof-grid" aria-label="Ownership promises"><article><strong>Buy it once</strong><span>Activate this device with a local license record.</span></article><article><strong>Start locally</strong><span>Use a trial without creating an account.</span></article><article><strong>Stay private</strong><span>Recording, notes, AI, and exports remain local by default.</span></article></div>
      </section>
      <section className="activation-card" aria-label="Activate Candor">
        <FirstRunOperationError error={error} onDismiss={onDismissError} />
        <form onSubmit={(event) => { event.preventDefault(); onActivate(); }}>
          <header><h2>Activate License</h2><p>Enter your purchase key, or start a local trial while production licensing is connected.</p></header>
          <label className="activation-field" htmlFor="candor-license-key"><span>License key <em>required for activation</em></span><input id="candor-license-key" value={licenseKey} onBlur={onLicenseKeyBlur} onChange={(event) => onLicenseKeyChange(event.target.value)} aria-invalid={licenseKeyInvalid} aria-describedby="candor-license-key-help" autoCapitalize="characters" autoCorrect="off" spellCheck={false} placeholder="CANDOR-DEV-LOCAL" /><small id="candor-license-key-help" role={licenseKeyInvalid ? "alert" : undefined}>{licenseKeyInvalid ? "Enter a license key or choose Start Trial." : "Development accepts CANDOR-DEV keys until production verification is connected."}</small></label>
          <label className="activation-field" htmlFor="candor-license-email"><span>Purchase email <em>optional</em></span><input id="candor-license-email" type="email" value={licenseEmail} onChange={(event) => onLicenseEmailChange(event.target.value)} autoComplete="email" placeholder="you@example.com" /><small>Stored only as a one-way local fingerprint when provided.</small></label>
          <div className="activation-actions"><button className="primary-button" type="submit" disabled={licenseBusy}>{licenseBusy ? "Activating..." : "Activate License"}</button><button className="secondary-button" type="button" onClick={onStartTrial} disabled={licenseBusy}>Start Trial</button><button className="text-button" type="button" onClick={onContinueLocal} disabled={licenseBusy}>Open local workspace</button></div>
          <p className="activation-data-access">Existing local meetings always remain available to open, export, and delete.</p>
        </form>
        <dl className="activation-facts"><div><dt>Account required</dt><dd>No</dd></div><div><dt>Storage</dt><dd>{asBool(licenseStatus.secureStorageAvailable) ? "OS protected" : "Local metadata"}</dd></div><div><dt>Network</dt><dd>Disabled by default</dd></div></dl>
      </section>
    </main>
  );
}

export interface OnboardingSetupProps {
  step: OnboardingStep;
  licenseState: string;
  licenseStatus: JsonObject;
  captureStatus: JsonObject;
  consentStatus: JsonObject;
  vaultStatus: JsonObject;
  modelStatus: JsonObject;
  bundledAiStatus: BundledAiStatus;
  aiModeStatus: string;
  instructReady: boolean;
  busy: string;
  onStepChange: (step: OnboardingStep) => void | Promise<void>;
  onCompleteLicense?: () => void | Promise<void>;
  onCompleteMic: () => void | Promise<void>;
  onCompleteShortcut?: () => void | Promise<void>;
  onCompleteSystemAudio: () => void | Promise<void>;
  onCompleteStorage: () => void | Promise<void>;
  onImportSpeechModel: () => void;
  onFinish: () => void | Promise<void>;
  onDeferStep?: (step: OnboardingStep) => void | Promise<void>;
  setupApi?: NativeSetupApi;
  setupStatus?: JsonObject;
  microphoneController?: MicrophoneSetupController;
  shortcutController?: ShortcutSetupController;
  error?: string;
  onDismissError?: () => void;
}

interface SetupStepProps extends OnboardingSetupProps {
  microphoneController: MicrophoneSetupController;
  shortcutController: ShortcutSetupController;
}

export async function persistSetupTransition(
  persist: (() => void | Promise<void>) | undefined,
  advance: () => void | Promise<void>,
): Promise<void> {
  await persist?.();
  await advance();
}

export async function runGuardedSetupTransition(
  guard: { current: boolean },
  persist: (() => void | Promise<void>) | undefined,
  advance: () => void | Promise<void>,
  setPending: (pending: boolean) => void,
): Promise<boolean> {
  if (guard.current) return false;
  guard.current = true;
  setPending(true);
  try {
    await persistSetupTransition(persist, advance);
    return true;
  } finally {
    guard.current = false;
    setPending(false);
  }
}

function SetupStep({ step, licenseState, licenseStatus, captureStatus, consentStatus, vaultStatus, modelStatus, bundledAiStatus, aiModeStatus, instructReady, busy, onStepChange, onCompleteLicense, onCompleteMic, onCompleteShortcut, onCompleteSystemAudio, onCompleteStorage, onImportSpeechModel, onFinish, onDeferStep, microphoneController, shortcutController }: SetupStepProps) {
  const systemImplemented = asBool(asObject(asObject(captureStatus.sources).system).implemented);
  const transitionRef = useRef(false);
  const [transitionBusy, setTransitionBusy] = useState(false);
  const defer = async (current: OnboardingStep, next: OnboardingStep) => {
    try {
      await runGuardedSetupTransition(
        transitionRef,
        onDeferStep ? () => onDeferStep(current) : undefined,
        () => onStepChange(next),
        setTransitionBusy,
      );
    } catch {
      // The onboarding owner reports persistence errors. Stay on this step so retry is safe.
    }
  };
  if (step === "microphone") return <MicrophoneSetupStep controller={microphoneController} consentReady={asBool(consentStatus.readyForMicRecording)} navigationBusy={busy === "setup" || transitionBusy} onBack={() => onStepChange("yours")} onContinue={onCompleteMic} onDefer={() => defer("microphone", "shortcut")} />;
  if (step === "shortcut") return <ShortcutSetupStep controller={shortcutController} navigationBusy={busy === "setup" || transitionBusy} onBack={() => onStepChange("microphone")} onContinue={() => onCompleteShortcut ? onCompleteShortcut() : onStepChange("system-audio")} onDefer={() => defer("shortcut", "system-audio")} />;
  if (step === "system-audio") return <SystemAudioSetupStep implemented={systemImplemented} consentReady={asBool(consentStatus.readyForSystemAudioRecording)} busy={busy === "consent" || busy === "setup" || transitionBusy} onBack={() => onStepChange("shortcut")} onContinue={onCompleteSystemAudio} onDefer={() => defer("system-audio", "storage")} />;
  if (step === "storage") return <StorageSetupStep encrypted={asBool(vaultStatus.encrypted)} busy={busy === "storage" || busy === "setup" || transitionBusy} onBack={() => onStepChange("system-audio")} onContinue={onCompleteStorage} onDefer={() => defer("storage", "local-ai")} />;
  if (step === "local-ai") return <LocalAiSetupStep modelStatus={modelStatus} bundledAiStatus={bundledAiStatus} aiModeStatus={aiModeStatus} instructReady={instructReady} busy={Boolean(busy)} finishing={busy === "setup"} onBack={() => onStepChange("storage")} onImportSpeechModel={onImportSpeechModel} onFinish={onFinish} />;
  return <LicenseSetupStep busy={busy === "setup" || transitionBusy} licenseState={licenseState} licenseStatus={licenseStatus} onOpenApp={onFinish} onContinue={() => onCompleteLicense ? onCompleteLicense() : onStepChange("microphone")} />;
}

export function OnboardingSetup(props: OnboardingSetupProps) {
  const mainRef = useRef<HTMLElement>(null);
  const nativeMicrophoneController = useMicrophoneSetup({ active: props.step === "microphone" && !props.microphoneController, api: props.setupApi });
  const nativeShortcutController = useShortcutSetup({ active: props.step === "shortcut" && !props.shortcutController, api: props.setupApi });
  const validStepIds = new Set<string>(SETUP_STEPS.map(({ id }) => persistedSetupStep(id)));
  const setup = asObject(props.setupStatus?.setup);
  const setupSteps = (field: "completed" | "deferred"): PersistedSetupStep[] => asArray(setup[field])
    .map((item) => asString(item))
    .filter((item): item is PersistedSetupStep => validStepIds.has(item));

  useEffect(() => {
    mainRef.current?.querySelector<HTMLHeadingElement>("h1")?.focus();
  }, [props.step]);

  return <main className="activation-shell setup-shell" data-view="onboarding" aria-label="Candor first run setup"><aside className="setup-side"><button className="wordmark setup-wordmark" type="button" onClick={() => props.onStepChange("yours")}><img src="./candor-mark.png" width="28" height="28" alt="" aria-hidden="true" /><span>Candor</span></button><OnboardingProgress step={props.step} completed={setupSteps("completed")} deferred={setupSteps("deferred")} /><p>Everything here is local setup. The License Portal remains optional and is not required for normal use.</p></aside><section ref={mainRef} className="setup-main"><FirstRunOperationError error={props.error} onDismiss={props.onDismissError} /><SetupStep {...props} microphoneController={props.microphoneController ?? nativeMicrophoneController} shortcutController={props.shortcutController ?? nativeShortcutController} /></section></main>;
}
