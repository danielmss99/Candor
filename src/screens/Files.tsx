import { useCallback, useEffect, useState } from "react";
import type { View } from "../App";
import { Sidebar } from "../components/Sidebar";
import {
  loadSavedMeetings,
  loadStorageFolders,
  openStorageFolder,
  type SavedMeeting,
  type StorageFolder,
} from "../api/local";
import { meetingContextHandler } from "../components/ContextMenu";
import type { ContextMenuState } from "../meetingEdit";

interface FilesProps {
  onNavigate: (view: View) => void;
  onOpenMeeting: (id: string) => void;
  refreshKey: number;
  onMeetingContextMenu: (x: number, y: number, target: ContextMenuState["target"]) => void;
}

export function Files({ onNavigate, onOpenMeeting, refreshKey, onMeetingContextMenu }: FilesProps) {
  const [meetings, setMeetings] = useState<SavedMeeting[]>([]);
  const [folders, setFolders] = useState<StorageFolder[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    const [m, f] = await Promise.all([loadSavedMeetings(), loadStorageFolders()]);
    setMeetings(m);
    setFolders(f);
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh, refreshKey]);

  return (
    <div className="screen screen--sidebar">
      <Sidebar active="Files" onNavigate={onNavigate} />

      <div className="main main--scroll">
        <div className="library-head">
          <span className="page-title">Files</span>
          <span className="page-sub">Everything saved on this device</span>
          <div className="spacer" />
          <button type="button" className="btn-ghost" onClick={refresh}>
            Refresh
          </button>
        </div>

        <div className="section-label section-label--block">LOCAL FOLDERS</div>
        <div className="folder-grid">
          {folders.map((f) => (
            <button
              key={f.id}
              type="button"
              className="folder-card"
              onClick={() => openStorageFolder(f.id).catch(() => {})}
            >
              <span className="folder-icon">📁</span>
              <span className="folder-label">{f.label}</span>
              <span className="folder-desc">{f.description}</span>
              <span className="folder-path">{f.path}</span>
            </button>
          ))}
          {folders.length === 0 && !loading && (
            <div className="library-empty">Folders appear when running the desktop app.</div>
          )}
        </div>

        <div className="section-label section-label--block">SAVED MEETINGS · {meetings.length}</div>
        {loading ? (
          <div className="library-empty">Loading meetings…</div>
        ) : meetings.length === 0 ? (
          <div className="library-empty">
            No recordings yet. Start a recording and stop &amp; transcribe to save a meeting here.
          </div>
        ) : (
          <div className="meeting-list">
            {meetings.map((m) => (
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
                    <span className="tag">local</span>
                  </div>
                  <div className="meeting-blurb">{m.blurb}</div>
                </div>
                <div className="meeting-meta">
                  <div className="meeting-when">{m.whenLabel}</div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
