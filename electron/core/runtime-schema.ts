import { CoreClientError } from "./core-errors.js";
import type { JsonValue } from "./json.js";

export interface RuntimeSchema<T> {
  readonly name: string;
  parse(value: unknown): T;
}

export type JsonRuntimeSchema = RuntimeSchema<JsonValue>;

export type FieldRule =
  | "array"
  | "boolean"
  | "capture-session-or-null"
  | "integer"
  | "integer-or-null"
  | "number"
  | "object"
  | "string"
  | "string-array";

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 64) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  if (typeof value !== "object") return false;
  return Object.values(value).every((item) => isJsonValue(item, depth + 1));
}

function fieldMatches(value: JsonValue, rule: FieldRule): boolean {
  switch (rule) {
    case "array":
      return Array.isArray(value);
    case "boolean":
      return typeof value === "boolean";
    case "capture-session-or-null":
      return value === null || (
        typeof value === "object" &&
        !Array.isArray(value) &&
        typeof value.recordingId === "string" &&
        value.recordingId.length > 0
      );
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value);
    case "integer-or-null":
      return value === null || (typeof value === "number" && Number.isSafeInteger(value));
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "string-array":
      return Array.isArray(value) && value.every((item) => typeof item === "string");
  }
}

export function createRuntimeSchema<T>(name: string, parser: (value: unknown) => T): RuntimeSchema<T> {
  return Object.freeze({ name, parse: parser });
}

export function jsonObjectResultSchema(
  method: string,
  required: Readonly<Record<string, FieldRule>>,
): JsonRuntimeSchema {
  return createRuntimeSchema(`${method}.result`, (value) => {
    if (!isJsonValue(value) || value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new CoreClientError(
        "CORE_RESULT_SCHEMA_INVALID",
        `candor-core returned an invalid result for ${method}`,
        false,
      );
    }
    for (const [field, rule] of Object.entries(required)) {
      if (!(field in value) || !fieldMatches(value[field], rule)) {
        throw new CoreClientError(
          "CORE_RESULT_SCHEMA_INVALID",
          `candor-core returned an invalid ${field} field for ${method}`,
          false,
        );
      }
    }
    return value;
  });
}

export function jsonParamsSchema(
  method: string,
  parser: (value: unknown) => JsonValue,
): JsonRuntimeSchema {
  return createRuntimeSchema(`${method}.params`, (value) => {
    try {
      const parsed = parser(value);
      if (!isJsonValue(parsed)) throw new Error("parameters are not JSON serializable");
      return parsed;
    } catch (error) {
      throw new CoreClientError(
        "CORE_PARAMS_SCHEMA_INVALID",
        `Invalid parameters for ${method}`,
        false,
        { cause: error },
      );
    }
  });
}

export function assertJsonValue(value: unknown, label: string): JsonValue {
  if (!isJsonValue(value)) {
    throw new CoreClientError("CORE_PARAMS_SCHEMA_INVALID", `${label} must be valid JSON`, false);
  }
  return value;
}
