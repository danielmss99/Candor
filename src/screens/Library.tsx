import { useEffect, useMemo, useState } from "react";
import type { CalendarEvent, View } from "../App";
import { Sidebar } from "../components/Sidebar";
import { EmptyState } from "../components/EmptyState";
import { Skeleton } from "../components/Skeleton";
import { loadSavedMeetings, type SavedMeeting } from "../api/local";
import { fmtEventTime } from "../format";
import { meetingContextHandler } from "../components/ContextMenu";
import type { ContextMenuState } from "../meetingEdit";
import {
  loadFavorites,
  loadFolders,
  loadMeetingFolders,
  toggleFavorite,
  type MeetingFolder,
} from "../v2/metadata";

interface LibraryProps {
  onNavigate: (view: View) => void;
  onStartRecording: () => void;
  onOpenMeeting: (id: string) => void;
  onSearch: (query?: string) => void;
  calendarConnected: boolean;
  events: CalendarEvent[];
  onConnectCalendar: () => void;
  onRecordEvent: (ev: CalendarEvent) => void;
  onImportAudio?: () => void;
  meetingsRefreshKey: number;
  onMeetingContextMenu: (x: number, y: number, target: ContextMenuState["target"]) => void;
}

type SmartFilter = "all" | "week" | "tasks" | "long" | "favorites";
type ViewMode = "list" | "table";

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
  onImportAudio,
}: LibraryProps) {
  const [filter, setFilter] = useState<SmartFilter>("all");
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [folderFilter, setFolderFilter] = useState<string | null>(null);
  const [localQuery, setLocalQuery] = useState("");
  const [saved, setSaved] = useState<SavedMeeting[]>([]);
  const [loading, setLoading] = useState(true);
  const [favorites, setFavorites] = useState(() => loadFavorites());
  const [folders] = useState<MeetingFolder[]>(() => loadFolders());
  const [meetingFolders] = useState(() => loadMeetingFolders());

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
    if (filter === "week") {
      list = list.filter(
        (m) =>
          m.whenLabel.startsWith("Today") ||
          m.whenLabel.startsWith("Yesterday") ||
          m.whenLabel.includes("Mon"),
      );
    }
    if (filter === "long") list = list.filter((m) => m.durationMinutes > 45);
    if (filter === "favorites") list = list.filter((m) => favorites.has(m.id));
    if (folderFilter) {
      list = list.filter(
        (m) => (m.folderId ?? meetingFolders[m.id] ?? "inbox") === folderFilter,
      );
    }
    const q = localQuery.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (m) => m.title.toLowerCase().includes(q) || m.blurb.toLowerCase().includes(q),
      );
    }
    return list;
  }, [saved, filter, localQuery, favorites, folderFilter, meetingFolders]);

  const pinned = useMemo(
    () => saved.filter((m) => favorites.has(m.id)),
    [saved, favorites],
  );

  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault();
    onSearch(localQuery.trim() || undefined);
  };

  const star = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setFavorites(toggleFavorite(id));
  };

  const smartFilters: { id: SmartFilter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "week", label: "This week" },
    { id: "tasks", label: "Has open tasks" },
    { id: "long", label: "Long (>45m)" },
    { id: "favorites", label: "Favorites" },
  ];

  const displayList =
    filter === "tasks"
      ? filtered.filter((m) => m.blurb.toLowerCase().includes("action") || m.title.length > 0)
      : filtered;

  const renderRow = (m: SavedMeeting) => (
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
      <button
        type="button"
        className={`star-btn ${favorites.has(m.id) ? "star-btn--on" : ""}`}
        onClick={(e) => star(e, m.id)}
        aria-label={favorites.has(m.id) ? "Unpin" : "Pin"}
      >
        ★
      </button>
      <div className="meeting-main">
        <div className="meeting-title-row">
          <span className="meeting-title">{m.title}</span>
          {(m.folderId ?? meetingFolders[m.id]) && (
            <span
              className="folder-dot"
              style={{
                background: folders.find((f) => f.id === (m.folderId ?? meetingFolders[m.id]))?.color,
              }}
            />
          )}
        </div>
        <div className="meeting-blurb">{m.blurb}</div>
      </div>
      <div className="meeting-meta">
        <div className="meeting-when">{m.whenLabel}</div>
        <div className="meeting-when">{m.durationMinutes}m</div>
      </div>
    </button>
  );

  return (
    <div className="screen screen--sidebar">
      <Sidebar active="Meetings" onNavigate={onNavigate} />

      <div className="main main--scroll">
        <div className="library-head">
          <span className="page-title">Meetings</span>
          <div className="library-view-switch">
            <button
              type="button"
              className={`view-btn ${viewMode === "list" ? "view-btn--active" : ""}`}
              onClick={() => setViewMode("list")}
            >
              List
            </button>
            <button
              type="button"
              className={`view-btn ${viewMode === "table" ? "view-btn--active" : ""}`}
              onClick={() => setViewMode("table")}
            >
              Table
            </button>
          </div>
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
          {onImportAudio && (
            <button type="button" className="btn-ghost" onClick={onImportAudio}>
              Import audio
            </button>
          )}
        </div>

        {calendarConnected && events.length > 0 && (
          <>
            <div className="section-label section-label--calm section-label--block">Upcoming</div>
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
                    </span>
                  </div>
                  <button className="btn-record-sm" onClick={() => onRecordEvent(ev)}>
                    <span className="rec-dot" />
                    Record
                  </button>
                </div>
              ))}
            </div>
          </>
        )}

        {pinned.length > 0 && filter !== "favorites" && (
          <section className="pinned-section">
            <div className="section-label section-label--calm section-label--block">Pinned</div>
            <div className="meeting-list">{pinned.slice(0, 3).map(renderRow)}</div>
          </section>
        )}

        <div className="section-label section-label--calm section-label--block">
          Recorded · saved locally
          <button type="button" className="link-btn link-btn--inline" onClick={() => onNavigate("files")}>
            Browse files →
          </button>
        </div>

        <div className="filter-row">
          {smartFilters.map((f) => (
            <button
              key={f.id}
              type="button"
              className={`chip ${filter === f.id ? "chip--active" : ""}`}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="filter-row">
          {folders.map((f) => (
            <button
              key={f.id}
              type="button"
              className={`folder-chip ${folderFilter === f.id ? "folder-chip--active" : ""}`}
              onClick={() => setFolderFilter(folderFilter === f.id ? null : f.id)}
            >
              <span className="folder-dot" style={{ background: f.color }} />
              {f.name}
            </button>
          ))}
        </div>

        {loading ? (
          <Skeleton rows={5} variant="card" />
        ) : displayList.length === 0 ? (
          <EmptyState
            icon="🎙"
            title="No meetings yet"
            description="Record your first meeting or import audio to see it here."
            primaryAction={{ label: "Start recording", onClick: onStartRecording }}
            secondaryAction={{ label: "Browse files", onClick: () => onNavigate("files") }}
          />
        ) : viewMode === "table" ? (
          <table className="meeting-table">
            <thead>
              <tr>
                <th>Title</th>
                <th>When</th>
                <th>Duration</th>
                <th>★</th>
              </tr>
            </thead>
            <tbody>
              {displayList.map((m) => (
                <tr key={m.id} onClick={() => onOpenMeeting(m.id)}>
                  <td>{m.title}</td>
                  <td>{m.whenLabel}</td>
                  <td>{m.durationMinutes}m</td>
                  <td>
                    <button
                      type="button"
                      className={`star-btn ${favorites.has(m.id) ? "star-btn--on" : ""}`}
                      onClick={(e) => star(e, m.id)}
                    >
                      ★
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="meeting-list">{displayList.map(renderRow)}</div>
        )}
      </div>
    </div>
  );
}
