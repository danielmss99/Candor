import { useCallback, useEffect, useRef, useState } from "react";
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

type CoreApi = NonNullable<Window["candor"]>;
type DesktopSetupStep = "license" | "microphone" | "shortcut" | "system-audio" | "storage" | "local-ai";

const DESKTOP_SETUP_STEPS: DesktopSetupStep[] = [
  "license",
  "microphone",
  "shortcut",
  "system-audio",
  "storage",
  "local-ai",
];

function onboardingStepForDesktop(step: DesktopSetupStep): OnboardingStep {
  return step === "license" ? "yours" : step;
}

function desktopStepForOnboarding(step: OnboardingStep): DesktopSetupStep | null {
  if (step === "yours") return "license";
  return DESKTOP_SETUP_STEPS.includes(step as DesktopSetupStep) ? step as DesktopSetupStep : null;
}

function setupStepList(status: JsonObject, field: "completed" | "deferred"): DesktopSetupStep[] {
  return asArray(asObject(status.setup)[field])
    .map((item) => asString(item))
    .filter((item): item is DesktopSetupStep => DESKTOP_SETUP_STEPS.includes(item as DesktopSetupStep));
}

export async function completeDeferredSetup(
  initialStatus: JsonObject,
  setup: Pick<CoreApi["setup"], "defer" | "complete">,
  onStatus: (status: JsonObject) => void = () => undefined,
): Promise<JsonObject> {
  let latestStatus = initialStatus;
  const completed = new Set(setupStepList(initialStatus, "completed"));
  const deferred = new Set(setupStepList(initialStatus, "deferred"));
  for (const candidate of DESKTOP_SETUP_STEPS) {
    if (!completed.has(candidate) && !deferred.has(candidate)) {
      latestStatus = asObject(await setup.defer({ step: candidate }));
      onStatus(latestStatus);
    }
  }
  latestStatus = asObject(await setup.complete());
  onStatus(latestStatus);
  return latestStatus;
}

export async function completeReadySetupStep(
  run: RunOperation,
  persist: () => void | Promise<void>,
  advance: () => void,
): Promise<void> {
  await run("setup", async () => {
    await persist();
    advance();
  });
}

export async function persistActiveSetupStep(
  step: OnboardingStep,
  setup: Pick<CoreApi["setup"], "visit"> | undefined,
  onStatus: (status: JsonObject) => void = () => undefined,
): Promise<JsonObject | null> {
  const desktopStep = desktopStepForOnboarding(step);
  if (!desktopStep || !setup) return null;
  const status = asObject(await setup.visit({ step: desktopStep }));
  onStatus(status);
  return status;
}

export function firstIncompleteSetupStep(status: JsonObject, includeLicense = true): OnboardingStep {
  const completed = new Set(setupStepList(status, "completed"));
  const first = DESKTOP_SETUP_STEPS.find((candidate) => (includeLicense || candidate !== "license") && !completed.has(candidate));
  return first ? onboardingStepForDesktop(first) : "app";
}

export function recordingSetupIsComplete(status: JsonObject, systemAudioImplemented: boolean): boolean {
  const completed = setupStepList(status, "completed");
  return completed.includes("microphone")
    && (!systemAudioImplemented || completed.includes("system-audio"));
}

export function isNonBlockingSetupUpgrade(status: JsonObject): boolean {
  return asBool(asObject(status.setup).nonBlockingUpgrade);
}

export function shouldOpenNonBlockingSetupUpgrade(status: JsonObject, forceSetupOpen: boolean): boolean {
  return !forceSetupOpen && isNonBlockingSetupUpgrade(status);
}

export function setupStepAfterLoad(
  status: JsonObject,
  forceSetupOpen: boolean,
  hasExistingMeetings = false,
): OnboardingStep {
  if (!forceSetupOpen && (hasExistingMeetings || shouldOpenNonBlockingSetupUpgrade(status, false))) return "app";
  const progress = asString(asObject(status.setup).progress, "not-started");
  if (progress === "completed" && !forceSetupOpen) return "app";
  return firstIncompleteSetupStep(status, !forceSetupOpen);
}

