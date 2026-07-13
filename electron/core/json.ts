export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export function objectValue(value: JsonValue): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

export function stringField(value: JsonValue, field: string): string {
  const child = objectValue(value)[field];
  return typeof child === "string" ? child : "";
}
