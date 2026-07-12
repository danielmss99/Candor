export type CapturePhase =
  | "idle"
  | "requesting-permission"
  | "starting"
  | "recording"
  | "stopping"
  | "finalizing"
  | "saved"
  | "recovering"
  | "failed";

export interface CaptureMachineState {
  phase: CapturePhase;
  recordingId: string | null;
  error: string | null;
}

export type CaptureMachineEvent =
  | { type: "REQUEST_PERMISSION" }
  | { type: "PERMISSION_GRANTED" }
  | { type: "STARTED"; recordingId: string }
  | { type: "STOP_REQUESTED" }
  | { type: "FINALIZING" }
  | { type: "SAVED"; recordingId: string }
  | { type: "RECOVERY_STARTED" }
  | { type: "RECOVERED"; recordingId: string | null }
  | { type: "CORE_SYNC"; active: boolean; recordingId?: string }
  | { type: "FAILED"; message: string }
  | { type: "RESET" };

export const initialCaptureMachineState: CaptureMachineState = {
  phase: "idle",
  recordingId: null,
  error: null,
};

export function captureMachineReducer(
  state: CaptureMachineState,
  event: CaptureMachineEvent,
): CaptureMachineState {
  if (event.type === "FAILED") {
    return { ...state, phase: "failed", error: event.message };
  }
  if (event.type === "RESET") return initialCaptureMachineState;
  if (event.type === "CORE_SYNC") {
    if (event.active) {
      return {
        phase: "recording",
        recordingId: event.recordingId ?? state.recordingId,
        error: null,
      };
    }
    if (state.phase === "recording") return initialCaptureMachineState;
    return state;
  }

  switch (state.phase) {
    case "idle":
    case "saved":
    case "failed":
      if (event.type === "REQUEST_PERMISSION") {
        return { phase: "requesting-permission", recordingId: null, error: null };
      }
      if (event.type === "RECOVERY_STARTED") {
        return { phase: "recovering", recordingId: state.recordingId, error: null };
      }
      return state;
    case "requesting-permission":
      if (event.type === "PERMISSION_GRANTED") {
        return { phase: "starting", recordingId: null, error: null };
      }
      return state;
    case "starting":
      if (event.type === "STARTED") {
        return { phase: "recording", recordingId: event.recordingId, error: null };
      }
      if (event.type === "STOP_REQUESTED") {
        return { phase: "stopping", recordingId: state.recordingId, error: null };
      }
      return state;
    case "recording":
      if (event.type === "STOP_REQUESTED") {
        return { phase: "stopping", recordingId: state.recordingId, error: null };
      }
      return state;
    case "stopping":
      if (event.type === "FINALIZING") {
        return { phase: "finalizing", recordingId: state.recordingId, error: null };
      }
      if (event.type === "SAVED") {
        return { phase: "saved", recordingId: event.recordingId, error: null };
      }
      return state;
    case "finalizing":
      if (event.type === "SAVED") {
        return { phase: "saved", recordingId: event.recordingId, error: null };
      }
      return state;
    case "recovering":
      if (event.type === "RECOVERED") {
        return { phase: "idle", recordingId: event.recordingId, error: null };
      }
      return state;
  }
}

export type JobPhase = "idle" | "queued" | "running" | "canceling" | "completed" | "failed";
export type JobKind = "transcription" | "recap" | "ask" | "notes-save" | "export" | "model-import";

export interface JobMachineState {
  phase: JobPhase;
  kind: JobKind | null;
  requestId: number;
  error: string | null;
}

export type JobMachineEvent =
  | { type: "QUEUE"; kind: JobKind; requestId: number }
  | { type: "START"; requestId: number }
  | { type: "CANCEL"; requestId: number }
  | { type: "COMPLETE"; requestId: number }
  | { type: "FAIL"; requestId: number; message: string }
  | { type: "RESET" };

export const initialJobMachineState: JobMachineState = {
  phase: "idle",
  kind: null,
  requestId: 0,
  error: null,
};

export function jobMachineReducer(state: JobMachineState, event: JobMachineEvent): JobMachineState {
  if (event.type === "RESET") return initialJobMachineState;
  if (event.type === "QUEUE") {
    if (state.phase === "queued" || state.phase === "running" || state.phase === "canceling") return state;
    return { phase: "queued", kind: event.kind, requestId: event.requestId, error: null };
  }
  if (event.requestId !== state.requestId) return state;
  if (event.type === "START" && state.phase === "queued") return { ...state, phase: "running" };
  if (event.type === "CANCEL" && (state.phase === "queued" || state.phase === "running")) {
    return { ...state, phase: "canceling" };
  }
  if (event.type === "COMPLETE" && state.phase !== "idle") return { ...state, phase: "completed" };
  if (event.type === "FAIL" && state.phase !== "idle") {
    return { ...state, phase: "failed", error: event.message };
  }
  return state;
}
