import { useCallback, useEffect, useMemo, useState } from "react";
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
import { loadFolderTree, moveMeetingToFolder, type FolderTreeNode } from "../api/local";
import {
  loadFolders,
  loadMeetingFolders,
  setMeetingFolder,
  type MeetingFolder,
} from "../v2/metadata";

function flattenFolderTree(tree: FolderTreeNode[], depth = 0): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = [];
  for (const node of tree) {
    out.push({ id: node.id, label: `${"  ".repeat(depth)}${node.name}` });
    out.push(...flattenFolderTree(node.children, depth + 1));
  }
  return out;
}

interface MeetingMenuHostProps {
  menu: ContextMenuState | null;
  onCloseMenu: () => void;
  onRefreshCalendar: () => void;
  onRefreshSaved: () => void;
  onOpenSaved: (id: string) => void;
  onRecord: () => void;
  onRecordEvent?: (event: import("../App").CalendarEvent) => void;
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
  onRecordEvent,
  pendingEdit,
  onPendingEditHandled,
  onSavedMeetingUpdated,
}: MeetingMenuHostProps) {
  const [editTarget, setEditTarget] = useState<MeetingTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [legacyFolders] = useState<MeetingFolder[]>(() => loadFolders());
  const [orgFolders, setOrgFolders] = useState<{ id: string; label: string }[]>([]);
  const [meetingFolders, setMeetingFolders] = useState(() => loadMeetingFolders());
  const [showFolderPicker, setShowFolderPicker] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    loadFolderTree()
      .then((tree) => setOrgFolders(flattenFolderTree(tree)))
      .catch(() => setOrgFolders([]));
  }, [menu]);

  const folders = isTauri()
    ? orgFolders.map((f) => ({ id: f.id, name: f.label.trim() }))
    : legacyFolders.map((f) => ({ id: f.id, name: f.name }));

  const moveToFolder = useCallback(
    async (meetingId: string, folderId: string | null) => {
      if (isTauri()) {
        await moveMeetingToFolder(meetingId, folderId);
      } else {
        setMeetingFolder(meetingId, folderId);
        await updateSavedMeeting({ id: meetingId, folderId }).catch(() => {});
      }
      setMeetingFolders(loadMeetingFolders());
      onRefreshSaved();
    },
    [onRefreshSaved],
  );

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
          onClick: () =>
            onRecordEvent ? onRecordEvent(target.event) : onRecord(),
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
        await moveToFolder(target.meeting.id, f.id);
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
        label: "Move to Inbox",
        disabled: !desktop || !(target.meeting.folderId && target.meeting.folderId !== "inbox"),
        onClick: async () => {
          await moveToFolder(target.meeting.id, "inbox");
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
  }, [menu, folders, meetingFolders, moveToFolder, onOpenSaved, onRecord, onRecordEvent, onRefreshCalendar, onRefreshSaved]);

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
              if (menu.target.kind === "saved") {
                await moveToFolder(menu.target.meeting.id, f.id);
              }
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