import { useCallback, useMemo } from "react";
import { CandorClient } from "../core/candor-client";
import { asBool, asObject, asString } from "../core/contracts";
import { useCaptureActions } from "../features/capture/useCaptureActions";
import { useCaptureSession } from "../features/capture/useCaptureSession";
import { useReportWorkflow } from "../features/export/useReportWorkflow";
import { useOperationRunner } from "../features/jobs/useOperationRunner";
import { useLicenseState } from "../features/licensing/useLicenseState";
import { useLocalAiWorkspace } from "../features/local-ai/useLocalAiWorkspace";
import { useMeetingActions } from "../features/meetings/useMeetingActions";
import {
  chooseInitialSelection,
  useMeetingWorkspace,
} from "../features/meetings/useMeetingWorkspace";
import { useOnboardingSettings } from "../features/onboarding/useOnboardingSettings";
import { useRuntimeStatus } from "../features/startup/useRuntimeStatus";
import { useWorkspaceStartup } from "../features/startup/useWorkspaceStartup";
import { AppRouteOutlet } from "./AppRouteOutlet";
import { useAppNavigation } from "./navigation";

export function CandorWorkspace() {
  const api = window.candor?.core;
  const licenseApi = window.candor?.license;
  const client = useMemo(() => (api ? new CandorClient(api) : null), [api]);
  const meeting = useMeetingWorkspace({ api, client });
  const navigation = useAppNavigation(meeting.selectedRecordingId);
  const runtime = useRuntimeStatus(api, client);
  const activeCapture = asBool(runtime.captureStatus.active);
  const activeRecordingId = asString(asObject(runtime.captureStatus.activeSession).recordingId);
  const captureSession = useCaptureSession(activeCapture, activeRecordingId);
  const operations = useOperationRunner(captureSession.failed);
  const handleLicenseLoadError = useCallback(
    (message: string) => operations.setError(message),
    [operations.setError],
  );
  const license = useLicenseState(licenseApi, handleLicenseLoadError);
  const localAi = useLocalAiWorkspace({
    api,
    client,
    selectedRecordingId: meeting.selectedRecordingId,
    selectedTrack: meeting.selectedTrack,
    instructAssetsStatus: runtime.instructAssetsStatus,
    instructStatus: runtime.instructStatus,
    modelStatus: runtime.modelStatus,
    run: operations.run,
    acquireOperation: operations.acquire,
    localJob: operations.job,
    setBusy: operations.setBusy,
    setNotice: operations.setNotice,
    setError: operations.setError,
    refreshModelsAndAi: runtime.refreshModelsAndAi,
    refreshLibrary: meeting.refreshLibrary,
    loadRecording: meeting.loadSelectedRecording,
    refreshPrivacyReceipt: meeting.refreshPrivacyReceipt,
  });
  const meetingActions = useMeetingActions({
    api,
    run: operations.run,
    recordings: meeting.recordings,
    selectedRecordingId: meeting.selectedRecordingId,
    selectedTrack: meeting.selectedTrack,
    notesMarkdown: meeting.notesMarkdown,
    searchQuery: meeting.searchQuery,
    transcriptHasMore: meeting.transcriptHasMore,
    setSelectedRecordingId: meeting.setSelectedRecordingId,
    setNotesMarkdown: meeting.setNotesMarkdown,
    setNotesStatus: meeting.setNotesStatus,
    setNotesDirty: meeting.setNotesDirty,
    setMarkedMoments: meeting.setMarkedMoments,
    refreshLibrary: meeting.refreshLibrary,
    refreshPrivacyReceipt: meeting.refreshPrivacyReceipt,
    loadRecording: meeting.loadSelectedRecording,
    loadMoreTranscriptPage: meeting.loadMoreTranscript,
    searchLibrary: meeting.search,
    resetMeetingAi: localAi.resetMeetingAi,
    setView: navigation.setView,
    setNotice: operations.setNotice,
    setError: operations.setError,
  });
  const report = useReportWorkflow({
    api,
    selectedRecordingId: meeting.selectedRecordingId,
    notesMarkdown: meeting.notesMarkdown,
    notesDirty: meeting.notesDirty,
    recap: localAi.recap,
    run: operations.run,
    setNotesStatus: meeting.setNotesStatus,
    setNotesDirty: meeting.setNotesDirty,
    setNotice: operations.setNotice,
    refreshPrivacyReceipt: meeting.refreshPrivacyReceipt,
  });
  const combinedCaptureAvailable = asBool(
    asObject(asObject(runtime.captureStatus.sources).system).simultaneousMicAndSystem,
  );
  const captureActions = useCaptureActions({
    api,
    captureSession,
    captureStatus: runtime.captureStatus,
    consentStatus: runtime.consentStatus,
    activeCapture,
    combinedCaptureAvailable,
    recordingTitle: meeting.recordingTitle,
    run: operations.run,
    refreshCapture: runtime.refreshCapture,
    refreshLibrary: meeting.refreshLibrary,
    loadRecording: meeting.loadSelectedRecording,
    onOpenRecordingSettings: () => {
      navigation.setSettingsSection("recording");
      navigation.setView("settings");
    },
    onShowLive: () => navigation.setView("meeting"),
    onSelectRecording: meeting.setSelectedRecordingId,
    onPinRecording: meetingActions.pinRecording,
    onNotice: operations.setNotice,
    onError: operations.setError,
  });
  const onboarding = useOnboardingSettings({
    api,
    licenseAvailable: Boolean(licenseApi),
    licenseLoaded: license.loaded,
    licenseStatus: license.status,
    licensePromptDismissed: license.promptDismissed,
    recordingCount: meeting.recordings.length,
    captureStatus: runtime.captureStatus,
    consentStatus: runtime.consentStatus,
    vaultStatus: runtime.vaultStatus,
    run: operations.run,
    activateLicense: license.activate,
    startTrial: license.startTrial,
    deactivateLicense: license.deactivate,
    dismissLicensePrompt: () => license.setPromptDismissed(true),
    importModel: localAi.importModel,
    refreshCapture: runtime.refreshCapture,
    refreshModelsAndAi: runtime.refreshModelsAndAi,
    refreshPrivacyFacts: runtime.refreshPrivacyFacts,
    refreshVaultAndRetention: runtime.refreshVaultAndRetention,
    setConsentStatus: runtime.setConsentStatus,
    setView: navigation.setView,
    setNotice: operations.setNotice,
    setError: operations.setError,
  });
  const refresh = useCallback(async () => {
    if (!api || !client) throw new Error("Candor preload API is unavailable");
    const [, recordings] = await Promise.all([
      runtime.loadCritical(),
      meeting.refreshLibrary(0),
    ]);
    const recordingId = chooseInitialSelection(meeting.selectedRecordingId, recordings);
    meeting.setSelectedRecordingId(recordingId);
    if (recordingId) await meeting.loadSelectedRecording(recordingId);
    void runtime.loadDiagnostics();
  }, [
    api,
    client,
    meeting.loadSelectedRecording,
    meeting.refreshLibrary,
    meeting.selectedRecordingId,
    meeting.setSelectedRecordingId,
    runtime.loadCritical,
    runtime.loadDiagnostics,
  ]);
  const startup = useWorkspaceStartup(refresh);

  return (
    <AppRouteOutlet
      licenseApiAvailable={Boolean(licenseApi)}
      runtime={runtime}
      meeting={meeting}
      navigation={navigation}
      captureSession={captureSession}
      captureActions={captureActions}
      operations={operations}
      license={license}
      localAi={localAi}
      meetingActions={meetingActions}
      report={report}
      onboarding={onboarding}
      startup={startup}
    />
  );
}
