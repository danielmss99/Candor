import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent } from "react";
import { Mic, ShieldCheck, X } from "lucide-react";

interface RecorderPanelProps {
  open: boolean;
  activeCapture: boolean;
  combinedCaptureAvailable: boolean;
  disabled: boolean;
  recordingBlocked: boolean;
  recordingTitle: string;
  onRecordingTitleChange(value: string): void;
  onStart(): void;
  onClose(): void;
}

export function RecorderPanel({
  open,
  activeCapture,
  combinedCaptureAvailable,
  disabled,
  recordingBlocked,
  recordingTitle,
  onRecordingTitleChange,
  onStart,
  onClose,
}: RecorderPanelProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const timer = window.setTimeout(() => {
      if (activeCapture) dialogRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
      else titleRef.current?.focus();
    }, 0);
    return () => {
      window.clearTimeout(timer);
      const destination = restoreFocusRef.current;
      if (destination?.isConnected) destination.focus();
      restoreFocusRef.current = null;
    };
  }, [activeCapture, open]);

  if (!open) return null;

  const closeFromBackdrop = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onClose();
  };
  const handleDialogKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) ?? [])];
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const startDisabled = disabled || recordingBlocked || activeCapture;
  const sourceLabel = combinedCaptureAvailable ? "Microphone and system audio" : "Microphone audio";

  return (
    <div className="recorder-dialog-backdrop" onMouseDown={closeFromBackdrop}>
      <section
        ref={dialogRef}
        className="recorder-dialog"
        data-recorder-dialog
        role="dialog"
        aria-modal="true"
        aria-labelledby="recorder-dialog-title"
        aria-describedby="recorder-dialog-description"
        onKeyDown={handleDialogKeyDown}
      >
        <header>
          <div className="recorder-dialog-icon" aria-hidden="true"><Mic size={20} /></div>
          <div>
            <h2 id="recorder-dialog-title">Ready to record</h2>
            <p id="recorder-dialog-description">Review the meeting name, then start capture when you are ready.</p>
          </div>
          <button type="button" className="icon-button" aria-label="Close recorder" onClick={onClose}><X size={17} aria-hidden="true" /></button>
        </header>

        {activeCapture ? (
          <div className="recorder-dialog-state" role="status">
            <strong>A recording is already active</strong>
            <span>Use the meeting controls to review or stop the current capture.</span>
          </div>
        ) : (
          <>
            <label className="recorder-title-field">
              <span>Meeting name</span>
              <input
                ref={titleRef}
                value={recordingTitle}
                maxLength={120}
                onChange={(event) => onRecordingTitleChange(event.target.value)}
                autoComplete="off"
              />
            </label>
            <div className="recorder-source-summary">
              <span><ShieldCheck size={17} aria-hidden="true" /></span>
              <div><strong>{sourceLabel}</strong><small>Capture stays local. Opening this panel never starts recording.</small></div>
            </div>
            {recordingBlocked ? <p className="recorder-dialog-warning" role="alert">Recording is unavailable until the local storage warning is resolved.</p> : null}
          </>
        )}

        <footer>
          <button type="button" onClick={onClose}>Cancel</button>
          {!activeCapture ? <button type="button" className="primary-button" disabled={startDisabled} onClick={onStart}>Start recording</button> : null}
        </footer>
      </section>
    </div>
  );
}
