import { useEffect, useMemo, useState } from "react";
import type { CalendarEvent, View } from "../App";
import { Sidebar } from "../components/Sidebar";
import { loadSavedMeetings, type SavedMeeting } from "../api/local";
import { fmtEventTime } from "../format";
import { meetingContextHandler } from "../components/ContextMenu";
import type { ContextMenuState } from "../meetingEdit";

interface LibraryProps {
  onNavigate: (view: View) => void;
  onStartRecording: () => void;
  onOpenMeeting: (id: string) => void;
  onSearch: (query?: string) => void;
  calendarConnected: boolean;
  events: CalendarEvent[];
  onConnectCalendar: () => void;
  onRecordEvent: () => void;
  meetingsRefreshKey: number;
  onMeetingContextMenu: (x: number, y: number, target: ContextMenuState["target"]) => void;
}

type LibraryFilter = "All" | "This week";

export function Library({
  onNavigate,
  onStartRecording,
  onOpenMeeting,
  onSearch,
  calendarConnected,
  events,
  onConnectCalendar,
  onRecordEvent,
  meetingsRefreshKey,
  onMeetingContextMenu,
}: LibraryProps) {
  const [filter, setFilter] = useState<LibraryFilter>("All");
  const [localQuery, setLocalQuery] = useState("");
  const [saved, setSaved] = useState<SavedMeeting[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadSavedMeetings().then((m) => {
      if (!cancelled) {
        setSaved(m);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [meetingsRefreshKey]);

  const filtered = useMemo(() => {
    let list = saved;
    if (filter === "This week") {
      list = list.filter(
        (m) =>
          m.whenLabel.startsWith("Today") ||
          m.whenLabel.startsWith("Yesterday") ||
          m.whenLabel.includes("Mon"),
      );
    }
    const q = localQuery.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (m) => m.title.toLowerCase().includes(q) || m.blurb.toLowerCase().includes(q),
      );
    }
    return list;
  }, [saved, filter, localQuery]);

  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault();
    onSearch(localQuery.trim() || undefined);
  };

  return (
    <div className="screen screen--sidebar">
      <Sidebar active="Meetings" onNavigate={onNavigate} />

      <div className="main main--scroll">
        <div className="library-head">
          <span className="page-title">Meetings</span>
          <div className="spacer" />
          <form className="search-pill" onSubmit={submitSearch}>
            <span className="search-icon">⌕</span>
            <input
              className="search-pill-input"
              type="search"
              placeholder="Search transcripts…"
              value={localQuery}
              onChange={(e) => setLocalQuery(e.target.value)}
              aria-label="Search transcripts"
            />
          </form>
          {!calendarConnected && (
            <button className="btn-ghost" onClick={onConnectCalendar}>
              Connect calendar
            </button>
          )}
          <button className="btn-record" onClick={onStartRecording}>
            <span className="rec-dot" />
            Start recording
          </button>
        </div>

        {calendarConnected && events.length > 0 && (
          <>
            <div className="section-label section-label--block">UPCOMING</div>
            <div className="upcoming">
              {events.slice(0, 6).map((ev) => (
                <div
                  key={ev.id}
                  className="event-card event-card--menu"
                  onContextMenu={(e) =>
                    meetingContextHandler(e, (x, y) =>
                      onMeetingContextMenu(x, y, { kind: "calendar", event: ev }),
                    )
                  }
                >
                  <div className="event-main">
                    <span className="event-title">{ev.title}</span>
                    <span className="event-time">
                      {fmtEventTime(ev.start)}
                      {ev.attendees.length > 0 && ` · ${ev.attendees.length} people`}
                      {ev.onlineUrl && " · online"}
                    </span>
                  </div>
                  <button className="btn-record-sm" onClick={onRecordEvent}>
                    <span className="rec-dot" />
                    Record
                  </button>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="section-label section-label--block">
          RECORDED · saved locally
          <button type="button" className="link-btn link-btn--inline" onClick={() => onNavigate("files")}>
            Browse files →
          </button>
        </div>
        <div className="filter-row">
          {(["All", "This week"] as LibraryFilter[]).map((f) => (
            <button
              key={f}
              type="button"
              className={`chip ${filter === f ? "chip--active" : ""}`}
              onClick={() => setFilter(f)}
            >
              {f}
            </button>
          ))}
        </div>

        <div className="meeting-list">
          {loading ? (
            <div className="library-empty">Loading saved meetings…</div>
          ) : filtered.length === 0 ? (
            <div className="library-empty">
              No saved meetings yet. Record something and press Stop &amp; transcribe.
            </div>
          ) : (
            filtered.map((m) => (
              <button
                key={m.id}
                className="meeting-row meeting-row--menu"
                onClick={() => onOpenMeeting(m.id)}
                onContextMenu={(e) =>
                  meetingContextHandler(e, (x, y) =>
                    onMeetingContextMenu(x, y, { kind: "saved", meeting: m }),
                  )
                }
              >
                <div className="meeting-main">
                  <div className="meeting-title-row">
                    <span className="meeting-title">{m.title}</span>
                  </div>
                  <div className="meeting-blurb">{m.blurb}</div>
                </div>
                <div className="meeting-meta">
                  <div className="meeting-when">{m.whenLabel}</div>
                </div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
