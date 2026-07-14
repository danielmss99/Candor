import { useCallback, useEffect, useRef, useState } from "react";
import {
  asBool,
  asObject,
  asString,
  parseTerminologyProposals,
  parseTerminologyStatus,
  type TerminologyCorrectionProposal,
  type TerminologyStatus,
} from "../../core/contracts";
import type { RunOperation } from "../jobs/useOperationRunner";
import { waitForJob } from "../../core/jobs";

type CoreApi = NonNullable<Window["candor"]>;

const EMPTY_STATUS: TerminologyStatus = {
  state: "unavailable",
  dictionaryCount: 0,
  entryCount: 0,
  dictionaries: [],
  encryptedAtRest: true,
  projectScopeAvailable: false,
};

interface UseTerminologyWorkspaceOptions {
  api: CoreApi | undefined;
  selectedRecordingId: string;
  run: RunOperation;
  setNotice: (message: string) => void;
  setError: (message: string) => void;
}

function dictionaryImportNotice(result: Record<string, unknown>): string {
  const name = asString(result.name, "Dictionary");
  if (asBool(result.upgradeAvailable)) {
    const installed = asString(result.installedVersion, "the installed version");
    const available = asString(result.availableVersion, "a newer version");
    return `${name} ${available} is available. Version ${installed} remains installed.`;
  }
  if (asBool(result.alreadyInstalled)) {
    return `${name} is already installed`;
  }
  return `${name} added with ${String(result.entryCount ?? 0)} terms`;
}

export function useTerminologyWorkspace(options: UseTerminologyWorkspaceOptions) {
  const { api, selectedRecordingId, run, setNotice, setError } = options;
  const [status, setStatus] = useState<TerminologyStatus>(EMPTY_STATUS);
  const [proposals, setProposals] = useState<TerminologyCorrectionProposal[]>([]);
  const statusRequest = useRef(0);
  const proposalRequest = useRef(0);

  const refreshTerminology = useCallback(async () => {
    const request = ++statusRequest.current;
    if (!api) {
      if (request === statusRequest.current) setStatus(EMPTY_STATUS);
      return;
    }
    try {
      const next = parseTerminologyStatus(
        await api.terminology.getStatus(selectedRecordingId || undefined),
      );
      if (request === statusRequest.current) setStatus(next);
    } catch (reason) {
      if (request === statusRequest.current) throw reason;
    }
  }, [api, selectedRecordingId]);

  useEffect(() => {
    let active = true;
    setProposals([]);
    void refreshTerminology().catch((reason) => {
      if (!active) return;
      setStatus(EMPTY_STATUS);
      setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => {
      active = false;
      statusRequest.current += 1;
      proposalRequest.current += 1;
    };
  }, [refreshTerminology, setError]);

  const importDictionary = useCallback(async () => {
    if (!api) return;
    await run("dictionary import", async () => {
      const result = asObject(await api.terminology.importDictionary());
      if (asBool(result.canceled)) {
        setNotice("Dictionary import canceled");
        return;
      }
      if (asString(result.jobId)) {
        setNotice("Dictionary verification is running in the background");
        void waitForJob(api, result)
          .then(async (completed) => {
            const imported = asObject(completed);
            setNotice(dictionaryImportNotice(imported));
            await refreshTerminology();
          })
          .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
        return;
      }
      setNotice(dictionaryImportNotice(result));
      await refreshTerminology();
    }, "terminology");
  }, [api, refreshTerminology, run, setNotice]);

  const setEnabled = useCallback(async (dictionaryId: string, enabled: boolean) => {
    if (!api) return;
    await run("dictionary update", async () => {
      await api.terminology.setEnabled(dictionaryId, enabled);
      setNotice(enabled ? "Dictionary enabled" : "Dictionary disabled");
      await refreshTerminology();
    }, "terminology");
  }, [api, refreshTerminology, run, setNotice]);

  const assignToMeeting = useCallback(async (dictionaryId: string, enabled: boolean) => {
    if (!api || !selectedRecordingId) return;
    await run("dictionary assignment", async () => {
      await api.terminology.assignToMeeting(selectedRecordingId, dictionaryId, enabled);
      setNotice(enabled ? "Dictionary enabled for this meeting" : "Meeting dictionary assignment removed");
      await refreshTerminology();
    }, "terminology");
  }, [api, refreshTerminology, run, selectedRecordingId, setNotice]);

  const loadProposals = useCallback(async () => {
    const request = ++proposalRequest.current;
    if (!api || !selectedRecordingId) {
      if (request === proposalRequest.current) setProposals([]);
      return;
    }
    const recordingId = selectedRecordingId;
    await run("terminology review", async () => {
      const next = parseTerminologyProposals(
        await api.terminology.getCorrectionProposals(recordingId),
      );
      if (request !== proposalRequest.current) return;
      setProposals(next);
      setNotice(next.length ? `${next.length} correction suggestion${next.length === 1 ? "" : "s"} ready for review` : "No terminology corrections suggested");
    }, "terminology");
  }, [api, run, selectedRecordingId, setNotice]);

  const decide = useCallback(async (
    proposalId: string,
    decision: "accepted" | "rejected",
  ) => {
    if (!api || !selectedRecordingId) return;
    await run("terminology decision", async () => {
      await api.terminology.decideCorrection(selectedRecordingId, proposalId, decision);
      setProposals((current) => current.filter((proposal) => proposal.proposalId !== proposalId));
      setNotice(decision === "accepted" ? "Preferred terminology saved" : "Suggestion rejected");
      await refreshTerminology();
    }, "terminology");
  }, [api, refreshTerminology, run, selectedRecordingId, setNotice]);

  return {
    status,
    proposals,
    refreshTerminology,
    importDictionary,
    setEnabled,
    assignToMeeting,
    loadProposals,
    decide,
  };
}
