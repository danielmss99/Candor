import { useCallback, useEffect, useRef, useState } from "react";
import type { View } from "../App";
import { useLiveSpeech } from "../useLiveSpeech";
import { WaveformScrubber } from "../components/WaveformScrubber";
import type { LiveBookmark, LiveHighlight, MeetingMoments } from "../v2/metadata";

interface LiveProps {
  timeLabel: string;
  sessionNotes: string;
  onSessionNotesChange: (notes: string) => void;
  recording: boolean;
  error: string | null;
  onNavigate: (view: View) => void;
  moments: MeetingMoments;
  onMomentsChange: (moments: MeetingMoments) => void;
  onBookmark?: () => void;
}

type LivePanelTab = "notes" | "transcript";

const CHIP_PREFIX = {
  decision: "✓ Decision:",
  action: "→ Action:",
  question: "? Question:",
};

export function Live({
  timeLabel,
  sessionNotes,
  onSessionNotesChange,
  recording,
  error,
  onNavigate,
  moments,
  onMomentsChange,
  onBookmark,
}: LiveProps) {
  const timeRef = useRef(timeLabel);
  timeRef.current = timeLabel;
  const [panelTab, setPanelTab] = useState<LivePanelTab>("transcript");

  const { segments: liveSegments, interim, supported, speechError } = useLiveSpeech(
    recording,
    () => timeRef.current,
  );

  const transcriptEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [liveSegments, interim]);

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
      </header>

      <div className="live-inline-card">
        <nav className="live-inline-tabs" aria-label="Recording panels">
          <button
            type="button"
            className={`live-inline-tab ${panelTab === "notes" ? "live-inline-tab--active" : ""}`}
            onClick={() => setPanelTab("notes")}
          >
            Notes
          </button>
          <button
            type="button"
            className={`live-inline-tab ${panelTab === "transcript" ? "live-inline-tab--active" : ""}`}
            onClick={() => setPanelTab("transcript")}
          >
            Transcript
          </button>
        </nav>

        {panelTab === "transcript" ? (
          <main className="live-transcript live-transcript--inline">
            {error ? (
              <div className="transcript-state transcript-state--error">⚠ {error}</div>
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
            ) : (
              <div className="transcript-state">Press record to start a transcript.</div>
            )}
            <div ref={transcriptEndRef} />
          </main>
        ) : (
          <aside className="live-notes live-notes--inline">
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
        )}
      </div>
    </div>
  );
}
