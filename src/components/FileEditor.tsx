import { useCallback, useEffect, useState } from "react";
import type { MeetingDetail } from "../api/local";
import { loadMeetingDetail, saveMeetingEdits } from "../api/local";
import type { TranscriptSegment } from "../App";

interface FileEditorProps {
  meetingId: string | null;
  onSaved: () => void;
  onOpenRecap: (id: string) => void;
}

function transcriptToText(segs: TranscriptSegment[]): string {
  return segs
    .map((s) => {
      const speaker = s.speaker ? `[${s.speaker}] ` : "";
      return `\`${s.time}\` ${speaker}${s.text}`;
    })
    .join("\n\n");
}

function parseTranscriptText(raw: string): TranscriptSegment[] {
  const segs: TranscriptSegment[] = [];
  for (const block of raw.split(/\n\n+/)) {
    const line = block.trim();
    if (!line) continue;
    const match = line.match(/^`([^`]+)`\s*(?:\[([^\]]+)\]\s*)?([\s\S]*)$/);
    if (match) {
      segs.push({
        time: match[1],
        speaker: match[2] || undefined,
        text: match[3].trim(),
      });
    } else {
      segs.push({ time: "00:00", text: line });
    }
  }
  return segs;
}

export function FileEditor({ meetingId, onSaved, onOpenRecap }: FileEditorProps) {
  const [detail, setDetail] = useState<MeetingDetail | null>(null);
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [transcript, setTranscript] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!meetingId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    loadMeetingDetail(meetingId).then((m) => {
      if (cancelled) return;
      setDetail(m);
      setTitle(m?.title ?? "");
      setNotes(m?.userNotes ?? "");
      setTranscript(m ? transcriptToText(m.transcript) : "");
      setDirty(false);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [meetingId]);

  const save = useCallback(async () => {
    if (!meetingId || !detail) return;
    setSaving(true);
    try {
      await saveMeetingEdits({
        id: meetingId,
        title: title.trim() || detail.title,
        userNotes: notes,
        transcript: parseTranscriptText(transcript),
      });
      setDirty(false);
      onSaved();
    } catch (e) {
      window.alert(String(e));
    } finally {
      setSaving(false);
    }
  }, [meetingId, detail, title, notes, transcript, onSaved]);

  if (!meetingId) {
    return (
      <div className="file-editor file-editor--empty">
        <p>Select a meeting to view and edit notes or transcript.</p>
      </div>
    );
  }

  if (loading) {
    return <div className="file-editor file-editor--empty">Loading…</div>;
  }

  if (!detail) {
    return <div className="file-editor file-editor--empty">Could not load meeting.</div>;
  }

  return (
    <div className="file-editor">
      <div className="file-editor-head">
        <input
          className="file-editor-title"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            setDirty(true);
          }}
          aria-label="Meeting title"
        />
        <div className="file-editor-actions">
          <button type="button" className="btn-ghost" onClick={() => onOpenRecap(meetingId)}>
            Open recap
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={!dirty || saving}
            onClick={save}
          >
            {saving ? "Saving…" : dirty ? "Save changes" : "Saved"}
          </button>
        </div>
      </div>

      <div className="file-editor-meta">
        <span>{detail.date ? new Date(detail.date).toLocaleString() : "Saved locally"}</span>
        {detail.audioPath && <span className="tag">audio linked</span>}
      </div>

      <label className="file-editor-label">
        My notes
        <textarea
          className="file-editor-area"
          value={notes}
          rows={8}
          onChange={(e) => {
            setNotes(e.target.value);
            setDirty(true);
          }}
        />
      </label>

      <label className="file-editor-label">
        Transcript
        <textarea
          className="file-editor-area file-editor-area--mono"
          value={transcript}
          rows={14}
          onChange={(e) => {
            setTranscript(e.target.value);
            setDirty(true);
          }}
        />
      </label>
    </div>
  );
}
