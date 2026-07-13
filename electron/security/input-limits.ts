export const INPUT_LIMITS = Object.freeze({
  meetingTitle: 200,
  notesCharacters: 2_000_000,
  searchQuery: 500,
  exportFilename: 150,
  pageSize: 100,
  eventPayloadBytes: 1_000_000,
  rpcLineBytes: 4_000_000,
  modelId: 64,
  licenseKey: 256,
  email: 320,
});

export function boundedString(value: unknown, maximum: number): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  return normalized.length <= maximum ? normalized : "";
}

export function validRecordingId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

export function validModelId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(value);
}
