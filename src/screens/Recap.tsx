import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { isTauri } from "@tauri-apps/api/core";
import type { TranscriptSegment, View } from "../App";
import { Avatar } from "../components/Avatar";
import { AudioPlayer, parseTime } from "../components/AudioPlayer";
import { KeywordCloud } from "../components/KeywordCloud";
import type { RecapData } from "../data/mock";
import { getRecapForMeeting, people } from "../data/mock";
import {
  downloadRecapPreset,
  shareRecapSummary,
  type ExportPreset,
} from "../export";
import { askMeeting, type AskCitation } from "../v2/askMeeting";
import { generateRecapFromRecording } from "../recapGenerate";
import { loadSummaryTemplate } from "../v2/summaryTemplates";
import { useUser } from "../user";
import type { CompletedAction } from "../api/actions";
import { resolveActionId } from "../api/actions";
import { loadMeetingDetail } from "../api/local";
import {
  loadMoments,
  loadRecapEdits,
  loadSpeakerLabels,
  saveMoments,
  saveRecapEdits,
  saveSpeakerLabel,
  type LiveHighlight,
} from "../v2/metadata";
import { buildOutline, extractTopTerms } from "../v2/keywords";

interface RecapProps {
  meetingId: string;
  recapData?: RecapData | null;
  transcript?: TranscriptSegment[];
  jumpTimestamp: string | null;
  onNavigate: (view: View) => void;
  completedIds: Set<string>;
  onCompleteAction: (item: Omit<CompletedAction, "completedAt">) => void;
  onRecapReviewed?: () => void;
  canRename?: boolean;
  onRename?: () => void;
}

type MainTab = "summary" | "transcript";
type RailTab = "ask" | "chapters" | "moments" | "tasks";

function ownerAvatar(owner: string) {
  if (owner in people) {
    return { who: owner as keyof typeof people };
  }
  return { label: owner.slice(0, 2).toUpperCase(), bg: "var(--coral)", fg: "var(--coral-on)" };
}

function renderSummary(text: string) {
  return text.split("**").map((seg, i) =>
    i % 2 === 1 ? (
      <strong key={i} className="summary-strong">
        {seg}
      </strong>
    ) : (
      <span key={i}>{seg}</span>
    ),
  );
}

