import { useEffect, useState } from "react";
import type { MeetingTarget } from "../meetingEdit";
import { datetimeLocalToIso, isoToDatetimeLocal, providerLabel } from "../meetingEdit";

export interface EditMeetingFields {
  title: string;
  start: string;
  end: string;
  location: string;
}

interface EditMeetingModalProps {
  target: MeetingTarget;
  onClose: () => void;
  onSave: (fields: EditMeetingFields) => Promise<void>;
  error?: string | null;
}

export function EditMeetingModal({ target, onClose, onSave, error }: EditMeetingModalProps) {
  const isCalendar = target.kind === "calendar";
  const event = isCalendar ? target.event : null;
  const saved = target.kind === "saved" ? target.meeting : null;

  const [title, setTitle] = useState(isCalendar ? event!.title : saved!.title);
  const [start, setStart] = useState(isCalendar ? isoToDatetimeLocal(event!.start) : isoToDatetimeLocal(saved!.date));
  const [end, setEnd] = useState(isCalendar ? isoToDatetimeLocal(event!.end) : "");
  const [location, setLocation] = useState(isCalendar ? event!.location : "");
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      setLocalError("Title is required.");
      return;
    }
    setSaving(true);
    setLocalError(null);
    try {
      await onSave({
        title: title.trim(),
        start: start ? datetimeLocalToIso(start) : "",
        end: end ? datetimeLocalToIso(end) : "",
        location: location.trim(),
      });
      onClose();
    } catch (err) {
      setLocalError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const subtitle = isCalendar
    ? `Syncs to ${providerLabel(event!.provider)}`
    : "Updates your local recording file";

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal-card edit-meeting-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="edit-meeting-title"
      >
        <div className="modal-head">
          <span id="edit-meeting-title" className="modal-title">
            Rename meeting
          </span>
          <button type="button" className="modal-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <form className="modal-body" onSubmit={submit}>
          <p className="modal-sub">{subtitle}</p>
          {(localError || error) && (
            <div className="modal-error">{localError || error}</div>
          )}
          <label className="edit-field">
            <span className="edit-label">Title</span>
            <input
              className="modal-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
            />
          </label>
          <label className="edit-field">
            <span className="edit-label">{isCalendar ? "Starts" : "Recorded"}</span>
            <input
              className="modal-input"
              type="datetime-local"
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </label>
          {isCalendar && (
            <>
              <label className="edit-field">
                <span className="edit-label">Ends</span>
                <input
                  className="modal-input"
                  type="datetime-local"
                  value={end}
                  onChange={(e) => setEnd(e.target.value)}
                />
              </label>
              <label className="edit-field">
                <span className="edit-label">Location</span>
                <input
                  className="modal-input"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="Room, link, or address"
                />
              </label>
            </>
          )}
          <div className="modal-actions">
            <button type="button" className="btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving ? "Saving…" : "Save changes"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
