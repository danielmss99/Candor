import { useCallback, useEffect, useRef } from "react";
import type { TranscriptSegment, View } from "../App";
import { useLiveSpeech } from "../useLiveSpeech";
import { WaveformScrubber } from "../components/WaveformScrubber";
import type { LiveBookmark, LiveHighlight, MeetingMoments } from "../v2/metadata";

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
  moments: MeetingMoments;
  onMomentsChange: (moments: MeetingMoments) => void;
  onBookmark?: () => void;
}

const CHIP_PREFIX = {
  decision: "✓ Decision:",
  action: "→ Action:",
  question: "? Question:",
};

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
  moments,
  onMomentsChange,
  onBookmark,
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

  const appendChip = useCallback(
    (kind: keyof typeof CHIP_PREFIX) => {
      const line = `\n${CHIP_PREFIX[kind]} `;
      onSessionNotesChange(sessionNotes + line);
    },
    [sessionNotes, onSessionNotesChange],
  );

  const addHighlight = useCallback(
    (text: string, time: string) => {
      const next: LiveHighlight = { time, text: text.slice(0, 200) };
      onMomentsChange({
        ...moments,
        highlights: [...moments.highlights, next],
      });
    },
    [moments, onMomentsChange],
  );

  const addBookmark = useCallback(() => {
    const next: LiveBookmark = { time: timeLabel };
    onMomentsChange({
      ...moments,
      bookmarks: [...moments.bookmarks, next],
    });
    onBookmark?.();
  }, [timeLabel, moments, onMomentsChange, onBookmark]);

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        addBookmark();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [recording, addBookmark]);

  const showLive = recording && (liveSegments.length > 0 || interim);
  const showFinal = !recording && !transcribing && transcript && transcript.length > 0;
  const waveProgress = recording ? (parseInt(timeLabel.split(":")[1] || "0", 10) % 60) / 60 : 0;

  return (
    <div className="screen live">
      <header className="live-header">
        <button className="btn-back" onClick={() => onNavigate("library")}>
          ← Meetings
        </button>
        <span className="live-title">
          {recording ? (
            <>
              <span className="rec-dot" /> Recording
            </>
          ) : transcribing ? (
            "Transcribing…"
          ) : (
            "Live meeting"
          )}
        </span>
        <div className="waveform" style={{ flex: 1, maxWidth: 280 }}>
          <WaveformScrubber progress={waveProgress} onSeek={() => {}} disabled={!recording} />
        </div>
        <div className="timer-pill">
          {recording && <span className="timer-dot" />}
          <span className="timer-text">{timeLabel}</span>
        </div>
        {recording && (
          <button type="button" className="btn-ghost" onClick={addBookmark} title="Bookmark (⌘⇧B)">
            🔖
          </button>
        )}
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
              <div className="transcript-kicker kicker--calm">Final transcript · Whisper</div>
              {transcript!.map((s, i) => (
                <div key={i} className="real-seg">
                  <span className="real-seg-time">{s.time}</span>
                  <p className="real-seg-text">{s.text}</p>
                </div>
              ))}
            </>
          ) : recording ? (
            <>
              <div className="transcript-kicker kicker--calm">
                Live transcript
                {supported ? " · updating as you speak" : " · enable mic for captions"}
              </div>
              {speechError && (
                <div className="transcript-hint transcript-hint--warn">{speechError}</div>
              )}
              {liveSegments.map((s, i) => (
                <div key={i} className="real-seg real-seg--live">
                  <span className="real-seg-time">{s.time}</span>
                  <p className="real-seg-text">
                    {s.text}
                    <button
                      type="button"
                      className="seg-highlight-btn"
                      onClick={() => addHighlight(s.text, s.time)}
                      aria-label="Highlight moment"
                    >
                      ⭐
                    </button>
                  </p>
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
            <span className="section-label section-label--calm">My notes</span>
            <span className="live-notes-hint">Saved with this recording</span>
          </div>
          <div className="live-chips">
            <button type="button" className="live-chip live-chip--decision" onClick={() => appendChip("decision")}>
              Decision
            </button>
            <button type="button" className="live-chip live-chip--action" onClick={() => appendChip("action")}>
              Action
            </button>
            <button type="button" className="live-chip live-chip--question" onClick={() => appendChip("question")}>
              Question
            </button>
          </div>
          <textarea
            className="live-notes-input"
            placeholder="Jot down decisions, action items, or reminders…"
            value={sessionNotes}
            onChange={(e) => onSessionNotesChange(e.target.value)}
            spellCheck
          />
          {(moments.bookmarks.length > 0 || moments.highlights.length > 0) && (
            <div className="bookmarks-list">
              <span className="section-label section-label--calm">Moments</span>
              {moments.bookmarks.map((b, i) => (
                <div key={`b-${i}`} className="bookmark-row">
                  🔖 {b.time}
                </div>
              ))}
              {moments.highlights.map((h, i) => (
                <div key={`h-${i}`} className="bookmark-row">
                  ⭐ {h.time} — {h.text.slice(0, 40)}…
                </div>
              ))}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
