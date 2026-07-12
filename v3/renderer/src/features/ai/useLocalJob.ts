import { useReducer, useRef } from "react";
import { initialJobMachineState, jobMachineReducer, type JobKind } from "../../state/operation-machines";

export function useLocalJob() {
  const [state, dispatch] = useReducer(jobMachineReducer, initialJobMachineState);
  const sequence = useRef(0);

  return {
    state,
    begin(kind: JobKind) {
      const requestId = ++sequence.current;
      dispatch({ type: "QUEUE", kind, requestId });
      dispatch({ type: "START", requestId });
      return requestId;
    },
    complete(requestId: number) {
      dispatch({ type: "COMPLETE", requestId });
    },
    cancel(requestId: number) {
      dispatch({ type: "CANCEL", requestId });
    },
    fail(requestId: number, message: string) {
      dispatch({ type: "FAIL", requestId, message });
    },
    reset() {
      dispatch({ type: "RESET" });
    },
  };
}
