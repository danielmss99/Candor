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

interface MeetingMenuHostProps {
  menu: ContextMenuState | null;
  onCloseMenu: () => void;
  onRefreshCalendar: () => void;
  onRefreshSaved: () => void;
  onOpenSaved: (id: string) => void;
  onRecord: () => void;
  /** Open the edit modal for a meeting (e.g. from Recap rename button). */
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

  useEffect(() => {
    if (pendingEdit) {
      setEditTarget(pendingEdit);
      onPendingEditHandled?.();
    }
  }, [pendingEdit, onPendingEditHandled]);

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
  }, [menu, onOpenSaved, onRecord, onRefreshCalendar, onRefreshSaved]);

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
      {menu && !busy && (
        <ContextMenu x={menu.x} y={menu.y} items={items} onClose={onCloseMenu} />
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