export function shouldShowNonBlockingSetupPrompt(
  status: JsonObject,
  setupNeedsAttention: boolean,
  promptShownLocally: boolean,
  hasExistingMeetings = false,
): boolean {
  const setup = asObject(status.setup);
  return setupNeedsAttention
    && (hasExistingMeetings || isNonBlockingSetupUpgrade(status))
    && !promptShownLocally
    && !asBool(setup.existingUserPromptShown);
}

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
  const [step, setStepState] = useState<OnboardingStep>("activate");
  const [advancedSettingsOpen, setAdvancedSettingsOpen] = useState(false);
  const [setupStatus, setSetupStatus] = useState<JsonObject>({});
  const [setupLoaded, setSetupLoaded] = useState(false);
  const [forceSetupOpen, setForceSetupOpen] = useState(false);
  const [existingSetupPromptShown, setExistingSetupPromptShown] = useState(false);
  const setupLoadRouteClaimed = useRef(false);

  const refreshSetupStatus = useCallback(async () => {
    if (!api?.setup) {
      setSetupLoaded(true);
      return {};
    }
    const status = asObject(await api.setup.getStatus());
    setSetupStatus(status);
    setSetupLoaded(true);
    return status;
  }, [api]);

  useEffect(() => {
    setupLoadRouteClaimed.current = false;
    setSetupLoaded(false);
    void refreshSetupStatus().catch((reason) => {
      setSetupLoaded(true);
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  }, [refreshSetupStatus, setError]);

  useEffect(() => {
    if (!licenseLoaded || !setupLoaded) return;
    if (!forceSetupOpen && recordingCount > 0) {
      setupLoadRouteClaimed.current = true;
      setStepState("app");
      return;
    }
    if (setupLoadRouteClaimed.current) return;
    setupLoadRouteClaimed.current = true;
    const next = setupStepAfterLoad(setupStatus, forceSetupOpen, recordingCount > 0);
    if (next === "app") {
      setStepState("app");
      setForceSetupOpen(false);
      return;
    }
    if (next !== "yours") {
      setStepState(next);
      return;
    }
    if (!licenseAvailable) {
      if (!api?.setup) {
        setStepState("microphone");
        return;
      }
      void api.setup.defer({ step: "license" })
        .then(async (value) => {
          setSetupStatus(asObject(value));
          await persistActiveSetupStep("microphone", api.setup, setSetupStatus);
          setStepState("microphone");
        })
        .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
      return;
    }
    if (asString(licenseStatus.state, "inactive") === "inactive" && !licensePromptDismissed) {
      setStepState("activate");
    } else {
      setStepState("yours");
    }
  }, [api, forceSetupOpen, licenseAvailable, licenseLoaded, licensePromptDismissed, licenseStatus, recordingCount, setError, setupLoaded, setupStatus]);

  const updateSetupStep = useCallback(async (completed: DesktopSetupStep, visit?: DesktopSetupStep) => {
    if (!api?.setup) return;
    const status = asObject(await api.setup.updateStep({ step: completed, ...(visit ? { visit } : {}) }));
    setSetupStatus(status);
  }, [api]);

  const deferDesktopStep = useCallback(async (deferred: DesktopSetupStep) => {
    if (!api?.setup) return;
    const status = asObject(await api.setup.defer({ step: deferred }));
    setSetupStatus(status);
  }, [api]);

  const setStep = useCallback(async (next: OnboardingStep) => {
    await run("setup", async () => {
      await persistActiveSetupStep(next, api?.setup, setSetupStatus);
      setStepState(next);
    });
  }, [api, run]);

  const activate = useCallback(async () => {
    await run("license", async () => {
      await activateLicense();
      await updateSetupStep("license", "microphone");
      await persistActiveSetupStep("yours", api?.setup, setSetupStatus);
      setStepState("yours");
      setNotice("Candor activated locally");
    });
  }, [activateLicense, api, run, setNotice, updateSetupStep]);

  const trial = useCallback(async () => {
    await run("license", async () => {
      await startTrial();
      await updateSetupStep("license", "microphone");
      await persistActiveSetupStep("yours", api?.setup, setSetupStatus);
      setStepState("yours");
      setNotice("Local trial started");
    });
  }, [api, run, setNotice, startTrial, updateSetupStep]);

  const deactivate = useCallback(async () => {
    await run("license", async () => {
      await deactivateLicense();
      setStepState("app");
      setView(recordingCount ? "library" : "home");
      setNotice("Local activation removed from this device");
    });
  }, [deactivateLicense, recordingCount, run, setNotice, setView]);

  const continueWithoutActivation = useCallback(() => {
    dismissLicensePrompt();
    if (isNonBlockingSetupUpgrade(setupStatus)) {
      setStepState("app");
      setView("library");
      setNotice("Local workspace opened. Existing data remains available.");
      return;
    }
    void run("setup", async () => {
      await deferDesktopStep("license");
      await persistActiveSetupStep("microphone", api?.setup, setSetupStatus);
      setStepState("microphone");
      setNotice("License setup deferred. Device setup continues locally.");
    });
  }, [api, deferDesktopStep, dismissLicensePrompt, run, setNotice, setView, setupStatus]);

  const completeMic = useCallback(async () => {
    if (!api) return;
    if (asBool(consentStatus.readyForMicRecording)) {
      await completeReadySetupStep(
        run,
        () => updateSetupStep("microphone", "shortcut"),
        () => setStepState("shortcut"),
      );
      return;
    }
    await run("consent", async () => {
      setConsentStatus(asObject(await api.capture.acknowledgeConsent(["localOnlyStorage", "micRecording"])));
      await refreshCapture();
      await updateSetupStep("microphone", "shortcut");
      setStepState("shortcut");
      setNotice("Microphone recording consent saved locally");
    });
  }, [api, consentStatus.readyForMicRecording, refreshCapture, run, setConsentStatus, setNotice, updateSetupStep]);

  const completeShortcut = useCallback(async () => {
    await run("setup", async () => {
      await updateSetupStep("shortcut", "system-audio");
      setStepState("system-audio");
    });
  }, [run, updateSetupStep]);

  const completeLicense = useCallback(async () => {
    await run("setup", async () => {
      await updateSetupStep("license", "microphone");
      setStepState("microphone");
    });
  }, [run, updateSetupStep]);

  const completeSystemAudio = useCallback(async () => {
    if (!api) return;
    const systemImplemented = asBool(asObject(asObject(captureStatus.sources).system).implemented);
    if (!systemImplemented || asBool(consentStatus.readyForSystemAudioRecording)) {
      await completeReadySetupStep(
        run,
        () => updateSetupStep("system-audio", "storage"),
        () => setStepState("storage"),
      );
      return;
    }
    const required = asArray(consentStatus.requiredForSystemAudio).map((item) => asString(item)).filter(Boolean);
    await run("consent", async () => {
      setConsentStatus(asObject(await api.capture.acknowledgeConsent(required.length ? required : ["localOnlyStorage", "systemAudioRecording"])));
      await refreshCapture();
      await updateSetupStep("system-audio", "storage");
      setStepState("storage");
      setNotice("System audio consent saved locally");
    });
  }, [api, captureStatus.sources, consentStatus.readyForSystemAudioRecording, consentStatus.requiredForSystemAudio, refreshCapture, run, setConsentStatus, setNotice, updateSetupStep]);

  const completeStorage = useCallback(async () => {
    if (!api) return;
    await run("storage", async () => {
      if (asBool(vaultStatus.localOpenAvailable)) await api.settings.openLocalStorage();
      await refreshVaultAndRetention();
      await updateSetupStep("storage", "local-ai");
      setStepState("local-ai");
      setNotice("Local storage is ready");
    });
  }, [api, refreshVaultAndRetention, run, setNotice, updateSetupStep, vaultStatus.localOpenAvailable]);

  const finish = useCallback(async () => {
    await run("setup", async () => {
      if (api?.setup) {
        if (step === "local-ai") {
          await updateSetupStep("local-ai");
        } else {
          await completeDeferredSetup(setupStatus, api.setup, setSetupStatus);
          setForceSetupOpen(false);
          setStepState("app");
          setView("home");
          setNotice("Device setup deferred. You can finish it from Home or Settings.");
          return;
        }
        setSetupStatus(asObject(await api.setup.complete()));
      }
      setForceSetupOpen(false);
      setStepState("app");
      setView("home");
      setNotice(step === "local-ai" ? "Candor is ready" : "Device setup deferred. You can finish it from Home or Settings.");
    });
  }, [api, run, setNotice, setView, setupStatus, step, updateSetupStep]);

  const deferStep = useCallback(async (onboardingStep: OnboardingStep) => {
    const desktopStep = desktopStepForOnboarding(onboardingStep);
    if (!desktopStep) return;
    try {
      await deferDesktopStep(desktopStep);
      setNotice(`${desktopStep === "system-audio" ? "System audio" : desktopStep[0].toUpperCase() + desktopStep.slice(1)} setup deferred`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    }
  }, [deferDesktopStep, setError, setNotice]);

  const openDeviceSetup = useCallback(() => {
    void run("setup", async () => {
      let status = await refreshSetupStatus();
      const completed = new Set(setupStepList(status, "completed"));
      const deferred = new Set(setupStepList(status, "deferred"));
      if (!completed.has("license") && !deferred.has("license") && api?.setup) {
        status = asObject(await api.setup.defer({ step: "license" }));
        setSetupStatus(status);
      }
      const next = firstIncompleteSetupStep(status, false);
      await persistActiveSetupStep(next, api?.setup, setSetupStatus);
      setForceSetupOpen(true);
      setStepState(next);
    });
  }, [api, refreshSetupStatus, run]);

  const acknowledgeMic = useCallback(async () => {
    if (!api) return;
    await run("consent", async () => {
      setConsentStatus(asObject(await api.capture.acknowledgeConsent(["localOnlyStorage", "micRecording"])));
      setNotice("Microphone recording consent saved locally");
      await refreshCapture();
    });
  }, [api, refreshCapture, run, setConsentStatus, setNotice]);

  const acknowledgeSystem = useCallback(async () => {
    if (!api) return;
    const required = asArray(consentStatus.requiredForSystemAudio).map((item) => asString(item)).filter(Boolean);
    await run("consent", async () => {
      setConsentStatus(asObject(await api.capture.acknowledgeConsent(required.length ? required : ["localOnlyStorage", "systemAudioRecording"])));
      setNotice("System audio consent saved locally");
      await refreshCapture();
    });
  }, [api, consentStatus.requiredForSystemAudio, refreshCapture, run, setConsentStatus, setNotice]);

  const refreshLocalSettings = useCallback(async () => {
    await run("refresh settings", async () => {
      await refreshCapture();
      await refreshPrivacyFacts();
      await refreshVaultAndRetention();
      await refreshModelsAndAi();
      setNotice("Local settings refreshed");
    }, "settings-refresh");
  }, [refreshCapture, refreshModelsAndAi, refreshPrivacyFacts, refreshVaultAndRetention, run, setNotice]);

  const toggleAdvancedSettings = useCallback(() => {
    setAdvancedSettingsOpen((current) => {
      if (!current) void refreshPrivacyFacts().catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
      return !current;
    });
  }, [refreshPrivacyFacts, setError]);

  const systemAudioImplemented = asBool(asObject(asObject(captureStatus.sources).system).implemented);
  const recordingSetupComplete = recordingSetupIsComplete(setupStatus, systemAudioImplemented);
  const setupNeedsAttention = setupLoaded && !recordingSetupComplete;

  useEffect(() => {
    if (!shouldShowNonBlockingSetupPrompt(setupStatus, setupNeedsAttention, existingSetupPromptShown, recordingCount > 0)) return;
    setExistingSetupPromptShown(true);
    if (!api?.setup) {
      setNotice("Finish device setup when convenient. Your existing meetings remain available.");
      return;
    }
    void api.setup.markExistingUserPromptShown()
      .then((status) => {
        setSetupStatus(asObject(status));
        setNotice("Finish device setup when convenient. Your existing meetings remain available.");
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [api, existingSetupPromptShown, recordingCount, setError, setNotice, setupNeedsAttention, setupStatus]);

  return {
    step,
    setupStatus,
    setupLoaded,
    setupNeedsAttention,
    recordingSetupComplete,
    advancedSettingsOpen,
    setStep,
    activate,
    trial,
    deactivate,
    continueWithoutActivation,
    completeMic,
    completeLicense,
    completeShortcut,
    completeSystemAudio,
    completeStorage,
    finish,
    deferStep,
    openDeviceSetup,
    acknowledgeMic,
    acknowledgeSystem,
    refreshLocalSettings,
    toggleAdvancedSettings,
    importModel,
  };
}
