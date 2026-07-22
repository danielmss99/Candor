import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

export interface DiarizationStatus {
  state: "loading" | "disabled" | "engine-unavailable" | "gated" | "ready" | "unavailable";
  reasonCode: string;
  enabledByUser: boolean;
  engineAvailable: boolean;
  diarizationAvailable: boolean;
  modelVerified: boolean;
  licenseEvidenceVerified: boolean;
  redistributionAllowed: boolean;
  benchmarkPassed: boolean;
  benchmarkRequired: boolean;
  encryptedAtRest: boolean;
}

export interface SpeakerNameAssignment {
  anonymousSpeakerId: string;
  displayName: string;
}

export interface DiarizationController {
  status: DiarizationStatus;
  assignments: SpeakerNameAssignment[];
  loading: boolean;
  busy: boolean;
  notice: string;
  error: string;
  setEnabled(enabled: boolean): Promise<void>;
  assign(anonymousSpeakerId: string, displayName: string): Promise<void>;
  remove(anonymousSpeakerId: string): Promise<void>;
  refreshDiarization(): Promise<void>;
}

interface DiarizationSettingsProps {
  selectedRecordingId: string;
  controller?: DiarizationController;
}

const unavailableStatus: DiarizationStatus = {
  state: "unavailable",
  reasonCode: "DIARIZATION_STATUS_UNAVAILABLE",
  enabledByUser: false,
  engineAvailable: false,
  diarizationAvailable: false,
  modelVerified: false,
  licenseEvidenceVerified: false,
  redistributionAllowed: false,
  benchmarkPassed: false,
  benchmarkRequired: true,
  encryptedAtRest: true,
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function parseDiarizationStatus(value: unknown): DiarizationStatus {
  const source = object(value);
  const state = source.state;
  if (
    state !== "disabled"
    && state !== "engine-unavailable"
    && state !== "gated"
    && state !== "ready"
  ) {
    return unavailableStatus;
  }
  const enabledByUser = source.enabledByUser === true;
  const engineAvailable = source.engineAvailable === true;
  const normalizedState = !enabledByUser
    ? "disabled"
    : !engineAvailable
      ? "engine-unavailable"
      : state;
  return {
    state: normalizedState,
    reasonCode: typeof source.reasonCode === "string" ? source.reasonCode : "DIARIZATION_STATUS_UNAVAILABLE",
    enabledByUser,
    engineAvailable,
    diarizationAvailable: engineAvailable && normalizedState === "ready" && source.diarizationAvailable === true,
    modelVerified: source.modelVerified === true,
    licenseEvidenceVerified: source.licenseEvidenceVerified === true,
    redistributionAllowed: source.redistributionAllowed === true,
    benchmarkPassed: source.benchmarkPassed === true,
    benchmarkRequired: source.benchmarkRequired === true,
    encryptedAtRest: source.encryptedAtRest === true,
  };
}

export function parseSpeakerNames(value: unknown): SpeakerNameAssignment[] {
  const assignments = object(value).assignments;
  if (!Array.isArray(assignments)) return [];
  return assignments.flatMap((candidate) => {
    const assignment = object(candidate);
    if (
      typeof assignment.anonymousSpeakerId !== "string"
      || !/^speaker-[1-9][0-9]{0,3}$/.test(assignment.anonymousSpeakerId)
      || typeof assignment.displayName !== "string"
      || assignment.displayName.trim() !== assignment.displayName
      || assignment.displayName.length === 0
      || assignment.displayName.length > 80
      || assignment.userControlled !== true
      || assignment.identityInferred !== false
      || assignment.biometricIdentityClaimed !== false
    ) {
      return [];
    }
    return [{
      anonymousSpeakerId: assignment.anonymousSpeakerId,
      displayName: assignment.displayName,
    }];
  });
}

function message(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "Diarization settings are temporarily unavailable.";
}

function useDiarizationController(selectedRecordingId: string, active: boolean): DiarizationController {
  const [status, setStatus] = useState<DiarizationStatus>({ ...unavailableStatus, state: "loading" });
  const [assignments, setAssignments] = useState<SpeakerNameAssignment[]>([]);
  const [loading, setLoading] = useState(active);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const refreshDiarization = useCallback(async () => {
    if (!active) return;
    const api = window.candor?.diarization;
    if (!api) {
      setStatus(unavailableStatus);
      setAssignments([]);
      setError("The local diarization service is unavailable.");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const [statusValue, namesValue] = await Promise.all([
        api.getStatus(),
        selectedRecordingId ? api.getSpeakerNames(selectedRecordingId) : Promise.resolve(null),
      ]);
      setStatus(parseDiarizationStatus(statusValue));
      setAssignments(parseSpeakerNames(namesValue));
    } catch (cause) {
      setStatus(unavailableStatus);
      setAssignments([]);
      setError(message(cause));
    } finally {
      setLoading(false);
    }
  }, [active, selectedRecordingId]);

  useEffect(() => {
    void refreshDiarization();
  }, [refreshDiarization]);

  const setEnabled = useCallback(async (enabled: boolean) => {
    const api = window.candor?.diarization;
    if (!api) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      setStatus(parseDiarizationStatus(await api.setEnabled(enabled)));
      setNotice(enabled
        ? "Preference saved locally. Speaker separation remains gated until every local requirement passes."
        : "Diarization preference disabled locally.");
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  const assign = useCallback(async (anonymousSpeakerId: string, displayName: string) => {
    const api = window.candor?.diarization;
    if (!api || !selectedRecordingId) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api.assignSpeakerName(selectedRecordingId, anonymousSpeakerId, displayName);
      setAssignments(parseSpeakerNames(result));
      setNotice("Speaker name saved locally. Candor did not infer this identity.");
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }, [selectedRecordingId]);

  const remove = useCallback(async (anonymousSpeakerId: string) => {
    const api = window.candor?.diarization;
    if (!api || !selectedRecordingId) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api.removeSpeakerName(selectedRecordingId, anonymousSpeakerId);
      setAssignments(parseSpeakerNames(result));
      setNotice("Speaker name removed.");
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }, [selectedRecordingId]);

  return { status, assignments, loading, busy, notice, error, setEnabled, assign, remove, refreshDiarization };
}

function statusCopy(status: DiarizationStatus): { label: string; detail: string } {
  if (status.state === "loading") {
    return { label: "Checking", detail: "Checking local diarization requirements." };
  }
  if (!status.engineAvailable) {
    return {
      label: status.enabledByUser ? "Unavailable" : "Off",
      detail: "No local diarization engine is included yet. This preference never starts a network service or guesses who is speaking.",
    };
  }
  if (!status.modelVerified) {
    return { label: "Model required", detail: "A core-verified local diarization model is required." };
  }
  if (!status.licenseEvidenceVerified || !status.redistributionAllowed) {
    return { label: "License review required", detail: "Reviewed local-use and redistribution evidence is required for this exact model." };
  }
  if (!status.benchmarkPassed) {
    return { label: "Performance check required", detail: "A passing local benchmark is required before speaker separation can run." };
  }
  if (status.diarizationAvailable) {
    return { label: "Ready", detail: "Verified local speaker separation is available for future processing." };
  }
  return { label: "Gated", detail: "Local diarization requirements have not all passed." };
}

export function DiarizationSettings({ selectedRecordingId, controller: suppliedController }: DiarizationSettingsProps) {
  const localController = useDiarizationController(selectedRecordingId, !suppliedController);
  const controller = suppliedController ?? localController;
  const [speakerId, setSpeakerId] = useState("speaker-1");
  const [displayName, setDisplayName] = useState("");
  const copy = useMemo(() => statusCopy(controller.status), [controller.status]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const normalizedName = displayName.trim();
    if (!/^speaker-[1-9][0-9]{0,3}$/.test(speakerId) || !normalizedName) return;
    void controller.assign(speakerId, normalizedName).then(() => setDisplayName(""));
  };

  return (
    <section className="settings-group diarization-settings" aria-labelledby="diarization-heading">
      <div className="settings-group-heading">
        <div>
          <h3 id="diarization-heading">Speaker separation</h3>
          <p>Optional local diarization with anonymous speaker labels and names you control.</p>
        </div>
        <span className="settings-status-label">{copy.label}</span>
      </div>
      <p className="diarization-gate-copy">{copy.detail}</p>
      <dl className="settings-facts diarization-facts">
        <div><dt>Local engine</dt><dd>{controller.status.engineAvailable ? "Available" : "Unavailable"}</dd></div>
        <div><dt>Model integrity</dt><dd>{controller.status.modelVerified ? "Verified" : "Not verified"}</dd></div>
        <div><dt>License evidence</dt><dd>{controller.status.licenseEvidenceVerified && controller.status.redistributionAllowed ? "Reviewed and redistributable" : "Required"}</dd></div>
        <div><dt>Performance check</dt><dd>{controller.status.benchmarkPassed ? "Passed" : "Not passed"}</dd></div>
        <div><dt>Identity inference</dt><dd>Never</dd></div>
      </dl>
      <div className="settings-actions">
        <button
          type="button"
          aria-pressed={controller.status.enabledByUser}
          disabled={controller.loading || controller.busy || controller.status.state === "unavailable"}
          onClick={() => void controller.setEnabled(!controller.status.enabledByUser)}
        >
          {controller.status.enabledByUser ? "Disable preference" : "Enable for future use"}
        </button>
        <button type="button" disabled={controller.loading || controller.busy} onClick={() => void controller.refreshDiarization()}>
          Refresh status
        </button>
      </div>
      {controller.error ? <p className="diarization-message error" role="alert">{controller.error}</p> : null}
      {controller.notice ? <p className="diarization-message" role="status">{controller.notice}</p> : null}
      <details className="diarization-speaker-names">
        <summary>Speaker names for the selected meeting</summary>
        <p>Names are encrypted locally and attached only by you. Candor does not use them as biometric identity evidence.</p>
        {!selectedRecordingId ? (
          <p className="diarization-empty">Open a meeting before assigning an anonymous speaker label.</p>
        ) : (
          <>
            {controller.assignments.length ? (
              <ul aria-label="Saved speaker names">
                {controller.assignments.map((assignment) => (
                  <li key={assignment.anonymousSpeakerId}>
                    <span><strong>{assignment.displayName}</strong><small>{assignment.anonymousSpeakerId}</small></span>
                    <button
                      type="button"
                      disabled={controller.busy}
                      aria-label={`Remove ${assignment.displayName} from ${assignment.anonymousSpeakerId}`}
                      onClick={() => void controller.remove(assignment.anonymousSpeakerId)}
                    >Remove</button>
                  </li>
                ))}
              </ul>
            ) : <p className="diarization-empty">No user-controlled speaker names are saved for this meeting.</p>}
            <form onSubmit={submit}>
              <label>
                <span>Anonymous label</span>
                <input
                  value={speakerId}
                  pattern="speaker-[1-9][0-9]{0,3}"
                  maxLength={12}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  onChange={(event) => setSpeakerId(event.target.value)}
                />
              </label>
              <label>
                <span>Display name</span>
                <input
                  value={displayName}
                  maxLength={80}
                  onChange={(event) => setDisplayName(event.target.value)}
                />
              </label>
              <button
                type="submit"
                disabled={controller.busy || !/^speaker-[1-9][0-9]{0,3}$/.test(speakerId) || !displayName.trim()}
              >Save name</button>
            </form>
          </>
        )}
      </details>
    </section>
  );
}
