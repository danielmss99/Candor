import { useEffect, useRef, useState } from "react";
import type { SetupNavigationProps } from "./setup-types";
import type { MicrophoneSetupController, MicrophoneUiState } from "./useMicrophoneSetup";

const MIC_STATE_COPY: Record<MicrophoneUiState, { title: string; detail: string }> = {
  "loading-devices": { title: "Looking for microphones", detail: "Candor is checking audio devices attached to this computer." },
  "no-device": { title: "No microphone found", detail: "Connect a microphone, then try again. Existing meetings remain available." },
  "permission-denied": { title: "Microphone access is blocked", detail: "Allow Candor in the operating system microphone privacy settings, then retry." },
  ready: { title: "Ready to test", detail: "Choose a microphone and record a five-second sample that stays in memory." },
  listening: { title: "Listening locally", detail: "Speak normally. Candor keeps at most five seconds in memory for this test." },
  "signal-detected": { title: "Signal detected", detail: "Your microphone is receiving audio. Keep speaking until playback is ready." },
  "no-signal": { title: "No signal detected", detail: "Check the selected device and its mute switch, or test another microphone." },
  clipping: { title: "Input is clipping", detail: "Move farther from the microphone or lower its input level, then test again." },
  "device-disconnected": { title: "Microphone disconnected", detail: "Reconnect it or choose another device, then retry." },
  "reselection-required": { title: "Choose your microphone again", detail: "Candor could not uniquely match the microphone saved earlier. Confirm the device shown or choose another one to save a fresh selection." },
  "playback-ready": { title: "Playback ready", detail: "Listen to the local sample. It is never added to your meeting library." },
  "playback-complete": { title: "Microphone test complete", detail: "The local playback buffer was cleared. You can continue or test again." },
  retry: { title: "Microphone test needs attention", detail: "Nothing was saved. Review the message and retry when ready." },
};

export interface MicrophoneSetupControlProps {
  controller: MicrophoneSetupController;
  consentReady?: boolean;
  compact?: boolean;
}

