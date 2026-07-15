import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

export interface MotionTranscriptSegment {
  id: string;
  speaker: string;
  startMs: number;
  channel: string;
  text: string;
}

export interface EvidenceMarker {
  id: string;
  timeMs: number;
  label: string;
  kind: "transcript" | "note" | "decision" | "action";
}

interface EvidenceTimelineProps {
  active: boolean;
  durationMs: number;
  audioUrl: string;
  markers: EvidenceMarker[];
  canMark: boolean;
  onLoadAudio(): void;
  onMarkMoment(timeMs: number): void;
}

const WAVEFORM_HEIGHTS = [
  12, 24, 38, 18, 30, 44, 23, 36, 15, 28, 41, 20, 34, 46, 25, 39,
  17, 31, 43, 22, 35, 14, 29, 42, 19, 33, 45, 24, 37, 16, 30, 40, 21,
  34, 13, 27, 39, 18, 32, 15, 25, 36, 19, 31, 14, 28, 38, 17, 30, 12,
  24, 34, 16, 27, 37, 20, 32, 14, 26, 35, 18, 29, 13, 23,
];

export function formatClock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

export function VerificationText({ value }: { value: string }) {
  return <strong className="verification-text">{value}</strong>;
}

export function FadePanel({ children, panelKey }: { children: ReactNode; panelKey: string }) {
  return <div className="motion-fade-panel" key={panelKey}>{children}</div>;
}

export function AnimatedTranscript({
  segments,
  emptyMessage,
}: {
  segments: MotionTranscriptSegment[];
  emptyMessage: string;
}) {
  if (!segments.length) return <p className="empty-state">{emptyMessage}</p>;
  return (
    <div className="transcript-stream" role="region" aria-label="Transcript segments" tabIndex={0}>
      {segments.map((segment, index) => (
        <article
          className="transcript-entry motion-transcript-entry"
          key={segment.id}
          style={{ "--entry-index": Math.min(index, 8) } as CSSProperties}
        >
          <span className={`speaker-avatar speaker-${index % 4}`} aria-hidden="true">
            {segment.speaker.slice(0, 1).toUpperCase()}
          </span>
          <div>
            <div className="transcript-meta">
              <strong>{segment.speaker}</strong>
              <span>{formatClock(segment.startMs)}</span>
              <span>{segment.channel}</span>
            </div>
            <p>{segment.text}</p>
          </div>
        </article>
      ))}
    </div>
  );
}

function SparkButton({ disabled, onActivate }: { disabled: boolean; onActivate(): void }) {
  const [burst, setBurst] = useState(0);
  return (
    <button
      type="button"
      className="mark-moment-button"
      disabled={disabled}
      onClick={() => {
        setBurst((value) => value + 1);
        onActivate();
      }}
    >
      Mark moment
      {burst > 0 ? (
        <span className="spark-burst" key={burst} aria-hidden="true">
          {Array.from({ length: 8 }, (_, index) => (
            <i key={index} style={{ transform: `rotate(${index * 45}deg)` }} />
          ))}
        </span>
      ) : null}
    </button>
  );
}

export function EvidenceTimeline({
  active,
  durationMs,
  audioUrl,
  markers,
  canMark,
  onLoadAudio,
  onMarkMoment,
}: EvidenceTimelineProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [currentMs, setCurrentMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const maxMs = Math.max(1, durationMs);

  useEffect(() => {
    if (active) setCurrentMs(durationMs);
  }, [active, durationMs]);

  useEffect(() => {
    setPlaying(false);
    setCurrentMs(0);
  }, [audioUrl]);

  function seek(nextMs: number) {
    const clamped = Math.min(maxMs, Math.max(0, nextMs));
    setCurrentMs(clamped);
    if (audioRef.current && Number.isFinite(audioRef.current.duration)) {
      audioRef.current.currentTime = clamped / 1000;
    }
  }

  async function togglePlayback() {
    if (!audioRef.current || !audioUrl) return;
    try {
      if (audioRef.current.paused) {
        await audioRef.current.play();
      } else {
        audioRef.current.pause();
      }
    } catch {
      setPlaying(false);
    }
  }

  return (
    <section className="compact-waveform evidence-timeline" aria-label="Audio evidence timeline">
      <div className="waveform-heading">
        <span>{active ? "Live timeline" : "Meeting timeline"}</span>
        <strong>{formatClock(durationMs)}</strong>
      </div>
      <div className="timeline-visual">
        <div className="waveform-bars" aria-hidden="true">
          {WAVEFORM_HEIGHTS.map((height, index) => (
            <span
              key={`${height}-${index}`}
              className={active || index / WAVEFORM_HEIGHTS.length <= currentMs / maxMs ? "captured" : "pending"}
              style={{ height: `${height}px` }}
            />
          ))}
        </div>
        <input
          className="evidence-range"
          type="range"
          min="0"
          max={maxMs}
          value={Math.min(maxMs, currentMs)}
          aria-label="Seek local audio evidence"
          onChange={(event) => seek(Number(event.target.value))}
        />
        <div className="evidence-markers" aria-label="Timestamp evidence markers">
          {markers.map((marker) => (
            <button
              type="button"
              className={`evidence-marker ${marker.kind}`}
              key={marker.id}
              style={{ left: `${Math.min(100, Math.max(0, (marker.timeMs / maxMs) * 100))}%` }}
              onClick={() => seek(marker.timeMs)}
              aria-label={`${marker.label} at ${formatClock(marker.timeMs)}`}
              title={`${marker.label}, ${formatClock(marker.timeMs)}`}
            />
          ))}
        </div>
      </div>
      <div className="evidence-controls">
        {audioUrl ? (
          <button type="button" onClick={() => void togglePlayback()}>{playing ? "Pause" : "Play"}</button>
        ) : active ? null : (
          <button type="button" onClick={onLoadAudio} disabled={!canMark}>Load audio</button>
        )}
        <SparkButton disabled={!canMark} onActivate={() => onMarkMoment(currentMs)} />
        <span>{formatClock(currentMs)}</span>
      </div>
      {audioUrl ? (
        <audio
          ref={audioRef}
          src={audioUrl}
          onTimeUpdate={(event) => setCurrentMs(event.currentTarget.currentTime * 1000)}
          onPause={() => setPlaying(false)}
          onPlay={() => setPlaying(true)}
          onEnded={() => setPlaying(false)}
        />
      ) : null}
    </section>
  );
}
