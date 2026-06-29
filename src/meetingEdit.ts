import type { CalendarEvent } from "./App";
import type { SavedMeeting } from "./api/local";

export type MeetingTarget =
  | { kind: "calendar"; event: CalendarEvent }
  | { kind: "saved"; meeting: SavedMeeting };

export interface ContextMenuState {
  x: number;
  y: number;
  target: MeetingTarget;
}

/** ISO / Graph datetime → value for `<input type="datetime-local">`. */
export function isoToDatetimeLocal(iso: string): string {
  if (!iso) return "";
  const zoned = iso.includes("Z") || /[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso.split(".")[0]}Z`;
  const d = new Date(zoned);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** datetime-local → UTC ISO for Graph / storage. */
export function datetimeLocalToIso(local: string): string {
  if (!local) return "";
  return new Date(local).toISOString();
}

export function providerLabel(provider: string): string {
  if (provider === "microsoft") return "Outlook";
  if (provider === "google") return "Google Calendar";
  if (provider === "apple") return "Apple Calendar";
  return "Calendar";
}
