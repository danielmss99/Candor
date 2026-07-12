import { useEffect, useReducer } from "react";
import { captureMachineReducer, initialCaptureMachineState } from "../../state/operation-machines";

export function useCaptureSession(active: boolean, recordingId: string) {
  const [state, dispatch] = useReducer(captureMachineReducer, initialCaptureMachineState);

  useEffect(() => {
    dispatch({ type: "CORE_SYNC", active, recordingId: recordingId || undefined });
  }, [active, recordingId]);

  return {
    state,
    requestPermission: () => dispatch({ type: "REQUEST_PERMISSION" }),
    permissionGranted: () => dispatch({ type: "PERMISSION_GRANTED" }),
    started: (nextRecordingId: string) => dispatch({ type: "STARTED", recordingId: nextRecordingId }),
    stopRequested: () => dispatch({ type: "STOP_REQUESTED" }),
    finalizing: () => dispatch({ type: "FINALIZING" }),
    saved: (nextRecordingId: string) => dispatch({ type: "SAVED", recordingId: nextRecordingId }),
    recoveryStarted: () => dispatch({ type: "RECOVERY_STARTED" }),
    recovered: (nextRecordingId: string | null) => dispatch({ type: "RECOVERED", recordingId: nextRecordingId }),
    failed: (message: string) => dispatch({ type: "FAILED", message }),
    reset: () => dispatch({ type: "RESET" }),
  };
}
