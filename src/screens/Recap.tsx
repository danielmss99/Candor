import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { isTauri } from "@tauri-apps/api/core";
import type { TranscriptSegment, View } from "../App";
import { AudioPlayer, parseTime } from "../components/AudioPlayer";
import { Skeleton } from "../components/Skeleton";
import type { RecapData } from "../data/mock";
import { getRecapForMeeting } from "../data/mock";
import {
  downloadRecapPreset,
  recapToEmail,
  recapToSlack,
  shareRecapSummary,
} from "../export";
import { askMeeting, type AskCitation } from "../v2/askMeeting";
import { buildCitationMap, generateRecapFromRecording } from "../recapGenerate";
import { loadSummaryTemplate } from "../v2/summaryTemplates";
import { useUser } from "../user";
import type { CompletedAction } from "../api/actions";
import { resolveActionId } from "../api/actions";
import { loadMeetingDetail, retryTranscription } from "../api/local";
import {
  loadRecapEdits,
  loadSpeakerLabels,
  saveRecapEdits,
  saveSpeakerLabel,
} from "../v2/metadata";

interface RecapProps {
  meetingId: string;
  recapData?: RecapData | null;
  transcript?: TranscriptSegment[];
  sessionNotes?: string;
  jumpTimestamp: string | null;
  onNavigate: (view: View) => void;
  completedIds: Set<string>;
  onCompleteAction: (item: Omit<CompletedAction, "completedAt">) => void;
  onRecapReviewed?: () => void;
  canRename?: boolean;
  onRename?: () => void;
  processing?: boolean;
  processingMessage?: string;
  transcriptionError?: string | null;
}

type MainTab = "summary" | "notes" | "transcript";