export function Recap({
  meetingId,
  recapData,
  transcript: transcriptProp,
  jumpTimestamp,
  onNavigate,
  completedIds,
  onCompleteAction,
  onRecapReviewed,
  canRename,
  onRename,
}: RecapProps) {
  const recap = useMemo(
    () => recapData ?? getRecapForMeeting(meetingId),
    [recapData, meetingId],
  );
  const edits = useMemo(() => loadRecapEdits(meetingId), [meetingId]);
  const [summary, setSummary] = useState(edits.summary ?? recap.summary);
  const [decisions, setDecisions] = useState(edits.decisions ?? recap.decisions);
  const [editingSummary, setEditingSummary] = useState(false);
  const [editingDecision, setEditingDecision] = useState<number | null>(null);
  const [mainTab, setMainTab] = useState<MainTab>("summary");
  const [railTab, setRailTab] = useState<RailTab>("ask");
  const [transcript, setTranscript] = useState<TranscriptSegment[]>(transcriptProp ?? []);
  const [speakerLabels, setSpeakerLabels] = useState(() => loadSpeakerLabels(meetingId));
  const [moments, setMoments] = useState(() => loadMoments(meetingId));
  const [activeSeg, setActiveSeg] = useState<number | null>(null);
  const [askQuery, setAskQuery] = useState("");
  const [askAnswer, setAskAnswer] = useState<string | null>(null);
  const [askCitations, setAskCitations] = useState<AskCitation[]>([]);
  const [shareStatus, setShareStatus] = useState<string | null>(null);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const { initials } = useUser();
  const [activeChapter, setActiveChapter] = useState<string | null>(jumpTimestamp);
  const highlightRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});

  useEffect(() => {
    onRecapReviewed?.();
  }, [meetingId, onRecapReviewed]);

  useEffect(() => {
    setSummary(edits.summary ?? recap.summary);
    setDecisions(edits.decisions ?? recap.decisions);
    setSpeakerLabels(loadSpeakerLabels(meetingId));
    setMoments(loadMoments(meetingId));
    setAskQuery("");
    setAskAnswer(null);
    setAskCitations([]);
    setAudioUrl(null);
    setActiveChapter(jumpTimestamp);
    if (transcriptProp) setTranscript(transcriptProp);
    else {
      loadMeetingDetail(meetingId).then((d) => {
        if (d?.transcript) {
          setTranscript(d.transcript);
          d.transcript.forEach((seg, i) => {
            if (seg.speaker) saveSpeakerLabel(meetingId, i, seg.speaker);
          });
        }
        if (d?.audioPath && isTauri()) {
          setAudioUrl(convertFileSrc(d.audioPath));
        } else if (isTauri()) {
          invoke<string | null>("get_meeting_audio_path", { id: meetingId })
            .then((p) => {
              if (p) setAudioUrl(convertFileSrc(p));
            })
            .catch(() => {});
        }
      });
    }
  }, [meetingId, recap, edits, jumpTimestamp, transcriptProp]);

  useEffect(() => {
    if (jumpTimestamp && highlightRef.current) {
      highlightRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [jumpTimestamp, meetingId]);

  const openActions = useMemo(
    () =>
      recap.actions
        .map((a, i) => ({
          ...a,
          id: resolveActionId(meetingId, i, a.text, recap.title),
        }))
        .filter((a) => !completedIds.has(a.id)),
    [recap.actions, recap.title, meetingId, completedIds],
  );

  const outline = useMemo(
    () => edits.outline ?? buildOutline(recap.chapters, transcript),
    [edits.outline, recap.chapters, transcript],
  );

  const keywords = useMemo(
    () => extractTopTerms(transcript.map((s) => s.text).join(" ")),
    [transcript],
  );

  const allMoments: LiveHighlight[] = useMemo(
    () => [
      ...moments.highlights,
      { time: recap.highlight.by.split("·").pop()?.trim() ?? recap.chapters[0]?.time ?? "00:00", text: recap.highlight.quote },
    ],
    [moments.highlights, recap],
  );

  const persistEdits = useCallback(
    (patch: { summary?: string; decisions?: string[] }) => {
      const next = { ...loadRecapEdits(meetingId), ...patch };
      saveRecapEdits(meetingId, next);
    },
    [meetingId],
  );

  const submitAsk = (question: string) => {
    const q = question.trim();
    if (!q) return;
    setAskQuery(q);
    const result = askMeeting({ ...recap, summary, decisions }, transcript, q);
    setAskAnswer(result.answer);
    setAskCitations(result.citations);
  };

  const regenerateSummary = () => {
    const next = generateRecapFromRecording({
      transcript,
      sessionNotes: "",
      durationSeconds: 0,
      recordedAt: new Date(),
      userInitials: initials,
      titleOverride: recap.title,
      template: loadSummaryTemplate(),
    });
    setSummary(next.summary);
    setDecisions(next.decisions);
    persistEdits({ summary: next.summary, decisions: next.decisions });
  };

  const exportClip = async (h: LiveHighlight) => {
    if (!isTauri()) return;
    const start = parseTime(h.time);
    const end = start + 30;
    const dest = `${h.time.replace(/:/g, "-")}-clip.wav`;
    try {
      await invoke("export_audio_clip", {
        meetingId,
        startSeconds: start,
        endSeconds: end,
        destPath: dest,
      });
      setShareStatus(`Clip saved: ${dest}`);
      window.setTimeout(() => setShareStatus(null), 3000);
    } catch {
      setShareStatus("Could not export clip");
      window.setTimeout(() => setShareStatus(null), 2000);
    }
  };

  const handleShare = async () => {
    const ok = await shareRecapSummary({ ...recap, summary, decisions });
    setShareStatus(ok ? "Copied to clipboard" : "Could not copy");
    window.setTimeout(() => setShareStatus(null), 2000);
  };

  const handleExport = (preset: ExportPreset = "markdown") => {
    downloadRecapPreset({ ...recap, summary, decisions }, preset);
    setExportMenuOpen(false);
    invoke("open_notes_folder").catch(() => {});
  };

  const seekSegment = (index: number) => {
    setActiveSeg(index);
    setMainTab("transcript");
    const el = document.getElementById(`seg-${index}`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const tocItems = [
    { id: "outline", label: "Outline" },
    { id: "summary", label: "Summary" },
    { id: "decisions", label: "Decisions" },
    { id: "tasks", label: "Tasks" },
    ...(transcript.length > 0 ? [{ id: "transcript", label: "Transcript" }] : []),
  ];

  const scrollToSection = (id: string) => {
    if (id === "transcript") {
      setMainTab("transcript");
      return;
    }
    setMainTab("summary");
    sectionRefs.current[id]?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const avatars =
    openActions.length > 0
      ? [...new Set(openActions.map((a) => a.owner))].slice(0, 3)
      : recap.actions.length > 0
        ? [...new Set(recap.actions.map((a) => a.owner))].slice(0, 3)
        : [];

  return (
    <div className="screen recap">
      <header className="recap-header">
        <button className="btn-back" onClick={() => onNavigate("library")}>
          ← Meetings
        </button>
        <div>
          <div className="recap-title">{recap.title}</div>
          <div className="recap-meta">{recap.meta}</div>
        </div>
        {canRename && onRename && (
          <button type="button" className="btn-ghost" onClick={onRename}>
            Rename
          </button>
        )}
        <div className="spacer" />
        <div className="avatar-stack">
          {avatars.length > 0 ? (
            avatars.map((owner, i) => {
              const props = ownerAvatar(owner);
              return (
                <span key={owner} style={{ marginLeft: i === 0 ? 0 : -7 }}>
                  <Avatar {...props} size={26} ring="var(--bg)" />
                </span>
              );
            })
          ) : (
            <Avatar label="You" size={26} ring="var(--bg)" bg="var(--coral)" fg="var(--coral-on)" />
          )}
        </div>
        <button className="btn-ghost" onClick={handleShare}>
          {shareStatus ?? "Share"}
        </button>
        <button className="btn-ghost" onClick={regenerateSummary}>
          Regenerate
        </button>
        <div className="export-dropdown">
          <button className="btn-primary" onClick={() => setExportMenuOpen((o) => !o)}>
            Export ▾
          </button>
          {exportMenuOpen && (
            <div className="export-menu">
              {(
                [
                  ["markdown", "Markdown"],
                  ["slack", "Slack blurb"],
                  ["email", "Email draft"],
                  ["pdf", "HTML (print PDF)"],
                ] as const
              ).map(([id, label]) => (
                <button key={id} type="button" className="export-menu-item" onClick={() => handleExport(id)}>
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
      </header>

      {jumpTimestamp && (
        <div className="jump-banner">
          Jumped to <strong>{jumpTimestamp}</strong> from search
        </div>
      )}

      <AudioPlayer
        audioUrl={audioUrl}
        transcript={transcript}
        activeIndex={activeSeg}
        onActiveIndexChange={setActiveSeg}
        onSeek={(sec) => {
          const idx = transcript.findIndex((seg, i) => {
            const t = parseTime(seg.time);
            const next = transcript[i + 1] ? parseTime(transcript[i + 1].time) : Infinity;
            return sec >= t && sec < next;
          });
          if (idx >= 0) seekSegment(idx);
        }}
      />

      <div className="recap-tabs">
        <button
          type="button"
          className={`recap-tab ${mainTab === "summary" ? "recap-tab--active" : ""}`}
          onClick={() => setMainTab("summary")}
        >
          Summary
        </button>
        <button
          type="button"
          className={`recap-tab ${mainTab === "transcript" ? "recap-tab--active" : ""}`}
          onClick={() => setMainTab("transcript")}
        >
          Transcript {transcript.length > 0 && `· ${transcript.length}`}
        </button>
      </div>

      <div className="recap-body">
        <div className="recap-main">
          {mainTab === "summary" ? (
            <>
              <nav className="recap-toc" aria-label="On this page">
                {tocItems.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="recap-toc-link"
                    onClick={() => scrollToSection(item.id)}
                  >
                    {item.label}
                  </button>
                ))}
              </nav>

              <section ref={(el) => { sectionRefs.current.outline = el; }} id="outline">
                <div className="recap-outline">
                  <span className="section-label section-label--calm">Outline</span>
                  <ul className="recap-outline-list">
                    {outline.map((line, i) => (
                      <li key={i}>{line}</li>
                    ))}
                  </ul>
                </div>
              </section>

              <section ref={(el) => { sectionRefs.current.summary = el; }} id="summary">
                <div className="kicker-row">
                  <span className="kicker kicker--coral kicker--calm">AI summary</span>
                  <span className="kicker-sub">· auto-generated · click to edit</span>
                </div>
                <div
                  className="editable-block"
                  onClick={() => !editingSummary && setEditingSummary(true)}
                >
                  {editingSummary ? (
                    <textarea
                      className="editable-input recap-summary"
                      value={summary}
                      onChange={(e) => setSummary(e.target.value)}
                      onBlur={() => {
                        setEditingSummary(false);
                        persistEdits({ summary });
                      }}
                      autoFocus
                      rows={5}
                    />
                  ) : (
                    <p className="recap-summary">
                      {renderSummary(summary)}
                      <span className="edit-hint">Edit</span>
                    </p>
                  )}
                </div>
              </section>

              <KeywordCloud terms={keywords} onSelect={(w) => submitAsk(`What was said about ${w}?`)} />

              <section ref={(el) => { sectionRefs.current.decisions = el; }} id="decisions">
                <div className="section-label section-label--calm section-label--spaced">
                  Key decisions · {decisions.length}
                </div>
                {decisions.map((d, i) => (
                  <div key={i} className="decision-row editable-block">
                    <span className="check-box">✓</span>
                    {editingDecision === i ? (
                      <input
                        className="editable-input decision-text"
                        value={d}
                        onChange={(e) => {
                          const next = [...decisions];
                          next[i] = e.target.value;
                          setDecisions(next);
                        }}
                        onBlur={() => {
                          setEditingDecision(null);
                          persistEdits({ decisions });
                        }}
                        autoFocus
                      />
                    ) : (
                      <div
                        className="decision-text"
                        onClick={() => setEditingDecision(i)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => e.key === "Enter" && setEditingDecision(i)}
                      >
                        {d}
                        <span className="edit-hint">Edit</span>
                      </div>
                    )}
                  </div>
                ))}
              </section>

              <section ref={(el) => { sectionRefs.current.tasks = el; }} id="tasks">
                <div className="section-label section-label--calm section-label--spaced" style={{ marginTop: 28 }}>
                  Tasks · {openActions.length}
                </div>
                <div className="action-table">
                  {openActions.map((a) => (
                    <div key={a.id} className="action-row">
                      <button
                        type="button"
                        className="checkbox"
                        onClick={() =>
                          onCompleteAction({
                            id: a.id,
                            text: a.text,
                            owner: a.owner,
                            due: a.due,
                            meeting: recap.title,
                            meetingId,
                            soon: a.soon,
                          })
                        }
                        aria-label="Mark done"
                      />
                      <span className="action-task">{a.text}</span>
                      <Avatar {...ownerAvatar(a.owner)} size={22} />
                      <span className={`due-pill ${a.soon ? "due-pill--soon" : ""}`}>{a.due}</span>
                    </div>
                  ))}
                  {openActions.length === 0 && (
                    <div className="recap-empty">
                      {recap.actions.length === 0
                        ? "No tasks for this meeting."
                        : "All tasks completed."}
                    </div>
                  )}
                </div>
              </section>
            </>
          ) : (
            <div className="transcript-panel">
              {transcript.length === 0 ? (
                <div className="recap-empty">No transcript segments for this meeting.</div>
              ) : (
                transcript.map((seg, i) => (
                  <div
                    key={i}
                    id={`seg-${i}`}
                    className={`transcript-seg ${activeSeg === i ? "transcript-seg--active" : ""}`}
                    onClick={() => seekSegment(i)}
                  >
                    <input
                      className="transcript-speaker-input"
                      value={speakerLabels[i] ?? seg.speaker ?? "Speaker"}
                      onChange={(e) => {
                        saveSpeakerLabel(meetingId, i, e.target.value);
                        setSpeakerLabels({ ...speakerLabels, [i]: e.target.value });
                      }}
                      onClick={(e) => e.stopPropagation()}
                      aria-label={`Speaker for segment ${i + 1}`}
                    />
                    <div>
                      <span className="transcript-speaker">{seg.time}</span>
                      <p className="real-seg-text">{seg.text}</p>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        <aside className="recap-sidebar">
          <div className="takeaways-tabs">
            {(["ask", "chapters", "moments", "tasks"] as RailTab[]).map((tab) => (
              <button
                key={tab}
                type="button"
                className={`takeaways-tab ${railTab === tab ? "takeaways-tab--active" : ""}`}
                onClick={() => setRailTab(tab)}
              >
                {tab === "ask" ? "Ask" : tab.charAt(0).toUpperCase() + tab.slice(1)}
              </button>
            ))}
          </div>

          {railTab === "ask" && (
            <div className="ask-card">
              <form
                className="ask-input"
                onSubmit={(e) => {
                  e.preventDefault();
                  submitAsk(askQuery);
                }}
              >
                <input
                  className="ask-input-field"
                  type="text"
                  placeholder="What did we decide about export?"
                  value={askQuery}
                  onChange={(e) => setAskQuery(e.target.value)}
                  aria-label="Ask this meeting"
                />
                <button type="submit" className="ask-send" aria-label="Send question">
                  ↑
                </button>
              </form>
              {askAnswer && <div className="ask-answer">{askAnswer}</div>}
              {askCitations.length > 0 && (
                <div className="ask-citations">
                  {askCitations.map((c, i) => (
                    <button
                      key={i}
                      type="button"
                      className="ask-citation"
                      onClick={() => {
                        const idx = transcript.findIndex((s) => s.time === c.time);
                        if (idx >= 0) seekSegment(idx);
                      }}
                    >
                      <span className="ask-citation-time">{c.time}</span>
                      {c.text.slice(0, 80)}
                      {c.text.length > 80 ? "…" : ""}
                    </button>
                  ))}
                </div>
              )}
              <div className="ask-suggestions">
                {recap.suggestions.map((s) => (
                  <button key={s} type="button" className="ghost-pill" onClick={() => submitAsk(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {railTab === "chapters" && (
            <div className="chapter-list">
              {recap.chapters.map((c) => (
                <button
                  key={c.time}
                  type="button"
                  className={`chapter-row ${activeChapter === c.time ? "chapter-row--active" : ""}`}
                  onClick={() => {
                    setActiveChapter(c.time);
                    const idx = transcript.findIndex((s) => s.time === c.time);
                    if (idx >= 0) seekSegment(idx);
                  }}
                >
                  <span className="chapter-label">{c.label}</span>
                  <span className="chapter-time">{c.time}</span>
                </button>
              ))}
            </div>
          )}

          {railTab === "moments" && (
            <div>
              {moments.bookmarks.map((b, i) => (
                <div key={`b-${i}`} className="moment-row">
                  <span className="moment-time">🔖 {b.time}</span>
                  {b.note && <div>{b.note}</div>}
                </div>
              ))}
              {allMoments.map((h, i) => (
                <div key={`h-${i}`} className="moment-row">
                  <span className="moment-time">⭐ {h.time}</span>
                  <div>"{h.text}"</div>
                  {audioUrl && (
                    <button type="button" className="link-btn" onClick={() => exportClip(h)}>
                      Export clip
                    </button>
                  )}
                </div>
              ))}
              {moments.bookmarks.length === 0 && allMoments.length === 0 && (
                <div className="recap-empty">No moments yet. Highlight during recording.</div>
              )}
            </div>
          )}

          {railTab === "tasks" && (
            <div className="action-table">
              {openActions.map((a) => (
                <div key={a.id} className="action-row">
                  <button
                    type="button"
                    className="checkbox"
                    onClick={() =>
                      onCompleteAction({
                        id: a.id,
                        text: a.text,
                        owner: a.owner,
                        due: a.due,
                        meeting: recap.title,
                        meetingId,
                        soon: a.soon,
                      })
                    }
                    aria-label="Mark done"
                  />
                  <span className="action-task">{a.text}</span>
                </div>
              ))}
              {openActions.length === 0 && <div className="recap-empty">No open tasks.</div>}
            </div>
          )}

          {railTab !== "moments" && (
            <>
              <div className="section-label section-label--calm section-label--spaced">Highlight</div>
              <div
                ref={highlightRef}
                className={`highlight-quote ${jumpTimestamp ? "highlight-quote--jump" : ""}`}
              >
                "{recap.highlight.quote}"
              </div>
              <div className="highlight-by">— {recap.highlight.by}</div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

// Re-export for live moments persistence from App
export { saveMoments };
