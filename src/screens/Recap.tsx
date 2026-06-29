import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { View } from "../App";
import { Avatar } from "../components/Avatar";
import type { RecapData } from "../data/mock";
import { getRecapForMeeting, people } from "../data/mock";
import {
  answerMeetingQuestion,
  downloadRecapMarkdown,
  shareRecapSummary,
} from "../export";
import type { CompletedAction } from "../api/actions";
import { resolveActionId } from "../api/actions";

interface RecapProps {
  meetingId: string;
  recapData?: RecapData | null;
  jumpTimestamp: string | null;
  onNavigate: (view: View) => void;
  completedIds: Set<string>;
  onCompleteAction: (item: Omit<CompletedAction, "completedAt">) => void;
  canRename?: boolean;
  onRename?: () => void;
}

function ownerAvatar(owner: string) {
  if (owner in people) {
    return { who: owner as keyof typeof people };
  }
  return { label: owner.slice(0, 2).toUpperCase(), bg: "var(--coral)", fg: "var(--coral-on)" };
}

/** Render **bold** spans inside the AI summary. */
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
  jumpTimestamp,
  onNavigate,
  completedIds,
  onCompleteAction,
  canRename,
  onRename,
}: RecapProps) {
  const recap = useMemo(
    () => recapData ?? getRecapForMeeting(meetingId),
    [recapData, meetingId],
  );
  const highlightRef = useRef<HTMLDivElement>(null);

  const [askQuery, setAskQuery] = useState("");
  const [askAnswer, setAskAnswer] = useState<string | null>(null);
  const [shareStatus, setShareStatus] = useState<string | null>(null);
  const [activeChapter, setActiveChapter] = useState<string | null>(jumpTimestamp);

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

  useEffect(() => {
    setAskQuery("");
    setAskAnswer(null);
    setActiveChapter(jumpTimestamp);
  }, [meetingId, jumpTimestamp]);

  useEffect(() => {
    if (jumpTimestamp && highlightRef.current) {
      highlightRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [jumpTimestamp, meetingId]);

  const submitAsk = (question: string) => {
    const q = question.trim();
    if (!q) return;
    setAskQuery(q);
    setAskAnswer(answerMeetingQuestion(recap, q));
  };

  const handleShare = async () => {
    const ok = await shareRecapSummary(recap);
    setShareStatus(ok ? "Copied to clipboard" : "Could not copy");
    window.setTimeout(() => setShareStatus(null), 2000);
  };

  const handleExport = () => {
    downloadRecapMarkdown(recap);
    invoke("open_notes_folder").catch(() => {});
  };

  const avatars = openActions.length > 0
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
        <button className="btn-primary" onClick={handleExport}>
          Export notes
        </button>
      </header>

      {jumpTimestamp && (
        <div className="jump-banner">
          Jumped to <strong>{jumpTimestamp}</strong> from search
        </div>
      )}

      <div className="recap-body">
        <div className="recap-main">
          <div className="kicker-row">
            <span className="kicker kicker--coral">⌁ AI SUMMARY</span>
            <span className="kicker-sub">· auto-generated</span>
          </div>
          <p className="recap-summary">{renderSummary(recap.summary)}</p>

          <div className="section-label section-label--spaced">
            KEY DECISIONS · {recap.decisions.length}
          </div>
          {recap.decisions.map((d, i) => (
            <div key={i} className="decision-row">
              <span className="check-box">✓</span>
              <div className="decision-text">{d}</div>
            </div>
          ))}

          <div className="section-label section-label--spaced" style={{ marginTop: 28 }}>
            TASKS · {openActions.length}
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
                  : "All tasks completed — see Files for your archive."}
              </div>
            )}
          </div>
        </div>

        <aside className="recap-sidebar">
          <div className="ask-card">
            <div className="ask-kicker">⌁ ASK THIS MEETING</div>
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
            <div className="ask-suggestions">
              {recap.suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="ghost-pill"
                  onClick={() => submitAsk(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          <div className="section-label">CHAPTERS</div>
          <div className="chapter-list">
            {recap.chapters.map((c) => (
              <button
                key={c.time}
                type="button"
                className={`chapter-row ${activeChapter === c.time ? "chapter-row--active" : ""}`}
                onClick={() => setActiveChapter(c.time)}
              >
                <span className="chapter-label">{c.label}</span>
                <span className="chapter-time">{c.time}</span>
              </button>
            ))}
          </div>

          <div className="section-label section-label--spaced">HIGHLIGHT</div>
          <div
            ref={highlightRef}
            className={`highlight-quote ${jumpTimestamp ? "highlight-quote--jump" : ""}`}
          >
            "{recap.highlight.quote}"
          </div>
          <div className="highlight-by">— {recap.highlight.by}</div>
        </aside>
      </div>
    </div>
  );
}
