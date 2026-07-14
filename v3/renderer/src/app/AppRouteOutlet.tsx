import { useMemo } from "react";
import { AnimatedTranscript, type EvidenceMarker } from "../meeting-motion";
import { ExportView } from "../features/export/ExportView";
import { HomeView } from "../features/home/HomeView";
import { LibraryView } from "../features/library/LibraryView";
import { LiveMeetingView } from "../features/meeting/LiveMeetingView";
import { ActivationGate, OnboardingSetup } from "../features/onboarding/ActivationFlow";
import { MeetingDetailView } from "../features/detail/MeetingDetailView";
import { ReviewView } from "../features/review/ReviewView";
import { SettingsView } from "../features/settings/SettingsView";
import { StartupLoading, StartupRecovery } from "../features/startup/StartupState";
import { shouldShowActivationPrompt } from "../features/licensing/access-policy";
import { buildPersistentAlerts } from "../features/recovery/system-alerts";
import {
  DEFAULT_MODEL,
  asBool,
  asNumber,
  asObject,
  asString,
  metric,
} from "../core/contracts";
import { AppShell } from "./AppShell";
import type { useRuntimeStatus } from "../features/startup/useRuntimeStatus";
import type { useMeetingWorkspace } from "../features/meetings/useMeetingWorkspace";
import type { useAppNavigation } from "./navigation";
import type { useCaptureSession } from "../features/capture/useCaptureSession";
import { shouldDisableRecordControl, type useCaptureActions } from "../features/capture/useCaptureActions";
import type { useOperationRunner } from "../features/jobs/useOperationRunner";
import type { useLicenseState } from "../features/licensing/useLicenseState";
import type { useLocalAiWorkspace } from "../features/local-ai/useLocalAiWorkspace";
import type { useMeetingActions } from "../features/meetings/useMeetingActions";
import type { useReportWorkflow } from "../features/export/useReportWorkflow";
import type { useOnboardingSettings } from "../features/onboarding/useOnboardingSettings";
import type { useDiagnosticExport } from "../features/privacy/useDiagnosticExport";
import type { useWorkspaceStartup } from "../features/startup/useWorkspaceStartup";
import type { useTerminologyWorkspace } from "../features/terminology/useTerminologyWorkspace";

interface AppRouteOutletProps {
  licenseApiAvailable: boolean;
  runtime: ReturnType<typeof useRuntimeStatus>;
  meeting: ReturnType<typeof useMeetingWorkspace>;
  navigation: ReturnType<typeof useAppNavigation>;
  captureSession: ReturnType<typeof useCaptureSession>;
  captureActions: ReturnType<typeof useCaptureActions>;
  operations: ReturnType<typeof useOperationRunner>;
  license: ReturnType<typeof useLicenseState>;
  localAi: ReturnType<typeof useLocalAiWorkspace>;
  terminology: ReturnType<typeof useTerminologyWorkspace>;
  meetingActions: ReturnType<typeof useMeetingActions>;
  report: ReturnType<typeof useReportWorkflow>;
  onboarding: ReturnType<typeof useOnboardingSettings>;
  diagnostics: ReturnType<typeof useDiagnosticExport>;
  startup: ReturnType<typeof useWorkspaceStartup>;
}

