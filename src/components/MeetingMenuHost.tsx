import { useEffect, useMemo, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import {
  deleteCalendarEvent,
  deleteSavedMeeting,
  updateCalendarEvent,
  updateSavedMeeting,
} from "../api/meetings";
import type { ContextMenuState, MeetingTarget } from "../meetingEdit";
import { ContextMenu } from "./ContextMenu";
import { EditMeetingModal } from "./EditMeetingModal";
import {
  loadFolders,
  loadMeetingFolders,
  setMeetingFolder,
  type MeetingFolder,
} from "../v2/metadata";

interface MeetingMenuHostProps {
  menu: ContextMenuState | null;
  onCloseMenu: () => void;
  onRefreshCalendar: () => void;
  onRefreshSaved: () => void;
  onOpenSaved: (id: string) => void;
  onRecord: () => void;
  pendingEdit?: MeetingTarget | null;
  onPendingEditHandled?: () => void;
  onSavedMeetingUpdated?: (id: string) => void;
}

export function MeetingMenuHost({
  menu,
  onCloseMenu,
  onRefreshCalendar,
  onRefreshSaved,
  onOpenSaved,
  onRecord,
  pendingEdit,
  onPendingEditHandled,
  onSavedMeetingUpdated,
}: MeetingMenuHostProps) {
  const [editTarget, setEditTarget] = useState<MeetingTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [folders] = useState<MeetingFolder[]>(() => loadFolders());
  const [meetingFolders, setMeetingFolders] = useState(() => loadMeetingFolders());
  const [showFolderPicker, setShowFolderPicker] = useState(false);

  const items = useMemo(() => {
    if (!menu) return [];
    const { target } = menu;
    const desktop = isTauri();

    if (target.kind === "calendar") {
      return [
        {
          id: "edit",
          label: "Rename meeting…",
          disabled: !desktop,
          onClick: () => setEditTarget(target),
        },
        {
          id: "record",
          label: "Record this meeting",
          onClick: () => onRecord(),
        },
        {
          id: "delete",
          label: "Delete from calendar",
          danger: true,
          disabled: !desktop,
          onClick: async () => {
            if (!window.confirm(`Delete “${target.event.title}” from your calendar?`)) return;
            setBusy(true);
            try {
              await deleteCalendarEvent(target.event);
              onRefreshCalendar();
            } catch (e) {
              window.alert(String(e));
            } finally {
              setBusy(false);
            }
          },
        },
      ];
    }

    const folderItems = folders.map((f) => ({
      id: `folder-${f.id}`,
      label: `Move to ${f.name}`,
      disabled: !desktop,
      onClick: async () => {
        setMeetingFolder(target.meeting.id, f.id);
        setMeetingFolders(loadMeetingFolders());
        if (desktop) {
          await updateSavedMeeting({ id: target.meeting.id, folderId: f.id }).catch(() => {});
        }
        onRefreshSaved();
      },
    }));

    return [
      {
        id: "open",
        label: "Open recap",
        onClick: () => onOpenSaved(target.meeting.id),
      },
      {
        id: "edit",
        label: "Rename recording…",
        disabled: !desktop,
        onClick: () => setEditTarget(target),
      },
      {
        id: "folder",
        label: "Assign folder…",
        disabled: !desktop,
        onClick: () => setShowFolderPicker(true),
      },
      ...folderItems,
      {
        id: "folder-clear",
        label: "Remove from folder",
        disabled: !desktop || !meetingFolders[target.meeting.id],
        onClick: async () => {
          setMeetingFolder(target.meeting.id, null);
          setMeetingFolders(loadMeetingFolders());
          await updateSavedMeeting({ id: target.meeting.id, folderId: null }).catch(() => {});
          onRefreshSaved();
        },
      },
      {
        id: "delete",
        label: "Delete recording",
        danger: true,
        disabled: !desktop,
        onClick: async () => {
          if (!window.confirm(`Delete “${target.meeting.title}”? This removes the local file.`)) {
            return;
          }
          setBusy(true);
          try {
            await deleteSavedMeeting(target.meeting.id);
            onRefreshSaved();
          } catch (e) {
            window.alert(String(e));
          } finally {
            setBusy(false);
          }
        },
      },
    ];
  }, [menu, folders, meetingFolders, onOpenSaved, onRecord, onRefreshCalendar, onRefreshSaved]);

  useEffect(() => {
    if (pendingEdit) {
      setEditTarget(pendingEdit);
      onPendingEditHandled?.();
    }
  }, [pendingEdit, onPendingEditHandled]);

  const saveEdit = async (fields: {
    title: string;
    start: string;
    end: string;
    location: string;
  }) => {
    if (!editTarget) return;
    if (editTarget.kind === "calendar") {
      const ev = editTarget.event;
      await updateCalendarEvent({
        id: ev.id,
        provider: ev.provider,
        eventUrl: ev.eventUrl,
        title: fields.title,
        start: fields.start || undefined,
        end: fields.end || undefined,
        location: fields.location || undefined,
      });
      onRefreshCalendar();
    } else {
      const id = editTarget.meeting.id;
      await updateSavedMeeting({
        id,
        title: fields.title,
        date: fields.start || undefined,
      });
      onRefreshSaved();
      onSavedMeetingUpdated?.(id);
    }
  };

  return (
    <>
      {menu && !busy && !showFolderPicker && (
        <ContextMenu x={menu.x} y={menu.y} items={items} onClose={onCloseMenu} />
      )}
      {menu && showFolderPicker && menu.target.kind === "saved" && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={folders.map((f) => ({
            id: f.id,
            label: f.name,
            onClick: async () => {
              setMeetingFolder(menu.target.kind === "saved" ? menu.target.meeting.id : "", f.id);
              setMeetingFolders(loadMeetingFolders());
              await updateSavedMeeting({
                id: menu.target.kind === "saved" ? menu.target.meeting.id : "",
                folderId: f.id,
              }).catch(() => {});
              onRefreshSaved();
              setShowFolderPicker(false);
              onCloseMenu();
            },
          }))}
          onClose={() => {
            setShowFolderPicker(false);
            onCloseMenu();
          }}
        />
      )}
      {editTarget && (
        <EditMeetingModal
          target={editTarget}
          onClose={() => setEditTarget(null)}
          onSave={saveEdit}
        />
      )}
    </>
  );
}