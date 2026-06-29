import { useState } from "react";
import { ScalesLogo } from "./ScalesLogo";

interface NamePromptProps {
  initial?: string;
  /** When true this is an edit (show Cancel); otherwise it's first-run onboarding. */
  canCancel?: boolean;
  onSubmit: (name: string) => void;
  onCancel?: () => void;
}

export function NamePrompt({ initial = "", canCancel = false, onSubmit, onCancel }: NamePromptProps) {
  const [name, setName] = useState(initial);
  const submit = () => {
    if (name.trim()) onSubmit(name.trim());
  };

  return (
    <div className="modal-backdrop" onClick={canCancel ? onCancel : undefined}>
      <div className="modal-card name-card" onClick={(e) => e.stopPropagation()}>
        <div className="name-body">
          <ScalesLogo size="lg" />
          <h1 className="name-title">{canCancel ? "Your name" : "Welcome to Candor"}</h1>
          <p className="name-sub">
            {canCancel
              ? "Update how Candor greets you."
              : "Private, on-device meeting transcription. What should we call you?"}
          </p>
          <input
            className="modal-input name-input"
            value={name}
            placeholder="Your name"
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
          <div className="modal-actions name-actions">
            {canCancel && (
              <button className="btn-ghost" onClick={onCancel}>
                Cancel
              </button>
            )}
            <button className="btn-primary" disabled={!name.trim()} onClick={submit}>
              {canCancel ? "Save" : "Continue"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
