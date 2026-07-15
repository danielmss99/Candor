interface RecordActionProps {
  active: boolean;
  captureLabel: string;
  disabled: boolean;
  variant: "sidebar" | "dashboard";
  onClick(): void;
}

export function RecordGlyph({ active = false }: { active?: boolean }) {
  return (
    <span className={`record-glyph ${active ? "active" : ""}`} aria-hidden="true">
      <span />
    </span>
  );
}

export function RecordAction({ active, captureLabel, disabled, variant, onClick }: RecordActionProps) {
  const title = active ? "Stop recording" : "Start recording";
  const detail = active ? "Save local audio" : captureLabel;
  const variantClassName = variant === "sidebar" ? "sidebar-record-action" : "dashboard-record-action";

  return (
    <button
      className={`record-action ${variantClassName}`}
      data-state={active ? "recording" : "idle"}
      type="button"
      aria-label={active ? "Stop recording and save local audio" : `Start recording, ${captureLabel}`}
      onClick={onClick}
      disabled={disabled}
    >
      <RecordGlyph active={active} />
      <span className="record-action__copy">
        <strong>{title}</strong>
        <small>{detail}</small>
      </span>
    </button>
  );
}