function renderBold(text: string) {
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
  sessionNotes: sessionNotesProp = "",
  jumpTimestamp,
  onNavigate,
  completedIds,
  onCompleteAction,
  onRecapReviewed,
  canRename,
  onRename,
  processing = false,
  processingMessage = "Transcribing your recording…",
  transcriptionError,
}: RecapProps) {
  const recap = useMemo(
    () => recapData ?? getRecapForMeeting(meetingId),
    [recapData, meetingId],
  );
  const edits = useMemo(() => loadRecapEdits(meetingId), [meetingId]);
  const [summary, setSummary] = useState(edits.summary ?? recap.summary);
  const [mainTab, setMainTab] = useState<MainTab>("summary");
  const [transcript, setTranscript] = useState<TranscriptSegment[]>(transcriptProp ?? []);
  const [sessionNotes, setSessionNotes] = useState(sessionNotesProp);
  const [speakerLabels, setSpeakerLabels] = useState(() => loadSpeakerLabels(meetingId));
  const [activeSeg, setActiveSeg] = useState<number | null>(null);
  const [shareStatus, setShareStatus] = useState<string | null>(null);
  const [askOpen, setAskOpen] = useState(false);
  const [askQuery, setAskQuery] = useState("");
  const [askAnswer, setAskAnswer] = useState<string | null>(null);
  const [askCitations, setAskCitations] = useState<AskCitation[]>([]);
  const [retrying, setRetrying] = useState(false);
  const { initials } = useUser();

  useEffect(() => {
    onRecapReviewed?.();
  }, [meetingId, onRecapReviewed]);

  useEffect(() => {
    setSummary(edits.summary ?? recap.summary);
    setSpeakerLabels(loadSpeakerLabels(meetingId));
    setSessionNotes(sessionNotesProp);
    setAskQuery("");
    setAskAnswer(null);
    setAskCitations([]);
    if (transcriptProp) setTranscript(transcriptProp);
    else if (!processing) {
      loadMeetingDetail(meetingId).then((d) => {
        if (d?.transcript) {
          setTranscript(d.transcript);
          d.transcript.forEach((seg, i) => {
            if (seg.speaker) saveSpeakerLabel(meetingId, i, seg.speaker);
          });
        }
        if (d?.userNotes) setSessionNotes(d.userNotes);
      });
    }
  }, [meetingId, recap, edits, transcriptProp, sessionNotesProp, processing]);

  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  useEffect(() => {
    if (processing) return;
    loadMeetingDetail(meetingId).then((d) => {
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
  }, [meetingId, processing]);

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

  const citationMap = useMemo(() => buildCitationMap(recap.actions), [recap.actions]);
  const sections = recap.sections ?? [];

  const persistEdits = useCallback(
    (patch: { summary?: string }) => {
      const next = { ...loadRecapEdits(meetingId), ...patch };
      saveRecapEdits(meetingId, next);
    },
    [meetingId],
  );

  const submitAsk = (question: string) => {
    const q = question.trim();
    if (!q) return;
    setAskQuery(q);
    const result = askMeeting({ ...recap, summary }, transcript, q);
    setAskAnswer(result.answer);
    setAskCitations(result.citations);
  };

  const handleShare = async () => {
    const ok = await shareRecapSummary({ ...recap, summary });
    setShareStatus(ok ? "Copied" : "Failed");
    window.setTimeout(() => setShareStatus(null), 2000);
  };

  const copyPreset = async (preset: "slack" | "email") => {
    const text = preset === "slack" ? recapToSlack({ ...recap, summary }) : recapToEmail({ ...recap, summary });
    try {
      await navigator.clipboard.writeText(text);
      setShareStatus(preset === "slack" ? "Slack copied" : "Email copied");
    } catch {
      setShareStatus("Copy failed");
    }
    window.setTimeout(() => setShareStatus(null), 2000);
  };

  const seekSegment = (index: number) => {
    setActiveSeg(index);
    setMainTab("transcript");
    document.getElementById(`seg-${index}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const handleRetryTranscription = async () => {
    if (!isTauri() || retrying) return;
    setRetrying(true);
    try {
      const result = await retryTranscription(meetingId);
      setTranscript(result.segments);
      const next = generateRecapFromRecording({
        transcript: result.segments,
        sessionNotes,
        durationSeconds: 0,
        recordedAt: new Date(),
        userInitials: initials,
        titleOverride: recap.subtitle ?? recap.title,
        template: loadSummaryTemplate(),
      });
      setSummary(next.summary);
    } catch {
      /* keep error banner */
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="screen recap recap--notion">
      <header className="notion-recap-header">
        <button className="btn-back" onClick={() => onNavigate("library")}>
          ← Meetings
        </button>
        <div className="notion-recap-heading">
          <h1 className="notion-recap-title">{recap.title}</h1>
          {recap.subtitle && <p className="notion-recap-subtitle">{recap.subtitle}</p>}
          <p className="notion-recap-meta">{recap.meta}</p>
        </div>
        {canRename && onRename && (
          <button type="button" className="btn-ghost" onClick={onRename}>
            Rename
          </button>
        )}
      </header>

      {processing && (
        <div className="notion-processing-banner" role="status">
          <span className="listening-dot" />
          {processingMessage}
        </div>
      )}

      {transcriptionError && !processing && (
        <div className="notion-processing-banner notion-processing-banner--warn" role="alert">
          Transcription failed — audio was saved. {transcriptionError}
          {isTauri() && (
            <button type="button" className="notion-retry-btn" onClick={handleRetryTranscription} disabled={retrying}>
              {retrying ? "Retrying…" : "Retry transcription"}
            </button>
          )}
        </div>
      )}

      {jumpTimestamp && (
        <div className="jump-banner">
          Jumped to <strong>{jumpTimestamp}</strong> from search
        </div>
      )}

      <div className="notion-share-row">
        <button type="button" className="notion-share-btn" onClick={handleShare} disabled={processing}>
          {shareStatus ?? "Copy link"}
        </button>
        <button type="button" className="notion-share-btn" onClick={() => copyPreset("email")} disabled={processing}>
          Email
        </button>
        <button type="button" className="notion-share-btn" onClick={() => copyPreset("slack")} disabled={processing}>
          Slack
        </button>
        <div className="spacer" />
        <button type="button" className="btn-ghost" onClick={() => setAskOpen((o) => !o)} disabled={processing}>
          Ask AI
        </button>
        <button
          type="button"
          className="btn-ghost"
          disabled={processing}
          onClick={() => {
            const next = generateRecapFromRecording({
              transcript,
              sessionNotes,
              durationSeconds: 0,
              recordedAt: new Date(),
              userInitials: initials,
              titleOverride: recap.subtitle ?? recap.title,
              template: loadSummaryTemplate(),
            });
            setSummary(next.summary);
            persistEdits({ summary: next.summary });
          }}
        >
          Regenerate
        </button>
        <button type="button" className="btn-primary" disabled={processing} onClick={() => downloadRecapPreset({ ...recap, summary }, "markdown")}>
          Export
        </button>
      </div>

      {askOpen && (
        <div className="notion-ask-panel">
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
              placeholder="What did we decide about…?"
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
        </div>
      )}

      {!processing && audioUrl && (
        <div className="notion-audio-bar">
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
        </div>
      )}

      <nav className="notion-tab-bar" aria-label="Meeting content">
        {(["summary", "notes", "transcript"] as MainTab[]).map((tab) => (
          <button
            key={tab}
            type="button"
            className={`notion-tab ${mainTab === tab ? "notion-tab--active" : ""}`}
            onClick={() => setMainTab(tab)}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
            {tab === "transcript" && transcript.length > 0 && (
              <span className="notion-tab-count">{transcript.length}</span>
            )}
          </button>
        ))}
      </nav>

      <main className="notion-recap-content">
        {mainTab === "summary" && (
          <div className="notion-summary">
            {processing ? (
              <>
                <Skeleton variant="recap" />
                <Skeleton variant="recap" />
                <Skeleton variant="recap" />
              </>
            ) : (
              <>
                {summary && <p className="notion-summary-lead">{renderBold(summary)}</p>}

                {sections.map((section, si) => (
                  <section key={si} className="notion-section">
                    <h2 className="notion-section-heading">{section.heading}</h2>
                    <ul className="notion-bullet-list">
                      {section.bullets.map((bullet, bi) => (
                        <li key={bi} className="notion-bullet">
                          <span className="notion-bullet-text">{renderBold(bullet.text)}</span>
                          {bullet.subBullets && bullet.subBullets.length > 0 && (
                            <ul className="notion-sub-list">
                              {bullet.subBullets.map((sub, si2) => (
                                <li key={si2}>{renderBold(sub)}</li>
                              ))}
                            </ul>
                          )}
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}

                {openActions.length > 0 && (
                  <section className="notion-section notion-section--actions">
                    <h2 className="notion-section-heading">Action items</h2>
                    <ul className="notion-action-list">
                      {openActions.map((a) => (
                        <li key={a.id} className="notion-action-item">
                          <button
                            type="button"
                            className="notion-action-check"
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
                          <span className="notion-action-text">{a.text}</span>
                          {a.sourceSegmentIndex != null && citationMap.has(a.sourceSegmentIndex) && (
                            <button
                              type="button"
                              className="citation-pill"
                              onClick={() => seekSegment(a.sourceSegmentIndex!)}
                              title="Jump to source in transcript"
                            >
                              {citationMap.get(a.sourceSegmentIndex)!}
                            </button>
                          )}
                          <span className={`due-pill ${a.soon ? "due-pill--soon" : ""}`}>{a.due}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}

                {sections.length === 0 && !summary && (
                  <div className="recap-empty">No summary content for this meeting.</div>
                )}
              </>
            )}
          </div>
        )}

        {mainTab === "notes" && (
          <div className="notion-notes-panel">
            {sessionNotes.trim() ? (
              <pre className="notion-notes-content">{sessionNotes}</pre>
            ) : (
              <div className="recap-empty">No notes captured for this meeting.</div>
            )}
          </div>
        )}

        {mainTab === "transcript" && (
          <div className="notion-transcript-panel">
            {processing ? (
              <Skeleton rows={6} />
            ) : transcript.length === 0 ? (
              <div className="recap-empty">
                {transcriptionError
                  ? "Transcript unavailable — audio was saved."
                  : "No transcript segments for this meeting."}
              </div>
            ) : (
              transcript.map((seg, i) => (
                <div
                  key={i}
                  id={`seg-${i}`}
                  className={`notion-transcript-seg ${activeSeg === i ? "notion-transcript-seg--active" : ""}`}
                  onClick={() => seekSegment(i)}
                >
                  <div className="notion-transcript-meta">
                    <span className="notion-transcript-time">{seg.time}</span>
                    {citationMap.has(i) && (
                      <span className="citation-pill citation-pill--inline">{citationMap.get(i)}</span>
                    )}
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
                  </div>
                  <p className="notion-transcript-text">{seg.text}</p>
                </div>
              ))
            )}
          </div>
        )}
      </main>
    </div>
  );
}
