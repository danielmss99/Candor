import { useRef } from "react";

const BARS = 48;

interface WaveformScrubberProps {
  progress: number;
  onSeek: (progress: number) => void;
  disabled?: boolean;
}

export function WaveformScrubber({ progress, onSeek, disabled }: WaveformScrubberProps) {
  const trackRef = useRef<HTMLDivElement>(null);

  const handleClick = (e: React.MouseEvent) => {
    if (disabled || !trackRef.current) return;
    const rect = trackRef.current.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    onSeek(pct);
  };

  return (
    <div
      ref={trackRef}
      className={`waveform-scrubber ${disabled ? "waveform-scrubber--disabled" : ""}`}
      onClick={handleClick}
      role="slider"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(progress * 100)}
      aria-label="Audio position"
    >
      {Array.from({ length: BARS }).map((_, i) => {
        const h = 6 + ((i * 7 + 3) % 18);
        const played = i / BARS <= progress;
        return (
          <span
            key={i}
            className={`waveform-bar ${played ? "waveform-bar--played" : ""}`}
            style={{ height: h }}
          />
        );
      })}
      <div className="waveform-playhead" style={{ left: `${progress * 100}%` }} />
    </div>
  );
}
