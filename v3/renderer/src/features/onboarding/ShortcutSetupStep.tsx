import type { SetupNavigationProps } from "./setup-types";
import { SUGGESTED_SHORTCUT } from "./setup-types";
import type { ShortcutSetupController } from "./useShortcutSetup";

export function acceleratorFromKeyGesture(event: Pick<React.KeyboardEvent<HTMLInputElement>, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">): string {
  const modifiers = [
    event.ctrlKey || event.metaKey ? "CommandOrControl" : "",
    event.altKey ? "Alt" : "",
    event.shiftKey ? "Shift" : "",
  ].filter(Boolean);
  const rawKey = event.key;
  if (["Control", "Meta", "Alt", "Shift"].includes(rawKey) || modifiers.length < 2) return "";
  const key = rawKey === " " ? "Space" : rawKey.length === 1 ? rawKey.toUpperCase() : rawKey;
  return [...modifiers, key].join("+");
}

export interface ShortcutSetupControlProps {
  controller: ShortcutSetupController;
  compact?: boolean;
}

export function ShortcutSetupControl({ controller, compact = false }: ShortcutSetupControlProps) {
  const active = controller.status.enabled && controller.status.registered;
  const conflict = controller.status.enabled && controller.status.conflict && !controller.status.registered;
  const statusTitle = active ? "Shortcut enabled" : conflict ? "Shortcut conflict" : controller.status.enabled ? "Shortcut unavailable" : "Shortcut off";
  const statusCopy = active
    ? `${controller.status.accelerator} opens and focuses Candor's recorder. It never starts recording.`
    : conflict
      ? "That shortcut is unavailable because another application or the operating system may already use it. Choose a different combination or disable it."
      : "Enabling is optional. Candor will not register a global shortcut until you choose to.";
  return (
    <div className="shortcut-setup-control" data-compact={compact}>
      <label className="setup-control-field" htmlFor="candor-global-shortcut">
        <span>Open recorder shortcut</span>
        <input
          id="candor-global-shortcut"
          value={controller.draftAccelerator}
          maxLength={64}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          disabled={controller.saving}
          onChange={(event) => controller.setDraftAccelerator(event.target.value)}
          onKeyDown={(event) => {
            const accelerator = acceleratorFromKeyGesture(event);
            if (!accelerator) return;
            event.preventDefault();
            controller.setDraftAccelerator(accelerator);
          }}
          aria-describedby="candor-shortcut-help"
        />
      </label>
      <p id="candor-shortcut-help" className="setup-help-copy">Focus the field and press at least two modifier keys plus one regular key. Suggested: <kbd>{SUGGESTED_SHORTCUT}</kbd>.</p>
      <p className="setup-runtime-note">Works while Candor is running.</p>

      <div className="setup-device-status" data-state={active ? "ready" : conflict || controller.error ? "retry" : "disabled"} role="status" aria-live="polite">
        <span className={`status-dot ${active ? "ok" : ""}`} aria-hidden="true" />
        <div>
          <strong>{statusTitle}</strong>
          <p>{statusCopy}</p>
        </div>
      </div>

      {controller.error ? <p className="setup-inline-error" role="alert">{controller.error}</p> : null}

      <div className="setup-control-actions">
        <button className="secondary-button" type="button" onClick={() => void controller.enable()} disabled={controller.saving || controller.loading || !controller.draftAccelerator.trim()}>
          {active ? "Save change" : "Enable shortcut"}
        </button>
        {controller.status.enabled ? <button className="text-button" type="button" onClick={() => void controller.disable()} disabled={controller.saving}>Disable</button> : null}
        <button className="text-button" type="button" onClick={() => void controller.reset()} disabled={controller.saving}>Reset suggestion</button>
      </div>

      {active ? (
        <div className="shortcut-test-panel">
          <button className="secondary-button" type="button" onClick={controller.beginTest} aria-pressed={controller.awaitingTest}>Press shortcut to test</button>
          <p role="status" aria-live="polite">
            {controller.testPassed ? "Shortcut received. Candor opened without starting a recording." : controller.awaitingTest ? `Now press ${controller.status.accelerator}.` : "Test it now or continue setup."}
          </p>
        </div>
      ) : null}
    </div>
  );
}

interface ShortcutSetupStepProps extends SetupNavigationProps {
  controller: ShortcutSetupController;
}

export function ShortcutSetupStep({ controller, onBack, onContinue, onDefer, navigationBusy = false }: ShortcutSetupStepProps) {
  const active = controller.status.enabled && controller.status.registered;
  return (
    <section className="setup-card" aria-labelledby="shortcut-setup-title">
      <header>
        <span>Step 3 of 6</span>
        <h1 id="shortcut-setup-title" tabIndex={-1}>Choose a recorder shortcut</h1>
        <p>Optionally open and focus Candor from another application. You still choose when recording starts.</p>
      </header>
      <ShortcutSetupControl controller={controller} />
      <div className="setup-actions">
        <button className="secondary-button" type="button" onClick={onBack} disabled={navigationBusy}>Back</button>
        <button className="text-button" type="button" onClick={onDefer} disabled={navigationBusy}>Skip for now</button>
        <button className="primary-button" type="button" onClick={onContinue} disabled={navigationBusy}>{active ? "Continue" : "Continue without shortcut"}</button>
      </div>
    </section>
  );
}
