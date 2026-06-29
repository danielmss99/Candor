import { useCallback, useEffect, useRef, useState } from "react";
import type { TranscriptSegment } from "../App";
import { WaveformScrubber } from "./WaveformScrubber";

function parseTime(time: string): number {
  const parts = time.split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

interface AudioPlayerProps {
  audioUrl: string | null;
  transcript: TranscriptSegment[];
  activeIndex: number | null;
  onActiveIndexChange: (index: number | null) => void;
  onSeek?: (seconds: number) => void;
}

export function AudioPlayer({
  audioUrl,
  transcript,
  activeIndex,
  onActiveIndexChange,
  onSeek,
}: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);

  const seekTo = useCallback(
    (seconds: number) => {
      const el = audioRef.current;
      if (!el) return;
      el.currentTime = seconds;
      setCurrent(seconds);
      onSeek?.(seconds);
      const idx = transcript.findIndex((seg, i) => {
        const t = parseTime(seg.time);
        const next = transcript[i + 1] ? parseTime(transcript[i + 1].time) : Infinity;
        return seconds >= t && seconds < next;
      });
      onActiveIndexChange(idx >= 0 ? idx : null);
    },
    [transcript, onActiveIndexChange, onSeek],
  );

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onTime = () => {
      const t = el.currentTime;
      setCurrent(t);
      const idx = transcript.findIndex((seg, i) => {
        const start = parseTime(seg.time);
        const end = transcript[i + 1] ? parseTime(transcript[i + 1].time) : Infinity;
        return t >= start && t < end;
      });
      if (idx >= 0 && idx !== activeIndex) onActiveIndexChange(idx);
    };
    const onMeta = () => setDuration(el.duration || 0);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("loadedmetadata", onMeta);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
    };
  }, [transcript, activeIndex, onActiveIndexChange]);

  if (!audioUrl) {
    return (
      <div className="audio-player audio-player--stub">
        <WaveformScrubber progress={0} onSeek={() => {}} disabled />
        <span className="audio-player-hint">Audio playback available when recording is saved</span>
      </div>
    );
  }

  return (
    <div className="audio-player">
      {audioUrl && <audio ref={audioRef} src={audioUrl} preload="metadata" />}
      <div className="audio-player-controls">
        <button
          type="button"
          className="audio-play-btn"
          onClick={() => {
            const el = audioRef.current;
            if (!el) return;
            if (playing) el.pause();
            else void el.play();
          }}
          aria-label={playing ? "Pause" : "Play"}
        >
          {playing ? "❚❚" : "▶"}
        </button>
        <span className="audio-time">
          {formatTime(current)} / {formatTime(duration)}
        </span>
      </div>
      <WaveformScrubber
        progress={duration > 0 ? current / duration : 0}
        onSeek={(pct) => seekTo(pct * (duration || 1))}
      />
    </div>
  );
}

export { parseTime, formatTime as formatAudioTime };
