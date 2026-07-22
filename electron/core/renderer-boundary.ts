import { objectValue, type JsonValue } from "./json.js";

const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

export function rendererSafeCoreError(code: unknown): Error {
  const safeCode = typeof code === "string" && SAFE_ERROR_CODE.test(code)
    ? code
    : "CORE_REQUEST_FAILED";
  return new Error(`CANDOR_CORE_ERROR:${safeCode}`);
}

export function sanitizeCoreResultForRenderer(
  method: string,
  result: JsonValue,
  allowedFields?: readonly string[],
): JsonValue {
  const source = objectValue(result);
  if (allowedFields) {
    return Object.fromEntries(
      allowedFields
        .filter((field) => Object.hasOwn(source, field))
        .map((field) => [field, source[field]]),
    );
  }
  if (method !== "core.status") return result;
  const status = { ...source };
  delete status.pid;
  return status;
}
