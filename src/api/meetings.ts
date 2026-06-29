import { invoke, isTauri } from "@tauri-apps/api/core";
import type { CalendarEvent } from "../App";

export interface UpdateCalendarPayload {
  id: string;
  provider: string;
  eventUrl?: string | null;
  title?: string;
  start?: string;
  end?: string;
  location?: string;
}

export interface UpdateSavedPayload {
  id: string;
  title?: string;
  date?: string;
}

export async function updateCalendarEvent(payload: UpdateCalendarPayload): Promise<void> {
  if (!isTauri()) throw new Error("Calendar editing requires the Candor desktop app.");
  await invoke("update_calendar_event", { payload });
}

export async function deleteCalendarEvent(event: CalendarEvent): Promise<void> {
  if (!isTauri()) throw new Error("Calendar editing requires the Candor desktop app.");
  await invoke("delete_calendar_event", {
    payload: {
      id: event.id,
      provider: event.provider,
      eventUrl: event.eventUrl ?? null,
    },
  });
}

export async function updateSavedMeeting(payload: UpdateSavedPayload): Promise<void> {
  if (!isTauri()) throw new Error("Editing recordings requires the Candor desktop app.");
  await invoke("update_saved_meeting", { payload });
}

export async function deleteSavedMeeting(id: string): Promise<void> {
  if (!isTauri()) throw new Error("Editing recordings requires the Candor desktop app.");
  await invoke("delete_saved_meeting", { id });
}
