/** Recording timer: MM:SS under 1 hour, H:MM:SS for longer sessions. */
export function formatRecordingTime(elapsedSeconds: number): string {
  const h = Math.floor(elapsedSeconds / 3600);
  const m = Math.floor((elapsedSeconds % 3600) / 60);
  const s = elapsedSeconds % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Parse ISO datetime to local Date (Graph/Calendar often omit Z). */
export function parseIsoLocalDate(iso: string): Date | null {
  if (!iso) return null;
  const zoned =
    iso.includes("Z") || /[+-]\d\d:?\d\d$/.test(iso) ? iso : iso.split(".")[0] + "Z";
  const d = new Date(zoned);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Local calendar day key: YYYY-MM-DD */
export function toDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** First day of week for locale (0 = Sunday … 6 = Saturday). */
export function localeWeekStart(): number {
  try {
    const locale = new Intl.Locale(navigator.language);
    const info = (locale as Intl.Locale & { weekInfo?: { firstDay: number } }).weekInfo;
    if (info?.firstDay != null) {
      return info.firstDay === 7 ? 0 : info.firstDay;
    }
  } catch {
    /* Intl.Locale unsupported */
  }
  return 0;
}

/** Parse MM:SS or H:MM:SS to seconds. */
export function parseRecordingTime(label: string): number {
  const parts = label.split(":").map((p) => parseInt(p, 10));
  if (parts.some((n) => Number.isNaN(n))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}
