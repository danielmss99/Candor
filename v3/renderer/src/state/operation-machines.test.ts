import { describe, expect, it } from "vitest";
import {
  captureMachineReducer,
  initialCaptureMachineState,
  initialJobMachineState,
  jobMachineReducer,
} from "./operation-machines";

describe("capture state machine", () => {
  it("models the normal record and save path", () => {
    let state = captureMachineReducer(initialCaptureMachineState, { type: "REQUEST_PERMISSION" });
    state = captureMachineReducer(state, { type: "PERMISSION_GRANTED" });
    state = captureMachineReducer(state, { type: "STARTED", recordingId: "rec-1" });
    state = captureMachineReducer(state, { type: "STOP_REQUESTED" });
    state = captureMachineReducer(state, { type: "FINALIZING" });
    state = captureMachineReducer(state, { type: "SAVED", recordingId: "rec-1" });
    expect(state).toEqual({ phase: "saved", recordingId: "rec-1", error: null });
  });

  it("deduplicates a second start while startup is pending", () => {
    const requesting = captureMachineReducer(initialCaptureMachineState, { type: "REQUEST_PERMISSION" });
    const starting = captureMachineReducer(requesting, { type: "PERMISSION_GRANTED" });
    expect(captureMachineReducer(starting, { type: "REQUEST_PERMISSION" })).toBe(starting);
  });

  it("allows stop to win while start is still pending", () => {
    const requesting = captureMachineReducer(initialCaptureMachineState, { type: "REQUEST_PERMISSION" });
    const starting = captureMachineReducer(requesting, { type: "PERMISSION_GRANTED" });
    expect(captureMachineReducer(starting, { type: "STOP_REQUESTED" }).phase).toBe("stopping");
  });

  it("reconciles a renderer restart from the core capture fact", () => {
    const restored = captureMachineReducer(initialCaptureMachineState, {
      type: "CORE_SYNC",
      active: true,
      recordingId: "rec-live",
    });
    expect(restored).toEqual({ phase: "recording", recordingId: "rec-live", error: null });
  });
});

describe("local job state machine", () => {
  it("ignores duplicate work and stale completion", () => {
    const queued = jobMachineReducer(initialJobMachineState, { type: "QUEUE", kind: "transcription", requestId: 4 });
    expect(jobMachineReducer(queued, { type: "QUEUE", kind: "export", requestId: 5 })).toBe(queued);
    const running = jobMachineReducer(queued, { type: "START", requestId: 4 });
    expect(jobMachineReducer(running, { type: "COMPLETE", requestId: 3 })).toBe(running);
    expect(jobMachineReducer(running, { type: "COMPLETE", requestId: 4 }).phase).toBe("completed");
  });

  it("represents AI cancellation explicitly", () => {
    const queued = jobMachineReducer(initialJobMachineState, { type: "QUEUE", kind: "ask", requestId: 7 });
    const running = jobMachineReducer(queued, { type: "START", requestId: 7 });
    expect(jobMachineReducer(running, { type: "CANCEL", requestId: 7 }).phase).toBe("canceling");
  });
});
