import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "@tauri-apps/api/core";

const BARS = 32;

interface LiveLevelMeterProps {
  active: boolean;
  /** Fallback pulse when browser speech interim updates (voice activity proxy). */
  voiceActive?: boolean;
}

export function LiveLevelMeter({ active, voiceActive = false }: LiveLevelMeterProps) {
  const [levels, setLevels] = useState<number[]>(() => Array(BARS).fill(0.08));
  const voiceRef = useRef(voiceActive);
  voiceRef.current = voiceActive;

  useEffect(() => {
    if (!active) {
      setLevels(Array(BARS).fill(0.08));
      return;
    }

    if (!isTauri()) {
      let frame = 0;
      const id = window.setInterval(() => {
        frame++;
        const base = voiceRef.current ? 0.35 + Math.random() * 0.45 : 0.06 + Math.random() * 0.08;
        setLevels(
          Array.from({ length: BARS }, (_, i) => {
            const wave = Math.sin(frame * 0.25 + i * 0.45) * 0.15;
            return Math.min(1, Math.max(0.06, base + wave));
          }),
        );
      }, 80);
      return () => window.clearInterval(id);
    }

    let unlisten: (() => void) | undefined;
    listen<number>("audio-level", (e) => {
      const level = Math.min(1, Math.max(0, e.payload));
      setLevels(
        Array.from({ length: BARS }, (_, i) => {
          const center = BARS / 2;
          const dist = Math.abs(i - center) / center;
          const jitter = ((i * 17 + Math.floor(level * 100)) % 7) / 28;
          return Math.min(1, Math.max(0.06, level * (1 - dist * 0.35) + jitter));
        }),
      );
    }).then((fn) => {
      unlisten = fn;
    });

    return () => unlisten?.();
  }, [active]);

  return (
    <div className="live-level-meter" aria-hidden>
      {levels.map((h, i) => (
        <span
          key={i}
          className="live-level-bar"
          style={{ height: `${8 + h * 28}px` }}
        />
      ))}
    </div>
  );
}
