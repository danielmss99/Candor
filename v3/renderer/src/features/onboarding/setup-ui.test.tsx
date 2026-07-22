import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { BundledAiStatus, OnboardingStep } from "../../core/contracts";
import { ActivationGate, OnboardingSetup, persistSetupTransition, runGuardedSetupTransition } from "./ActivationFlow";
import { focusMicrophoneDeferTrigger, MicrophoneDeferConfirmation, MicrophoneSetupControl, MicrophoneSetupStep } from "./MicrophoneSetupStep";
import { OnboardingProgress } from "./SetupProgress";
import { acceleratorFromKeyGesture, ShortcutSetupControl } from "./ShortcutSetupStep";
import { focusAppDestination } from "./onboarding-focus";
import type { MicrophoneSetupController } from "./useMicrophoneSetup";
import type { ShortcutSetupController } from "./useShortcutSetup";

const bundledAiStatus: BundledAiStatus = {
  releaseReady: false,
  fixture: false,
  selectionStatus: "no-default-selected",
  state: "no-default-selected",
  ready: false,
  repairRequired: false,
  repairPolicy: "signed-installer-only",
  repairAction: "none",
  speech: { state: "no-default-selected", ready: false, available: false, requiredAssets: 0, verifiedAssets: 0, modelId: null, failureCode: "BUNDLED_AI_NO_DEFAULT_SELECTED" },
  language: { state: "no-default-selected", ready: false, available: false, requiredAssets: 0, verifiedAssets: 0, modelId: null, failureCode: "BUNDLED_AI_NO_DEFAULT_SELECTED" },
};

function microphoneController(overrides: Partial<MicrophoneSetupController> = {}): MicrophoneSetupController {
  return {
    devices: [{ id: "input-0", label: "USB microphone", isDefault: true, fingerprint: "fingerprint", ordinal: 0 }],
    selectedDeviceId: "input-0",
    status: { state: "ready", rms: 0.1, peak: 0.4, clipping: false, signalDetected: true, captureComplete: false, durationMs: 5_000, accessError: "", selectionResolution: "fingerprint", reselectionRequired: false },
    uiState: "ready",
    loading: false,
    listening: false,
    sampleReady: false,
    playbackUrl: "",
    playbackCompleted: false,
    operationBusy: false,
    selectionResolution: "fingerprint",
    reselectionRequired: false,
    error: "",
    selectDevice: vi.fn(),
    startTest: vi.fn(),
    preparePlayback: vi.fn(),
    clearPlayback: vi.fn(),
    stopTest: vi.fn(),
    retry: vi.fn(),
    openPrivacySettings: vi.fn(),
    ...overrides,
  };
}

function shortcutController(overrides: Partial<ShortcutSetupController> = {}): ShortcutSetupController {
  return {
    status: { enabled: false, registered: false, accelerator: "CommandOrControl+Shift+Space", conflict: false, message: "" },
    draftAccelerator: "CommandOrControl+Shift+Space",
    loading: false,
    saving: false,
    awaitingTest: false,
    testPassed: false,
    error: "",
    setDraftAccelerator: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
    reset: vi.fn(),
    beginTest: vi.fn(),
    retry: vi.fn(),
    ...overrides,
  };
}

