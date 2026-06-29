import { useEffect, useRef } from "react";
import type { TranscriptSegment, View } from "../App";
import { useLiveSpeech } from "../useLiveSpeech";

interface LiveProps {
  timeLabel: string;
  transcript: TranscriptSegment[] | null;
  sessionNotes: string;
  onSessionNotesChange: (notes: string) => void;
  recording: boolean;
  transcribing: boolean;
  error: string | null;
  onNavigate: (view: View) => void;
  onWrapUp: () => void;
}

// [height(px), opacity] for the 20-bar header waveform.
const WAVE: [number, number][] = [
  [8, 0.5], [16, 0.7], [22, 1], [12, 0.6], [24, 1], [9, 0.5], [18, 0.8], [26, 1],
  [14, 0.6], [20, 0.9], [7, 0.4], [17, 0.7], [25, 1], [11, 0.6], [21, 0.9], [13, 0.6],
  [23, 1], [8, 0.5], [19, 0.8], [15, 0.7],
];

export function Live({
  timeLabel,
  transcript,
  sessionNotes,
  onSessionNotesChange,
  recording,
  transcribing,
  error,
  onNavigate,
  onWrapUp,
}: LiveProps) {
  const timeRef = useRef(timeLabel);
  timeRef.current = timeLabel;

  const { segments: liveSegments, interim, supported, speechError } = useLiveSpeech(
    recording,
    () => timeRef.current,
  );

  const transcriptEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [liveSegments, interim, transcript]);

  const showLive = recording && (liveSegments.length > 0 || interim);
  const showFinal = !recording && !transcribing && transcript && transcript.length > 0;

  return (
    <div className="screen live">
      <header className="live-header">
        <button className="btn-back" onClick={() => onNavigate("library")}>
          ← Meetings
        </button>
        <span className="live-title">
          {recording ? "Recording" : transcribing ? "Transcribing…" : "Live meeting"}
        </span>
        <div className="waveform">
          {WAVE.map(([h, o], i) => (
            <span
              key={i}
              style={{
                width: 2.5,
                height: h,
                background: "var(--coral)",
                opacity: recording ? o : o * 0.4,
              }}
            />
          ))}
        </div>
        <div className="timer-pill">
          {recording && <span className="timer-dot" />}
          <span className="timer-text">{timeLabel}</span>
        </div>
        {!recording && !transcribing && (
          <button className="btn-wrapup" onClick={onWrapUp}>
            Wrap up
          </button>
        )}
      </header>

      <div className="live-body live-body--two-col">
        <main className="live-transcript">
          {transcribing ? (
            <div className="transcript-state">
              <span className="listening-dot" />
              Transcribing your recording on this device…
            </div>
          ) : error ? (
            <div className="transcript-state transcript-state--error">⚠ {error}</div>
          ) : showFinal ? (
            <>
              <div className="transcript-kicker">FINAL TRANSCRIPT · Whisper</div>
              {transcript!.map((s, i) => (
                <div key={i} className="real-seg">
                  <span className="real-seg-time">{s.time}</span>
                  <p className="real-seg-text">{s.text}</p>
                </div>
              ))}
            </>
          ) : recording ? (
            <>
              <div className="transcript-kicker">
                LIVE TRANSCRIPT
                {supported ? " · updating as you speak" : " · enable mic access for captions"}
              </div>
              {speechError && (
                <div className="transcript-hint transcript-hint--warn">{speechError}</div>
              )}
              {!supported && (
                <div className="transcript-hint">
                  Live captions aren&apos;t available here — you&apos;ll get the full transcript
                  when you stop recording.
                </div>
              )}
              {liveSegments.map((s, i) => (
                <div key={i} className="real-seg real-seg--live">
                  <span className="real-seg-time">{s.time}</span>
                  <p className="real-seg-text">{s.text}</p>
                </div>
              ))}
              {interim && (
                <div className="real-seg real-seg--interim">
                  <span className="real-seg-time">{timeLabel}</span>
                  <p className="real-seg-text">
                    {interim}
                    <span className="cursor" />
                  </p>
                </div>
              )}
              {!showLive && supported && !speechError && (
                <div className="transcript-state">
                  <span className="listening-dot" />
                  Listening… start speaking to see words appear here.
                </div>
              )}
            </>
          ) : transcript && transcript.length === 0 ? (
            <div className="transcript-state">No speech detected in this recording.</div>
          ) : (
            <div className="transcript-state">Press record to start a transcript.</div>
          )}
          <div ref={transcriptEndRef} />
        </main>

        <aside className="live-notes">
          <div className="live-notes-head">
            <span className="section-label">MY NOTES</span>
            <span className="live-notes-hint">Saved with this recording</span>
          </div>
          <textarea
            className="live-notes-input"
            placeholder="Jot down decisions, action items, or reminders…"
            value={sessionNotes}
            onChange={(e) => onSessionNotesChange(e.target.value)}
            spellCheck
          />
        </aside>
      </div>
    </div>
  );
}