export function AppRouteOutlet(props: AppRouteOutletProps) {
  const {
    runtime,
    meeting,
    navigation,
    captureSession,
    captureActions,
    operations,
    license,
    localAi,
    terminology,
    meetingActions,
    report,
    onboarding,
    diagnostics,
    startup,
  } = props;
  const activeCapture = asBool(runtime.captureStatus.active);
  const storageHealth = asObject(runtime.recordingStatus.storageHealth);
  const storageLevel = asString(storageHealth.level, "unavailable");
  const recordingBlocked = storageLevel === "blocking" || storageLevel === "unavailable";
  const recordControlDisabled = shouldDisableRecordControl(operations.busy, activeCapture, recordingBlocked);
  const persistentAlerts = buildPersistentAlerts({
    coreStatus: runtime.coreStatus,
    captureStatus: runtime.captureStatus,
    recordingStatus: runtime.recordingStatus,
    quarantinedCount: meeting.quarantinedCount,
  });
  const connectionDegraded = asString(runtime.connectionStatus.state) === "capture-connection-degraded";
  if (connectionDegraded && activeCapture) {
    persistentAlerts.unshift({
      id: "capture-connection-degraded",
      severity: "error",
      title: "Recording connection interrupted",
      message: "Candor lost contact with the recording service. The recording may still be active.",
      actions: [
        { label: "Try to reconnect", primary: true, onActivate: () => void runtime.retryConnection() },
        { label: "Stop recording", onActivate: () => void captureActions.stop() },
      ],
    });
  }
  const activeRecordingId = asString(asObject(runtime.captureStatus.activeSession).recordingId);
  const selectedRecording = meeting.recordings.find((item) => item.recordingId === meeting.selectedRecordingId);
  const selectedTitle = selectedRecording?.label || meeting.recordingTitle || "Untitled local meeting";
  const combinedCaptureAvailable = asBool(asObject(asObject(runtime.captureStatus.sources).system).simultaneousMicAndSystem);
  const licenseKeyInvalid = license.licenseKeyTouched && !license.licenseKey.trim();
  const captureMachine = captureSession.state;
  const jobMachine = operations.jobMachine;
  const rehydratedJob = runtime.jobs.find((job) => !asBool(job.terminal));
  const captureStatusLabel = captureMachine.phase === "idle"
    ? "Ready"
    : captureMachine.phase === "recording"
      ? "Recording"
      : captureMachine.phase === "requesting-permission"
        ? "Checking permission"
        : captureMachine.phase[0].toUpperCase() + captureMachine.phase.slice(1).replace("-", " ");
  const jobStatusLabel = rehydratedJob
    ? `${metric(rehydratedJob.type, "Local work")} ${metric(rehydratedJob.stage, "running")}`
    : jobMachine.phase === "running" && jobMachine.kind
    ? `${jobMachine.kind.replace("-", " ")} running locally`
    : jobMachine.phase === "failed"
      ? "Local job needs attention"
      : "Processing stays local";
  const transcriptionQualityLabel = localAi.transcriptionQualityStatus.tiers
    .find((tier) => tier.id === localAi.transcriptionQualityStatus.tier)?.label
    ?? "Fast";
  const custodyItems: Array<[string, string]> = [
    ["Network", metric(runtime.coreStatus.networkPolicy, "disabled-by-default")],
    ["Updates", asBool(runtime.updateStatus.backgroundChecks) ? "background" : metric(runtime.updateStatus.policy, "manual-check-only")],
    ["Encrypted storage", asBool(runtime.vaultStatus.encrypted) ? "protected" : "local"],
    ["Consent", asBool(runtime.consentStatus.readyForMicAndSystemAudioRecording) ? "all ready" : asBool(runtime.consentStatus.readyForMicRecording) ? "mic ready" : "required"],
    ["Notes", meeting.notesDirty ? "unsaved" : asBool(meeting.notesStatus.savedLocally) ? "saved" : "empty"],
    ["Retention", metric(runtime.retentionStatus.policy, "manual-delete-only")],
    ["Storage", storageLevel],
    ["External calls", metric(runtime.privacyAudit.externalCallsAttempted, "0")],
    ["Transport", metric(runtime.coreStatus.sidecarTransport, "stdio-json-lines")],
    ["Local AI", localAi.instructReady ? "model ready" : asBool(runtime.aiStatus.heuristicRecapImplemented) ? "fast fallback" : "pending"],
    ["Legacy import", asBool(runtime.v2ImportStatus.implemented) ? "available" : "pending"],
    ["Local processing", asBool(runtime.schedulerStatus.whisperLlmConcurrent) ? "needs attention" : "one task at a time"],
    ["Model import", metric(runtime.modelStatus.manualImportMethod, "native picker")],
    ["Diagnostics", runtime.diagnosticFailures.length ? `${runtime.diagnosticFailures.length} unavailable` : "ready"],
  ];
  const filteredRecordings = meeting.recordings.filter((recording) => {
    if (meetingActions.libraryFilter === "transcribed") return recording.transcriptSegmentCount > 0;
    if (meetingActions.libraryFilter === "audio") return recording.audioChunkCount > 0;
    return true;
  });
  const recapSuggestions = localAi.recap
    ? [...localAi.recap.decisions, ...localAi.recap.actions, ...localAi.recap.risks, ...localAi.recap.questions]
    : [];
  const timelineDurationMs = Math.max(
    asNumber(meeting.replay.durationMs),
    selectedRecording?.audioDurationMs ?? 0,
    asNumber(asObject(runtime.captureStatus.activeSession).durationMs),
    meeting.transcript.length ? meeting.transcript[meeting.transcript.length - 1].endMs : 0,
  );
  const evidenceMarkers = useMemo<EvidenceMarker[]>(() => [
    ...meeting.transcript.slice(0, 24).map((segment) => ({
      id: `transcript-${segment.index}-${segment.startMs}`,
      timeMs: segment.startMs,
      label: `${segment.speaker}: ${segment.text.slice(0, 64)}`,
      kind: "transcript" as const,
    })),
    ...meeting.markedMoments.map((moment) => ({ id: moment.id, timeMs: moment.timeMs, label: moment.label, kind: "note" as const })),
    ...(localAi.recap?.decisions ?? []).map((item) => ({ id: `decision-${item.segmentIndex}-${item.startMs}`, timeMs: item.startMs, label: item.text, kind: "decision" as const })),
    ...(localAi.recap?.actions ?? []).map((item) => ({ id: `action-${item.segmentIndex}-${item.startMs}`, timeMs: item.startMs, label: item.text, kind: "action" as const })),
  ], [localAi.recap, meeting.markedMoments, meeting.transcript]);

  const transcriptContent = (
    <div className="transcript-page-wrap">
      <AnimatedTranscript
        emptyMessage="No transcript yet. Record or transcribe this meeting locally to begin."
        segments={meeting.transcript.map((segment) => ({ id: `${segment.index}-${segment.startMs}`, speaker: segment.speaker, startMs: segment.startMs, channel: segment.channel, text: segment.text }))}
      />
      {meeting.transcriptHasMore ? <button type="button" className="load-more-button" onClick={() => void meetingActions.loadMoreTranscript()} disabled={Boolean(operations.busy)}>Load more transcript</button> : null}
      {meeting.transcriptTotalCount > 0 ? <span className="page-count">Showing {meeting.transcript.length} of {meeting.transcriptTotalCount} segments</span> : null}
    </div>
  );

  if (!license.loaded || startup.phase === "loading") return <StartupLoading />;
  if (startup.phase === "failed") return <StartupRecovery message={startup.error} retrying={false} onRetry={startup.retry} />;
  if (asBool(runtime.connectionStatus.captureRecoveryRequired) && !activeCapture) {
    return <StartupRecovery message="An interrupted recording must be checked before Candor continues." title="Recording recovery required" description="Candor preserved a local recovery marker after losing contact with the recording service. Existing meetings remain available and unchanged." actionLabel="Recover recording" retrying={runtime.recoveryBusy} onRetry={() => void runtime.recoverCapture()} />;
  }

  const showActivationPrompt = shouldShowActivationPrompt({
    licenseAvailable: props.licenseApiAvailable,
    licenseActive: license.active,
    promptDismissed: license.promptDismissed,
    existingRecordingCount: meeting.recordings.length,
  });
  if (props.licenseApiAvailable && (showActivationPrompt || (license.active && onboarding.step !== "app"))) {
    if (showActivationPrompt || onboarding.step === "activate") {
      return <ActivationGate licenseKey={license.licenseKey} licenseEmail={license.licenseEmail} licenseKeyInvalid={licenseKeyInvalid} licenseBusy={operations.busy === "license"} licenseStatus={license.status} onLicenseKeyChange={(value) => { license.setLicenseKey(value); license.setLicenseKeyTouched(false); }} onLicenseEmailChange={license.setLicenseEmail} onLicenseKeyBlur={() => license.setLicenseKeyTouched(true)} onActivate={() => void onboarding.activate()} onStartTrial={() => void onboarding.trial()} onContinueLocal={onboarding.continueWithoutActivation} />;
    }
    return <OnboardingSetup step={onboarding.step} licenseState={license.state} licenseStatus={license.status} captureStatus={runtime.captureStatus} consentStatus={runtime.consentStatus} vaultStatus={runtime.vaultStatus} modelStatus={runtime.modelStatus} bundledAiStatus={runtime.bundledAiStatus} aiModeStatus={localAi.aiModeStatus} instructReady={localAi.instructReady} busy={operations.busy} onStepChange={onboarding.setStep} onCompleteMic={() => void onboarding.completeMic()} onCompleteSystemAudio={() => void onboarding.completeSystemAudio()} onCompleteStorage={() => void onboarding.completeStorage()} onImportSpeechModel={() => void localAi.importModel()} onFinish={onboarding.finish} />;
  }

  let content;
  if (navigation.view === "home") {
    content = <HomeView recordings={meeting.recordings} activeCapture={activeCapture} combinedCaptureAvailable={combinedCaptureAvailable} busy={Boolean(operations.busy)} recordingBlocked={recordingBlocked} storageHealth={storageHealth} importAvailable={asBool(runtime.v2ImportStatus.implemented)} recordingTitle={meeting.recordingTitle} instructReady={localAi.instructReady} verifiedModelCount={runtime.modelStatus.verifiedModelCount} aiModeStatus={localAi.aiModeStatus} onStartRecording={() => void captureActions.startPreferred()} onOpenLibrary={() => navigation.setView("library")} onImport={() => void meetingActions.importV2Folder()} onRecordingTitleChange={meeting.setRecordingTitle} onOpenRecording={(recordingId) => void meetingActions.openRecording(recordingId, "detail")} />;
  } else if (navigation.view === "meeting") {
    content = <LiveMeetingView title={selectedTitle} selectedRecording={selectedRecording} selectedRecordingId={meeting.selectedRecordingId} activeRecordingId={activeRecordingId} activeCapture={activeCapture} consentReady={asBool(runtime.consentStatus.readyForMicRecording)} durationMs={timelineDurationMs} audioUrl={meetingActions.audioUrl} markers={evidenceMarkers} compactPane={meetingActions.compactMeetingPane} notesPanelMode={meetingActions.notesPanelMode} notesMarkdown={meeting.notesMarkdown} notesDirty={meeting.notesDirty} notesSaved={asBool(meeting.notesStatus.savedLocally)} recapSuggestions={recapSuggestions} aiMode={localAi.aiMode} aiModeStatus={localAi.aiModeStatus} transcriptionQualityLabel={transcriptionQualityLabel} localAiReadyLabel={localAi.instructReady ? "Ready" : "Fast local fallback"} captureStatusLabel={captureStatusLabel} jobStatusLabel={jobStatusLabel} busy={Boolean(operations.busy)} transcriptContent={transcriptContent} onReview={() => navigation.setView("review")} onReviewConsent={() => { navigation.setSettingsSection("recording"); navigation.setView("settings"); }} onLoadAudio={() => void meetingActions.loadAudio()} onMarkMoment={meetingActions.markMoment} onCompactPaneChange={meetingActions.setCompactMeetingPane} onNotesPanelModeChange={meetingActions.setNotesPanelMode} onTranscribe={() => void localAi.transcribe()} onNotesChange={meeting.updateNotes} onSaveNotes={() => void meetingActions.saveMeetingNotes()} onGenerateRecap={() => void localAi.generateRecap()} onAiModeChange={localAi.setAiMode} onStartStop={() => void captureActions.startPreferred()} />;
  } else if (navigation.view === "library") {
    content = <LibraryView recordings={meeting.recordings} filteredRecordings={filteredRecordings} recordingTotalCount={meeting.recordingTotalCount} recordingsHaveMore={meeting.recordingsHaveMore} searchQuery={meeting.searchQuery} searchMatches={meeting.searchMatches} libraryFilter={meetingActions.libraryFilter} busy={Boolean(operations.busy)} recordingBlocked={recordingBlocked} onSearchQueryChange={meeting.setSearchQuery} onSearch={() => void meetingActions.searchRecordings()} onFilterChange={meetingActions.setLibraryFilter} onOpenRecording={(recordingId) => void meetingActions.openRecording(recordingId, "detail")} onStartRecording={() => void captureActions.startPreferred()} onLoadMore={() => void meetingActions.loadMoreRecordings()} />;
  } else if (navigation.view === "detail") {
    content = <MeetingDetailView title={selectedTitle} selectedRecording={selectedRecording} selectedRecordingId={meeting.selectedRecordingId} detailSection={navigation.detailSection} transcriptContent={transcriptContent} transcriptTotalCount={meeting.transcriptTotalCount} notesMarkdown={meeting.notesMarkdown} notesDirty={meeting.notesDirty} recap={localAi.recap} askQuestion={localAi.askQuestion} askAnswer={localAi.askAnswer} aiModeStatus={localAi.aiModeStatus} privacyReceipt={meeting.privacyReceipt} networkCapabilities={runtime.networkCapabilities} busy={Boolean(operations.busy)} onDetailSectionChange={navigation.setDetailSection} onReview={() => navigation.setView("review")} onDelete={() => void meetingActions.deleteRecording()} onNotesChange={meeting.updateNotes} onSaveNotes={() => void meetingActions.saveMeetingNotes()} onGenerateRecap={() => void localAi.generateRecap()} onAskQuestionChange={localAi.setAskQuestion} onAsk={() => void localAi.ask()} />;
  } else if (navigation.view === "review") {
    content = <ReviewView title={selectedTitle} reviewSection={navigation.reviewSection} reviewStates={report.reviewStates} summaryDraft={report.summaryDraft} recap={localAi.recap} notesMarkdown={meeting.notesMarkdown} notesDirty={meeting.notesDirty} transcriptContent={transcriptContent} exportFormat={report.format} includeSummary={report.sections.summary} includeNotes={report.sections.notes} includeTranscript={report.sections.transcript} previewDecisions={report.preview.decisions} previewActions={report.preview.actions} previewRisks={report.preview.risks} previewQuestions={report.preview.questions} selectedRecordingId={meeting.selectedRecordingId} busy={Boolean(operations.busy)} onSectionChange={navigation.setReviewSection} onSummaryDraftChange={report.setSummaryDraft} onNotesChange={meeting.updateNotes} onSaveNotes={() => void meetingActions.saveMeetingNotes()} onGenerateRecap={() => void localAi.generateRecap()} onReviewItem={report.reviewItem} onOpenExport={() => navigation.setView("export")} />;
  } else if (navigation.view === "settings") {
    content = <SettingsView section={navigation.settingsSection} advancedOpen={onboarding.advancedSettingsOpen} busy={operations.busy} activeCapture={activeCapture} combinedCaptureAvailable={combinedCaptureAvailable} statuses={{ core: runtime.coreStatus, consent: runtime.consentStatus, capture: runtime.captureStatus, vault: runtime.vaultStatus, updates: runtime.updateStatus, retention: runtime.retentionStatus, transcription: runtime.transcriptionStatus }} bundledAiStatus={runtime.bundledAiStatus} transcriptionQuality={localAi.transcriptionQualityStatus} transcriptionBenchmarkActive={localAi.benchmarkActive} transcriptionBenchmarkNeedsRetry={localAi.benchmarkNeedsRetry} terminologyStatus={terminology.status} terminologyProposals={terminology.proposals} selectedRecordingId={meeting.selectedRecordingId} models={localAi.models} selectedModel={localAi.selectedModel} defaultModel={DEFAULT_MODEL} aiMode={localAi.aiMode} aiModeStatus={localAi.aiModeStatus} instructSetupOpen={localAi.instructSetupOpen} instructReady={localAi.instructReady} instructRunnerAsset={localAi.instructRunnerAsset} instructModelAsset={localAi.instructModelAsset} instructAssetKind={localAi.instructAssetKind} instructExpectedSha256={localAi.instructExpectedSha256} instructAssetError={localAi.instructAssetError} licenseStatus={license.status} licensePortalInfo={license.portalInfo} licenseActive={license.active} privacyReceipt={meeting.privacyReceipt} networkCapabilities={runtime.networkCapabilities} custodyItems={custodyItems} diagnosticPreview={diagnostics.preview} onSectionChange={navigation.setSettingsSection} onToggleAdvanced={onboarding.toggleAdvancedSettings} onVerifyModel={() => void localAi.verifyModel()} onImportModel={() => void localAi.importModel()} onSelectedModelChange={localAi.setSelectedModel} onAiModeChange={localAi.setAiMode} onTranscriptionQualityChange={(tier, language) => void localAi.updateTranscriptionQuality(tier, language)} onRunTranscriptionBenchmark={(tier) => void localAi.runTranscriptionBenchmark(tier)} onImportDictionary={() => void terminology.importDictionary()} onImportDictionaryFile={(file) => void terminology.importDictionaryFile(file)} onSetDictionaryEnabled={(dictionaryId, enabled) => void terminology.setEnabled(dictionaryId, enabled)} onAssignDictionary={(dictionaryId, enabled) => void terminology.assignToMeeting(dictionaryId, enabled)} onReviewTerminology={() => void terminology.loadProposals()} onDecideTerminology={(proposalId, decision) => void terminology.decide(proposalId, decision)} onInstructSetupOpenChange={localAi.setInstructSetupOpen} onInstructAssetKindChange={(kind) => { localAi.setInstructAssetKind(kind); localAi.setInstructAssetError(""); }} onInstructExpectedShaChange={(value) => { localAi.setInstructExpectedSha256(value); localAi.setInstructAssetError(""); }} onImportInstructAsset={() => void localAi.importInstructAsset()} onRefreshLicense={() => void license.reload()} onDeactivateLicense={() => void onboarding.deactivate()} onAcknowledgeMic={() => void onboarding.acknowledgeMic()} onAcknowledgeSystem={() => void onboarding.acknowledgeSystem()} onRecordSystem={() => void captureActions.startSystem()} onRecordBoth={() => void captureActions.startCombined()} onOpenExport={() => navigation.setView("export")} onRefreshLocalSettings={() => void onboarding.refreshLocalSettings()} onPrepareDiagnostics={() => void diagnostics.prepare()} onSaveDiagnostics={() => void diagnostics.save()} />;
  } else {
    content = <ExportView title={selectedTitle} summary={report.summaryDraft || localAi.recap?.summary || ""} format={report.format} paperSize={report.paperSize} sections={report.sections} decisions={report.preview.decisions} actions={report.preview.actions} risks={report.preview.risks} questions={report.preview.questions} markdownExport={report.markdownExport} canExport={Boolean(meeting.selectedRecordingId)} saving={operations.busy === "export"} onFormatChange={report.setFormat} onPaperSizeChange={report.setPaperSize} onToggleSection={report.toggleSection} onBack={() => navigation.setView("review")} onSave={() => void report.save()} />;
  }

  return (
    <AppShell view={navigation.view} recordings={meeting.recordings} openMeetingIds={meetingActions.openMeetingIds} selectedRecordingId={meeting.selectedRecordingId} activeCapture={activeCapture} combinedCaptureAvailable={combinedCaptureAvailable} busy={recordControlDisabled} notice={operations.notice} error={operations.error} persistentAlerts={persistentAlerts} jobs={runtime.jobs} onHome={() => navigation.setView("home")} onStartRecording={() => void captureActions.startPreferred()} onNavigate={navigation.setView} onOpenRecording={(recordingId) => void meetingActions.openRecording(recordingId, "meeting")} onCloseMeeting={meetingActions.closeMeetingTab} onDismissNotice={() => operations.setNotice("")} onDismissError={() => operations.setError("")} onCancelJob={(jobId) => void runtime.cancelJob(jobId)} onRetryJob={(jobId) => void runtime.retryJob(jobId)} onCancelAllJobs={() => void runtime.cancelAllJobs()} onAcknowledgeJob={(jobId) => void runtime.acknowledgeJob(jobId)}>
      {content}
    </AppShell>
  );
}