describe("six-step onboarding setup", () => {
  it("moves focus to the active app destination after onboarding", () => {
    const focus = vi.fn();
    const querySelector = vi.fn(() => ({ focus }));
    expect(focusAppDestination({ querySelector })).toBe(true);
    expect(querySelector).toHaveBeenCalledWith(".desktop-nav [aria-current='page']");
    expect(focus).toHaveBeenCalledOnce();
    expect(focusAppDestination({ querySelector: () => null })).toBe(false);
  });

  it("does not advance until setup persistence succeeds", async () => {
    const advance = vi.fn();
    const persist = vi.fn(async () => undefined);
    await persistSetupTransition(persist, advance);
    expect(persist).toHaveBeenCalledOnce();
    expect(advance).toHaveBeenCalledOnce();

    const rejectedAdvance = vi.fn();
    await expect(persistSetupTransition(
      async () => { throw new Error("setup write failed"); },
      rejectedAdvance,
    )).rejects.toThrow("setup write failed");
    expect(rejectedAdvance).not.toHaveBeenCalled();
  });

  it("ignores duplicate setup transitions while persistence is pending", async () => {
    let resolvePersistence!: () => void;
    const persistence = new Promise<void>((resolve) => { resolvePersistence = resolve; });
    const persist = vi.fn(() => persistence);
    const advance = vi.fn();
    const pending = vi.fn();
    const guard = { current: false };

    const first = runGuardedSetupTransition(guard, persist, advance, pending);
    const duplicate = runGuardedSetupTransition(guard, persist, advance, pending);
    expect(await duplicate).toBe(false);
    expect(persist).toHaveBeenCalledOnce();
    expect(advance).not.toHaveBeenCalled();
    expect(pending).toHaveBeenLastCalledWith(true);

    resolvePersistence();
    await expect(first).resolves.toBe(true);
    expect(advance).toHaveBeenCalledOnce();
    expect(pending).toHaveBeenLastCalledWith(false);
    expect(guard.current).toBe(false);
  });

  it("releases the transition guard and keeps the step unchanged after a write failure", async () => {
    const advance = vi.fn();
    const pending = vi.fn();
    const guard = { current: false };
    await expect(runGuardedSetupTransition(
      guard,
      async () => { throw new Error("setup write failed"); },
      advance,
      pending,
    )).rejects.toThrow("setup write failed");
    expect(advance).not.toHaveBeenCalled();
    expect(pending.mock.calls).toEqual([[true], [false]]);
    expect(guard.current).toBe(false);
  });

  it("announces all six steps in the required order", () => {
    const markup = renderToStaticMarkup(<OnboardingProgress step="shortcut" completed={["license"]} deferred={["microphone", "shortcut"]} />);
    const labels = ["License", "Microphone", "Shortcut", "System audio", "Storage", "Local AI"];
    const dispositions = ["complete", "deferred", "current step, previously deferred", "not started", "not started", "not started"];
    labels.forEach((label, index) => {
      expect(markup).toContain(`${label}, ${dispositions[index]}`);
      if (index > 0) expect(markup.indexOf(label)).toBeGreaterThan(markup.indexOf(labels[index - 1]));
    });
    expect(markup).toContain('aria-current="step"');
    expect(markup).toContain('data-disposition="deferred"');
  });

  it("renders every separate setup screen", () => {
    const labels: Record<Exclude<OnboardingStep, "activate" | "app">, string> = {
      yours: "Candor is yours",
      microphone: "Set up your microphone",
      shortcut: "Choose a recorder shortcut",
      "system-audio": "Set up system audio",
      storage: "Confirm local storage",
      "local-ai": "Set up local AI",
    };
    for (const [step, label] of Object.entries(labels)) {
      const markup = renderToStaticMarkup(
        <OnboardingSetup
          step={step as OnboardingStep}
          licenseState="trial"
          licenseStatus={{}}
          captureStatus={{ sources: { system: { implemented: true } } }}
          consentStatus={{ readyForMicRecording: true, readyForSystemAudioRecording: true }}
          vaultStatus={{ encrypted: true }}
          modelStatus={{}}
          bundledAiStatus={bundledAiStatus}
          aiModeStatus="Local fallback"
          instructReady={false}
          busy=""
          onStepChange={vi.fn()}
          onCompleteMic={vi.fn()}
          onCompleteSystemAudio={vi.fn()}
          onCompleteStorage={vi.fn()}
          onImportSpeechModel={vi.fn()}
          onFinish={vi.fn()}
          microphoneController={microphoneController()}
          shortcutController={shortcutController()}
        />,
      );
      expect(markup).toContain(label);
    }
  });

  it("announces when final setup preferences are still being saved", () => {
    const markup = renderToStaticMarkup(
      <OnboardingSetup
        step="local-ai"
        licenseState="trial"
        licenseStatus={{}}
        captureStatus={{ sources: { system: { implemented: true } } }}
        consentStatus={{ readyForMicRecording: true, readyForSystemAudioRecording: true }}
        vaultStatus={{ encrypted: true }}
        modelStatus={{}}
        bundledAiStatus={bundledAiStatus}
        aiModeStatus="Local fallback"
        instructReady={false}
        busy="setup"
        onStepChange={vi.fn()}
        onCompleteMic={vi.fn()}
        onCompleteSystemAudio={vi.fn()}
        onCompleteStorage={vi.fn()}
        onImportSpeechModel={vi.fn()}
        onFinish={vi.fn()}
        microphoneController={microphoneController()}
        shortcutController={shortcutController()}
      />,
    );
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain("Saving setup locally. This can take a few seconds.");
    expect(markup).toContain('disabled="">Saving setup...</button>');
  });

  it("surfaces and dismisses shared operation failures on both first-run screens", () => {
    const activationMarkup = renderToStaticMarkup(
      <ActivationGate
        licenseKey=""
        licenseEmail=""
        licenseKeyInvalid={false}
        licenseBusy={false}
        licenseStatus={{}}
        onLicenseKeyChange={vi.fn()}
        onLicenseEmailChange={vi.fn()}
        onLicenseKeyBlur={vi.fn()}
        onActivate={vi.fn()}
        onStartTrial={vi.fn()}
        onContinueLocal={vi.fn()}
        error="License setup could not be saved."
        onDismissError={vi.fn()}
      />,
    );
    expect(activationMarkup).toContain('role="alert"');
    expect(activationMarkup).toContain("License setup could not be saved.");
    expect(activationMarkup).toContain(">Dismiss</button>");

    const setupMarkup = renderToStaticMarkup(
      <OnboardingSetup
        step="microphone"
        licenseState="trial"
        licenseStatus={{}}
        captureStatus={{ sources: { system: { implemented: true } } }}
        consentStatus={{ readyForMicRecording: true }}
        vaultStatus={{ encrypted: true }}
        modelStatus={{}}
        bundledAiStatus={bundledAiStatus}
        aiModeStatus="Local fallback"
        instructReady={false}
        busy=""
        onStepChange={vi.fn()}
        onCompleteMic={vi.fn()}
        onCompleteSystemAudio={vi.fn()}
        onCompleteStorage={vi.fn()}
        onImportSpeechModel={vi.fn()}
        onFinish={vi.fn()}
        microphoneController={microphoneController()}
        shortcutController={shortcutController()}
        error="Microphone setup could not be saved."
        onDismissError={vi.fn()}
      />,
    );
    expect(setupMarkup).toContain('role="alert"');
    expect(setupMarkup).toContain("Microphone setup could not be saved.");
    expect(setupMarkup).toContain(">Dismiss</button>");
  });

  it("exposes live microphone state, bounded playback copy, and accessible defer confirmation", () => {
    const controlMarkup = renderToStaticMarkup(<MicrophoneSetupControl controller={microphoneController({ uiState: "signal-detected", listening: true, sampleReady: true })} />);
    expect(controlMarkup).toContain("USB microphone (system default)");
    expect(controlMarkup).toContain('aria-valuetext="40 percent peak"');
    expect(controlMarkup).toContain('aria-labelledby="candor-microphone-level-label"');
    expect(controlMarkup).toContain("Signal detected");
    expect(controlMarkup).toContain("Play 5-second test");
    expect(controlMarkup).toContain("never added to a meeting");
    const silentMarkup = renderToStaticMarkup(<MicrophoneSetupControl controller={microphoneController({ uiState: "no-signal", listening: true, sampleReady: true, status: { state: "listening", rms: 0, peak: 0, clipping: false, signalDetected: false, captureComplete: true, durationMs: 5_000, accessError: "", selectionResolution: "fingerprint", reselectionRequired: false } })} />);
    expect(silentMarkup).toContain("Test again");
    expect(silentMarkup).not.toContain("Play 5-second test");

    const completedMarkup = renderToStaticMarkup(<MicrophoneSetupControl controller={microphoneController({
      uiState: "playback-ready",
      listening: false,
      sampleReady: true,
      status: { state: "playback-ready", rms: 0.1, peak: 0.4, clipping: false, signalDetected: true, captureComplete: true, durationMs: 5_000, accessError: "", selectionResolution: "fingerprint", reselectionRequired: false },
    })} />);
    expect(completedMarkup).toContain("Play 5-second test");
    expect(completedMarkup).not.toContain("Record 5-second test");

    const stepMarkup = renderToStaticMarkup(<MicrophoneSetupStep controller={microphoneController()} consentReady={false} onBack={vi.fn()} onContinue={vi.fn()} onDefer={vi.fn()} />);
    expect(stepMarkup).toMatch(/>Continue<\/button>/);
    expect(stepMarkup).toMatch(/>Continue<\/button>/);
    expect(stepMarkup).toContain("disabled");
    expect(stepMarkup).toContain("Operating system access remains a separate hardware permission");
    expect(stepMarkup).toContain("Set up later");
    expect(stepMarkup).toContain('aria-controls="microphone-defer-confirmation"');
    const completeMarkup = renderToStaticMarkup(<MicrophoneSetupStep controller={microphoneController({ uiState: "playback-complete", playbackCompleted: true })} consentReady onBack={vi.fn()} onContinue={vi.fn()} />);
    expect(completeMarkup).toContain('<button class="primary-button" type="button">Continue</button>');

    const confirmationMarkup = renderToStaticMarkup(<MicrophoneDeferConfirmation onCancel={vi.fn()} onConfirm={vi.fn()} />);
    expect(confirmationMarkup).toContain('role="dialog"');
    expect(confirmationMarkup).not.toContain('aria-modal="true"');
    expect(confirmationMarkup).toContain('aria-labelledby="microphone-defer-title"');
    expect(confirmationMarkup).toContain('aria-describedby="microphone-defer-description"');
    expect(confirmationMarkup).toContain("autofocus");
    expect(confirmationMarkup).toContain("Finish microphone setup later?");

    const focus = vi.fn();
    focusMicrophoneDeferTrigger({ focus });
    expect(focus).toHaveBeenCalledOnce();
  });

  it("renders actionable recovery controls for missing, denied, and disconnected microphones", () => {
    const missingMarkup = renderToStaticMarkup(<MicrophoneSetupControl controller={microphoneController({
      devices: [],
      selectedDeviceId: "",
      uiState: "no-device",
    })} />);
    expect(missingMarkup).toContain("No microphone found");
    expect(missingMarkup).toContain(">Retry</button>");
    expect(missingMarkup).toContain('<button class="secondary-button" type="button" disabled="">Record 5-second test</button>');

    const deniedMarkup = renderToStaticMarkup(<MicrophoneSetupControl controller={microphoneController({
      uiState: "permission-denied",
      listening: false,
      status: { state: "permission-denied", rms: 0, peak: 0, clipping: false, signalDetected: false, captureComplete: false, durationMs: 0, accessError: "MICROPHONE_PERMISSION_DENIED", selectionResolution: "", reselectionRequired: false },
    })} />);
    expect(deniedMarkup).toContain("Microphone access is blocked");
    expect(deniedMarkup).toContain(">Open microphone settings</button>");
    expect(deniedMarkup).toContain(">Retry</button>");

    const disconnectedMarkup = renderToStaticMarkup(<MicrophoneSetupControl controller={microphoneController({
      uiState: "device-disconnected",
      listening: false,
      status: { state: "device-disconnected", rms: 0, peak: 0, clipping: false, signalDetected: false, captureComplete: false, durationMs: 0, accessError: "MICROPHONE_DEVICE_DISCONNECTED", selectionResolution: "", reselectionRequired: false },
    })} />);
    expect(disconnectedMarkup).toContain("Microphone disconnected");
    expect(disconnectedMarkup).toContain(">Retry</button>");

    const clippingMarkup = renderToStaticMarkup(<MicrophoneSetupControl controller={microphoneController({
      uiState: "clipping",
      listening: true,
      sampleReady: false,
      status: { state: "clipping", rms: 0.8, peak: 1, clipping: true, signalDetected: true, captureComplete: false, durationMs: 1_000, accessError: "", selectionResolution: "fingerprint", reselectionRequired: false },
    })} />);
    expect(clippingMarkup).toContain("Input is clipping");
    expect(clippingMarkup).toContain(">Cancel test</button>");
  });

  it.each(["default-fallback", "ambiguous-fingerprint"])("asks the user to confirm a %s microphone fallback", (selectionResolution) => {
    const markup = renderToStaticMarkup(<MicrophoneSetupControl controller={microphoneController({
      uiState: "reselection-required",
      selectionResolution,
      reselectionRequired: true,
    })} />);
    expect(markup).toContain("Choose your microphone again");
    expect(markup).toContain("could not uniquely match the microphone saved earlier");
    expect(markup).toContain("Use selected microphone");
    expect(markup).toContain('role="status"');
  });

  it("disables microphone selection, testing, and continuation during native transitions", () => {
    const busyController = microphoneController({ operationBusy: true, playbackCompleted: true });
    const controlMarkup = renderToStaticMarkup(<MicrophoneSetupControl controller={busyController} />);
    expect(controlMarkup).toContain('<select id="candor-microphone-device" disabled=""');
    expect(controlMarkup).toContain('<button class="secondary-button" type="button" disabled="">Record 5-second test</button>');

    const stepMarkup = renderToStaticMarkup(<MicrophoneSetupStep controller={busyController} consentReady onBack={vi.fn()} onContinue={vi.fn()} onDefer={vi.fn()} />);
    expect(stepMarkup).toContain('<button class="primary-button" type="button" disabled="">Continue</button>');
    expect(stepMarkup).toContain('<button class="secondary-button" type="button">Back</button>');
    expect(stepMarkup).toMatch(/<button class="text-button" type="button" aria-expanded="false" aria-controls="microphone-defer-confirmation">Set up later<\/button>/);
  });

  it("makes every setup heading programmatically focusable after step changes", () => {
    const markup = renderToStaticMarkup(
      <OnboardingSetup
        step="microphone"
        setupStatus={{ setup: { completed: ["license"], deferred: ["microphone"] } }}
        licenseState="trial"
        licenseStatus={{}}
        captureStatus={{ sources: { system: { implemented: true } } }}
        consentStatus={{ readyForMicRecording: true }}
        vaultStatus={{ encrypted: true }}
        modelStatus={{}}
        bundledAiStatus={bundledAiStatus}
        aiModeStatus="Local fallback"
        instructReady={false}
        busy=""
        onStepChange={vi.fn()}
        onCompleteMic={vi.fn()}
        onCompleteSystemAudio={vi.fn()}
        onCompleteStorage={vi.fn()}
        onImportSpeechModel={vi.fn()}
        onFinish={vi.fn()}
        microphoneController={microphoneController()}
        shortcutController={shortcutController()}
      />,
    );
    expect(markup).toContain('id="microphone-setup-title" tabindex="-1"');
    expect(markup).toContain("Microphone, current step, previously deferred");
  });

  it("states the shortcut safety boundary and supports conflict and test states", () => {
    const enabled = shortcutController({
      status: { enabled: true, registered: true, accelerator: "CommandOrControl+Shift+Space", conflict: false, message: "" },
      awaitingTest: true,
    });
    const markup = renderToStaticMarkup(<ShortcutSetupControl controller={enabled} />);
    expect(markup).toContain("Works while Candor is running.");
    expect(markup).toContain("It never starts recording.");
    expect(markup).toContain("Press shortcut to test");
    expect(markup).toContain("Now press CommandOrControl+Shift+Space.");

    const conflictMarkup = renderToStaticMarkup(<ShortcutSetupControl controller={shortcutController({ error: "That shortcut could not be registered. Another application may already use it." })} />);
    expect(conflictMarkup).toContain('role="alert"');
    expect(conflictMarkup).not.toMatch(/owned by|used by [A-Z][A-Za-z]+/);

    const persistedConflictMarkup = renderToStaticMarkup(<ShortcutSetupControl controller={shortcutController({
      status: { enabled: true, registered: false, accelerator: "CommandOrControl+Shift+Space", conflict: true, message: "" },
    })} />);
    expect(persistedConflictMarkup).toContain("Shortcut conflict");
    expect(persistedConflictMarkup).toContain("another application or the operating system may already use it");
    expect(persistedConflictMarkup).toContain('data-state="retry"');
    expect(persistedConflictMarkup).not.toMatch(/owned by|used by [A-Z][A-Za-z]+/);
  });

  it("captures a strict keyboard gesture without accepting a single modifier", () => {
    expect(acceleratorFromKeyGesture({ key: " ", ctrlKey: true, metaKey: false, altKey: false, shiftKey: true })).toBe("CommandOrControl+Shift+Space");
    expect(acceleratorFromKeyGesture({ key: "k", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })).toBe("");
  });
});
