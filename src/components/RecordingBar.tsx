export type RecPhase = "preparing" | "countdown" | "recording" | "transcribing";

interface RecordingBarProps {
  phase: RecPhase;
  count: number;
  /** MM:SS or H:MM:SS while recording */
  timeLabel: string;
  /** 0–100 while the model downloads, or null when already present. */
  downloadPct: number | null;
  /** Chunk progress during long transcriptions. */
  transcriptionPct?: number | null;
  onStop: () => void;
  onCancel: () => void;
}

// A small floating bar that stays out of the way so the rest of the app
// remains usable while recording. Never covers the page.
export function RecordingBar({ phase, count, timeLabel, downloadPct, transcriptionPct, onStop, onCancel }: RecordingBarProps) {
  return (
    <div className="rec-bar" role="status">
      {phase === "recording" && (
        <>
          <span className="rec-bar-dot" />
          <span className="rec-bar-time">{timeLabel}</span>
          <span className="rec-bar-label">Recording</span>
          <button className="rec-bar-stop" onClick={onStop}>
            ■ Stop &amp; transcribe
          </button>
        </>
      )}

      {phase === "transcribing" && (
        <>
          <span className="rec-bar-spinner" />
          <span className="rec-bar-label">
            {transcriptionPct != null && transcriptionPct > 0
              ? `Transcribing… ${transcriptionPct}%`
              : "Saving audio & transcribing…"}
          </span>
        </>
      )}

      {phase === "countdown" && (
        <>
          <span className="rec-bar-dot" />
          <span className="rec-bar-label">Recording starts in {count}…</span>
          <button className="rec-bar-cancel" onClick={onCancel}>
            Cancel
          </button>
        </>
      )}

      {phase === "preparing" && (
        <>
          <span className="rec-bar-spinner" />
          <span className="rec-bar-label">
            {downloadPct === null ? "Preparing…" : `Downloading speech model… ${downloadPct}%`}
          </span>
          <button className="rec-bar-cancel" onClick={onCancel}>
            Cancel
          </button>
        </>
      )}
    </div>
  );
}
