/** Graph returns UTC datetimes (sometimes without a Z); render in local time. */
export function fmtEventTime(iso: string): string {
  if (!iso) return "";
  const zoned = iso.includes("Z") || /[+-]\d\d:?\d\d$/.test(iso) ? iso : iso.split(".")[0] + "Z";
  const d = new Date(zoned);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
