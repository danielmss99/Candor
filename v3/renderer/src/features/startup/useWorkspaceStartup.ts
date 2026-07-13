import { useCallback, useEffect, useRef, useState } from "react";
import type { StartupPhase } from "./StartupState";

export function useWorkspaceStartup(refresh: () => Promise<void>) {
  const started = useRef(false);
  const retryWorkspaceLoad = refresh;
  const [phase, setPhase] = useState<StartupPhase>("loading");
  const [error, setError] = useState("");

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void refresh().then(() => {
      setPhase("ready");
      setError("");
    }).catch((reason) => {
      setError(reason instanceof Error ? reason.message : String(reason));
      setPhase("failed");
    });
  }, [refresh]);

  const retry = useCallback(() => {
    setPhase("loading");
    setError("");
    void retryWorkspaceLoad().then(() => {
      setPhase("ready");
    }).catch((reason) => {
      setError(reason instanceof Error ? reason.message : String(reason));
      setPhase("failed");
    });
  }, [retryWorkspaceLoad]);

  return { phase, error, retry };
}

