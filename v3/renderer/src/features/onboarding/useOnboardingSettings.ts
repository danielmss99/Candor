import { useCallback, useEffect, useState } from "react";
import {
  asArray,
  asBool,
  asObject,
  asString,
  type AppView,
  type JsonObject,
  type OnboardingStep,
} from "../../core/contracts";
import type { RunOperation } from "../jobs/useOperationRunner";

type CoreApi = NonNullable<Window["candor"]>["core"];

interface UseOnboardingSettingsOptions {
  api: CoreApi | undefined;
  licenseAvailable: boolean;
  licenseLoaded: boolean;
  licenseStatus: JsonObject;
  licensePromptDismissed: boolean;
  recordingCount: number;
  captureStatus: JsonObject;
  consentStatus: JsonObject;
  vaultStatus: JsonObject;
  run: RunOperation;
  activateLicense: () => Promise<unknown>;
  startTrial: () => Promise<unknown>;
  deactivateLicense: () => Promise<unknown>;
  dismissLicensePrompt: () => void;
  importModel: () => Promise<void>;
  refreshCapture: () => Promise<void>;
  refreshModelsAndAi: () => Promise<void>;
  refreshPrivacyFacts: () => Promise<void>;
  refreshVaultAndRetention: () => Promise<void>;
  setConsentStatus: (status: JsonObject) => void;
  setView: (view: AppView) => void;
  setNotice: (message: string) => void;
  setError: (message: string) => void;
}

export function inactiveLicenseStep(recordingCount: number, promptDismissed: boolean): OnboardingStep {
  return recordingCount > 0 || promptDismissed ? "app" : "activate";
}