export function MicrophoneSetupControl({ controller, consentReady = false, compact = false }: MicrophoneSetupControlProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const copy = MIC_STATE_COPY[controller.uiState];
  const peakPercent = Math.round(controller.status.peak * 100);

  useEffect(() => {
    if (!controller.playbackUrl) return;
    void audioRef.current?.play().catch(() => undefined);
  }, [controller.playbackUrl]);

  return (
    <div className="microphone-setup-control" data-compact={compact}>
      <label className="setup-control-field" htmlFor="candor-microphone-device">
        <span>Microphone</span>
        <select
          id="candor-microphone-device"
          value={controller.selectedDeviceId}
          disabled={controller.loading || controller.listening || controller.operationBusy || controller.devices.length === 0}
          onChange={(event) => void controller.selectDevice(event.target.value)}
        >
          {controller.devices.length === 0 ? <option value="">No microphone available</option> : null}
          {controller.devices.map((device) => (
            <option key={device.id} value={device.id}>
              {device.label}{device.isDefault && device.id !== "default" ? " (system default)" : ""}
            </option>
          ))}
        </select>
      </label>

      <div className="mic-meter">
        <span id="candor-microphone-level-label">Input level</span>
        <meter aria-labelledby="candor-microphone-level-label" aria-valuetext={`${peakPercent} percent peak`} min="0" max="1" low={0.05} high={0.92} optimum={0.55} value={controller.status.peak}>0%</meter>
        <strong aria-hidden="true">{peakPercent}%</strong>
      </div>

      <div className="setup-device-status" data-state={controller.uiState} role="status" aria-live="polite">
        <span className={`status-dot ${controller.uiState === "signal-detected" || controller.uiState === "playback-ready" ? "ok" : ""}`} aria-hidden="true" />
        <div><strong>{copy.title}</strong><p>{copy.detail}</p></div>
      </div>

      {controller.error ? <p className="setup-inline-error" role="alert">{controller.error}</p> : null}

      <div className="setup-control-actions">
        {controller.reselectionRequired && controller.selectedDeviceId ? (
          <button className="primary-button" type="button" onClick={() => void controller.selectDevice(controller.selectedDeviceId)} disabled={controller.loading || controller.listening || controller.operationBusy}>
            Use selected microphone
          </button>
        ) : null}
        {!controller.listening && !controller.sampleReady && !controller.playbackUrl ? (
          <button className="secondary-button" type="button" onClick={() => void controller.startTest()} disabled={!controller.selectedDeviceId || controller.loading || controller.operationBusy}>
            Record 5-second test
          </button>
        ) : null}
        {controller.listening && !controller.sampleReady ? (
          <button className="secondary-button" type="button" onClick={() => void controller.stopTest()} disabled={controller.operationBusy}>Cancel test</button>
        ) : null}
        {controller.sampleReady && !controller.playbackUrl && controller.status.signalDetected ? (
          <button className="primary-button" type="button" onClick={() => void controller.preparePlayback()} disabled={controller.operationBusy}>Play 5-second test</button>
        ) : null}
        {controller.sampleReady && !controller.playbackUrl && !controller.status.signalDetected ? (
          <button className="secondary-button" type="button" onClick={() => void controller.stopTest().then(() => controller.startTest())} disabled={controller.operationBusy}>Test again</button>
        ) : null}
        {controller.uiState === "permission-denied" ? (
          <button className="secondary-button" type="button" onClick={() => void controller.openPrivacySettings()} disabled={controller.operationBusy}>Open microphone settings</button>
        ) : null}
        {controller.uiState === "retry" || controller.uiState === "no-device" || controller.uiState === "permission-denied" || controller.uiState === "device-disconnected" ? (
          <button className="text-button" type="button" onClick={() => void controller.retry()} disabled={controller.operationBusy}>Retry</button>
        ) : null}
      </div>

      {controller.playbackUrl ? (
        <div className="mic-playback">
          <audio
            ref={audioRef}
            controls
            src={controller.playbackUrl}
            aria-label="Your five-second local microphone test"
            onEnded={() => controller.clearPlayback(true)}
            onError={() => controller.clearPlayback(false)}
          />
          <button className="text-button" type="button" onClick={() => void controller.startTest()} disabled={controller.operationBusy}>Test again</button>
        </div>
      ) : null}

      {!compact ? <p className="setup-privacy-note">This sample stays in memory, is cleared after playback or when you leave this step, and is never added to a meeting.</p> : null}
      {!consentReady && !compact ? <p className="setup-consent-note">Continuing also saves Candor's local microphone recording consent. Operating system access remains a separate hardware permission.</p> : null}
    </div>
  );
}

interface MicrophoneSetupStepProps extends SetupNavigationProps {
  controller: MicrophoneSetupController;
  consentReady: boolean;
}

export function focusMicrophoneDeferTrigger(trigger: Pick<HTMLButtonElement, "focus"> | null): void {
  trigger?.focus();
}

export function MicrophoneDeferConfirmation({ onCancel, onConfirm, busy = false }: { onCancel: () => void; onConfirm?: () => void | Promise<void>; busy?: boolean }) {
  return (
    <div id="microphone-defer-confirmation" className="setup-defer-confirmation" role="dialog" aria-labelledby="microphone-defer-title" aria-describedby="microphone-defer-description">
      <strong id="microphone-defer-title">Finish microphone setup later?</strong>
      <p id="microphone-defer-description">You can keep using existing meetings, but recording setup will remain incomplete until a microphone is tested.</p>
      <div className="setup-control-actions">
        <button className="secondary-button" type="button" onClick={onCancel} disabled={busy} autoFocus>Keep setting up</button>
        <button className="text-button" type="button" onClick={onConfirm} disabled={busy}>Set up later</button>
      </div>
    </div>
  );
}

export function MicrophoneSetupStep({ controller, consentReady, onBack, onContinue, onDefer, navigationBusy = false }: MicrophoneSetupStepProps) {
  const [confirmDefer, setConfirmDefer] = useState(false);
  const deferTriggerRef = useRef<HTMLButtonElement>(null);
  const tested = controller.playbackCompleted;
  const continueBusy = navigationBusy || controller.operationBusy;
  const cancelDefer = () => {
    setConfirmDefer(false);
    window.setTimeout(() => focusMicrophoneDeferTrigger(deferTriggerRef.current), 0);
  };
  return (
    <section className="setup-card" aria-labelledby="microphone-setup-title">
      <header>
        <span>Step 2 of 6</span>
        <h1 id="microphone-setup-title" tabIndex={-1}>Set up your microphone</h1>
        <p>Choose the device Candor should prefer, check its live level, then listen to a five-second local sample.</p>
      </header>
      <div inert={confirmDefer ? true : undefined} aria-hidden={confirmDefer ? true : undefined}>
        <MicrophoneSetupControl controller={controller} consentReady={consentReady} />
      </div>
      <div className="setup-actions">
        <button className="secondary-button" type="button" onClick={onBack} disabled={navigationBusy || confirmDefer}>Back</button>
        <button ref={deferTriggerRef} className="text-button" type="button" onClick={() => setConfirmDefer(true)} disabled={navigationBusy || confirmDefer} aria-expanded={confirmDefer} aria-controls="microphone-defer-confirmation">Set up later</button>
        <button className="primary-button" type="button" onClick={onContinue} disabled={!tested || continueBusy || confirmDefer}>Continue</button>
      </div>
      {confirmDefer ? (
        <MicrophoneDeferConfirmation busy={navigationBusy} onCancel={cancelDefer} onConfirm={onDefer} />
      ) : null}
    </section>
  );
}
