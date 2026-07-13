export type CoreClientErrorCode =
  | "CORE_METHOD_DENIED"
  | "CORE_UNAVAILABLE"
  | "CORE_TIMEOUT"
  | "CORE_PARAMS_SCHEMA_INVALID"
  | "CORE_RESULT_SCHEMA_INVALID"
  | "CORE_PROTOCOL_FAULT"
  | "CORE_PROTOCOL_MISMATCH"
  | "CORE_CAPTURE_ACTIVE"
  | "CORE_CAPTURE_FINALIZE_FAILED"
  | "CORE_CAPTURE_FINALIZE_TIMEOUT"
  | "CORE_PROCESS_EXITED";

export class CoreClientError extends Error {
  readonly code: CoreClientErrorCode;
  readonly retryable: boolean;

  constructor(code: CoreClientErrorCode, message: string, retryable: boolean, options?: ErrorOptions) {
    super(message, options);
    this.name = "CoreClientError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