export function useOnboardingSettings(options: UseOnboardingSettingsOptions) {
  const {
    api,
    licenseAvailable,
    licenseLoaded,
    licenseStatus,
    licensePromptDismissed,
    recordingCount,
    captureStatus,
    consentStatus,
    vaultStatus,
    run,
    activateLicense,
    startTrial,
    deactivateLicense,
    dismissLicensePrompt,
    importModel,
    refreshCapture,
    refreshModelsAndAi,
    refreshPrivacyFacts,
    refreshVaultAndRetention,
    setConsentStatus,
    setView,
    setNotice,
    setError,
  } = options;
  const [step, setStep] = useState<OnboardingStep>("activate");
  const [advancedSettingsOpen, setAdvancedSettingsOpen] = useState(false);

  useEffect(() => {
    if (!licenseLoaded) return;
    if (!licenseAvailable) {
      setStep("app");
      return;
    }
    if (asString(licenseStatus.state, "inactive") === "inactive") {
      setStep(inactiveLicenseStep(recordingCount, licensePromptDismissed));
    } else if (step === "activate") {
      setStep("app");
    }
  }, [licenseAvailable, licenseLoaded, licensePromptDismissed, licenseStatus, recordingCount, step]);

  const activate = useCallback(async () => {
    await run("license", async () => {
      await activateLicense();
      setStep("yours");
      setNotice("Candor activated locally");
    });
  }, [activateLicense, run, setNotice]);

  const trial = useCallback(async () => {
    await run("license", async () => {
      await startTrial();
      setStep("yours");
      setNotice("Local trial started");
    });
  }, [run, setNotice, startTrial]);

  const deactivate = useCallback(async () => {
    await run("license", async () => {
      await deactivateLicense();
      setStep("app");
      setView(recordingCount ? "library" : "home");
      setNotice("Local activation removed from this device");
    });
  }, [deactivateLicense, recordingCount, run, setNotice, setView]);

  const continueWithoutActivation = useCallback(() => {
    dismissLicensePrompt();
    setStep("app");
    setView(recordingCount ? "library" : "home");
    setNotice("Local workspace opened. Existing data remains available.");
  }, [dismissLicensePrompt, recordingCount, setNotice, setView]);

  const completeMic = useCallback(async () => {
    if (!api) return;
    if (asBool(consentStatus.readyForMicRecording)) {
      setStep("system-audio");
      return;
    }
    await run("consent", async () => {
      setConsentStatus(asObject(await api.consentAcknowledge({ items: ["localOnlyStorage", "micRecording"] })));
      await refreshCapture();
      setStep("system-audio");
      setNotice("Microphone recording consent saved locally");
    });
  }, [api, consentStatus.readyForMicRecording, refreshCapture, run, setConsentStatus, setNotice]);

  const completeSystemAudio = useCallback(async () => {
    if (!api) return;
    const systemImplemented = asBool(asObject(asObject(captureStatus.sources).system).implemented);
    if (!systemImplemented || asBool(consentStatus.readyForSystemAudioRecording)) {
      setStep("storage");
      return;
    }
    const required = asArray(consentStatus.requiredForSystemAudio).map((item) => asString(item)).filter(Boolean);
    await run("consent", async () => {
      setConsentStatus(asObject(await api.consentAcknowledge({ items: required.length ? required : ["localOnlyStorage", "systemAudioRecording"] })));
      await refreshCapture();
      setStep("storage");
      setNotice("System audio consent saved locally");
    });
  }, [api, captureStatus.sources, consentStatus.readyForSystemAudioRecording, consentStatus.requiredForSystemAudio, refreshCapture, run, setConsentStatus, setNotice]);

  const completeStorage = useCallback(async () => {
    if (!api) return;
    await run("storage", async () => {
      if (asBool(vaultStatus.localOpenAvailable)) await api.vaultOpenLocal();
      await refreshVaultAndRetention();
      setStep("local-ai");
      setNotice("Local storage is ready");
    });
  }, [api, refreshVaultAndRetention, run, setNotice, vaultStatus.localOpenAvailable]);

  const finish = useCallback(() => {
    setStep("app");
    setView("home");
    setNotice("Candor is ready");
  }, [setNotice, setView]);

  const acknowledgeMic = useCallback(async () => {
    if (!api) return;
    await run("consent", async () => {
      setConsentStatus(asObject(await api.consentAcknowledge({ items: ["localOnlyStorage", "micRecording"] })));
      setNotice("Microphone recording consent saved locally");
      await refreshCapture();
    });
  }, [api, refreshCapture, run, setConsentStatus, setNotice]);

  const acknowledgeSystem = useCallback(async () => {
    if (!api) return;
    const required = asArray(consentStatus.requiredForSystemAudio).map((item) => asString(item)).filter(Boolean);
    await run("consent", async () => {
      setConsentStatus(asObject(await api.consentAcknowledge({ items: required.length ? required : ["localOnlyStorage", "systemAudioRecording"] })));
      setNotice("System audio consent saved locally");
      await refreshCapture();
    });
  }, [api, consentStatus.requiredForSystemAudio, refreshCapture, run, setConsentStatus, setNotice]);

  const refreshLocalSettings = useCallback(async () => {
    await run("refresh settings", async () => {
      await Promise.all([refreshCapture(), refreshModelsAndAi(), refreshPrivacyFacts(), refreshVaultAndRetention()]);
      setNotice("Local settings refreshed");
    }, "settings-refresh");
  }, [refreshCapture, refreshModelsAndAi, refreshPrivacyFacts, refreshVaultAndRetention, run, setNotice]);

  const toggleAdvancedSettings = useCallback(() => {
    setAdvancedSettingsOpen((current) => {
      if (!current) void refreshPrivacyFacts().catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
      return !current;
    });
  }, [refreshPrivacyFacts, setError]);

  return {
    step,
    advancedSettingsOpen,
    setStep,
    activate,
    trial,
    deactivate,
    continueWithoutActivation,
    completeMic,
    completeSystemAudio,
    completeStorage,
    finish,
    acknowledgeMic,
    acknowledgeSystem,
    refreshLocalSettings,
    toggleAdvancedSettings,
    importModel,
  };
}

