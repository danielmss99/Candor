import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AnimatedTranscript,
  type EvidenceMarker,
} from "../meeting-motion";
import { AppShell } from "./AppShell";
import { CandorClient } from "../core/candor-client";
import { ExportView } from "../features/export/ExportView";
import { HomeView } from "../features/home/HomeView";
import { LibraryView } from "../features/library/LibraryView";
import { LiveMeetingView } from "../features/meeting/LiveMeetingView";
import { ActivationGate, OnboardingSetup } from "../features/onboarding/ActivationFlow";
import { MeetingDetailView } from "../features/detail/MeetingDetailView";
import { ReviewView } from "../features/review/ReviewView";
import { SettingsView } from "../features/settings/SettingsView";
import { useCaptureSession } from "../features/capture/useCaptureSession";
import { useCaptureActions } from "../features/capture/useCaptureActions";
import { useOperationRunner } from "../features/jobs/useOperationRunner";
import { useLocalAiWorkspace } from "../features/local-ai/useLocalAiWorkspace";
import { useReportWorkflow } from "../features/export/useReportWorkflow";
import { useRuntimeStatus } from "../features/startup/useRuntimeStatus";
import {
  StartupLoading,
  StartupRecovery,
  type StartupPhase,
} from "../features/startup/StartupState";
import {
  chooseInitialSelection,
  useMeetingWorkspace,
} from "../features/meetings/useMeetingWorkspace";
import { useMeetingActions } from "../features/meetings/useMeetingActions";
import { shouldShowActivationPrompt } from "../features/licensing/access-policy";
import { useLicenseState } from "../features/licensing/useLicenseState";
import { useAppNavigation } from "./navigation";
import {
  DEFAULT_MODEL,
  asArray,
  asBool,
  asNumber,
  asObject,
  asString,
  metric,
  type OnboardingStep,
} from "../core/contracts";

export function CandorWorkspace() {
  const api = window.candor?.core;
  const licenseApi = window.candor?.license;
  const client = useMemo(() => (api ? new CandorClient(api) : null), [api]);
  const startupLoaded = useRef(false);
  const [onboardingStep, setOnboardingStep] = useState<OnboardingStep>("activate");
  const [startupPhase, setStartupPhase] = useState<StartupPhase>("loading");
  const [startupError, setStartupError] = useState("");
  const [advancedSettingsOpen, setAdvancedSettingsOpen] = useState(false);
  const meetingWorkspace = useMeetingWorkspace({ api, client });
  const {
    recordings,
    recordingTotalCount,
    recordingsHaveMore,
    selectedRecordingId,
    transcript,
    transcriptTotalCount,
    transcriptHasMore,
    privacyReceipt,
    replay,
    notesMarkdown,
    notesStatus,
    notesDirty,
    markedMoments,
    selectedTrack,
    recordingTitle,
    searchQuery,
    searchMatches,
    setSelectedRecordingId,
    setNotesMarkdown,
    setNotesStatus,
    setNotesDirty,
    setMarkedMoments,
    setRecordingTitle,
    setSearchQuery,
    loadSelectedRecording,
    refreshLibrary,
    refreshPrivacyReceipt,
    loadMoreTranscript: loadMoreTranscriptPage,
    search: searchMeetingLibrary,
    updateNotes,
  } = meetingWorkspace;
  const {
    view,
    detailSection,
    settingsSection,
    reviewSection,
    setView,
    setDetailSection,
    setSettingsSection,
    setReviewSection,
  } = useAppNavigation(selectedRecordingId);

  const {
    coreStatus,
    privacyAudit,
    networkCapabilities,
    updateStatus,
    v2ImportStatus,
    consentStatus,
    vaultStatus,
    captureStatus,
    aiStatus,
    instructAssetsStatus,
    instructStatus,
    schedulerStatus,
    modelStatus,
    transcriptionStatus,
    retentionStatus,
    diagnosticFailures,
    setConsentStatus,
    loadCritical,
    loadDiagnostics,
    refreshCapture,
    refreshModelsAndAi,
    refreshPrivacyFacts,
    refreshVaultAndRetention,
  } = useRuntimeStatus(api, client);

  const activeCapture = asBool(captureStatus.active);
  const activeRecordingId = asString(asObject(captureStatus.activeSession).recordingId);
  const captureSession = useCaptureSession(activeCapture, activeRecordingId);
  const operations = useOperationRunner(captureSession.failed);
  const {
    busy,
    notice,
    error,
    jobMachine,
    job: localJob,
    acquire: acquireOperation,
    run,
    setBusy,
    setNotice,
    setError,
  } = operations;
  const handleLicenseLoadError = useCallback((message: string) => setError(message), [setError]);
  const license = useLicenseState(licenseApi, handleLicenseLoadError);
  const {
    status: licenseStatus,
    portalInfo: licensePortalInfo,
    loaded: licenseLoaded,
    licenseKey,
    licenseEmail,
    licenseKeyTouched,
    promptDismissed: licensePromptDismissed,
    active: licenseActive,
    state: licenseState,
    setLicenseKey,
    setLicenseEmail,
    setLicenseKeyTouched,
    setPromptDismissed: setLicensePromptDismissed,
    refresh: refreshLicense,
  } = license;
  const captureMachine = captureSession.state;
  const localAi = useLocalAiWorkspace({
    api,
    client,
    selectedRecordingId,
    selectedTrack,
    instructAssetsStatus,
    instructStatus,
    modelStatus,
    run,
    acquireOperation,
    localJob,
    setBusy,
    setNotice,
    setError,
    refreshModelsAndAi,
    refreshLibrary,
    loadRecording: loadSelectedRecording,
    refreshPrivacyReceipt,
  });
  const {
    selectedModel,
    askQuestion,
    askAnswer,
    recap,
    aiMode,
    instructAssetKind,
    instructExpectedSha256,
    instructAssetError,
    instructSetupOpen,
    instructReady,
    instructAssetsReady,
    instructRunnerAsset,
    instructModelAsset,
    models,
    aiModeStatus,
    setSelectedModel,
    setAskQuestion,
    setAiMode,
    setInstructAssetKind,
    setInstructExpectedSha256,
    setInstructAssetError,
    setInstructSetupOpen,
    resetMeetingAi,
    importModel,
    importInstructAsset,
    verifyModel,
    transcribe: transcribeRecording,
    generateRecap,
    ask: askSelectedRecording,
  } = localAi;
  const meetingActions = useMeetingActions({
    api,
    run,
    recordings,
    selectedRecordingId,
    selectedTrack,
    notesMarkdown,
    searchQuery,
    transcriptHasMore,
    setSelectedRecordingId,
    setNotesMarkdown,
    setNotesStatus,
    setNotesDirty,
    setMarkedMoments,
    refreshLibrary,
    refreshPrivacyReceipt,
    loadRecording: loadSelectedRecording,
    loadMoreTranscriptPage,
    searchLibrary: searchMeetingLibrary,
    resetMeetingAi,
    setView,
    setNotice,
    setError,
  });
  const {
    libraryFilter,
    notesPanelMode,
    compactMeetingPane,
    openMeetingIds,
    audioUrl,
    setLibraryFilter,
    setNotesPanelMode,
    setCompactMeetingPane,
    importV2Folder,
    searchRecordings,
    loadMoreRecordings,
    loadMoreTranscript,
    saveMeetingNotes,
    markMoment,
    loadAudio,
    openRecording,
    closeMeetingTab,
    pinRecording,
  } = meetingActions;
  const reportWorkflow = useReportWorkflow({
    api,
    selectedRecordingId,
    notesMarkdown,
    notesDirty,
    recap,
    run,
    setNotesStatus,
    setNotesDirty,
    setNotice,
    refreshPrivacyReceipt,
  });
  const {
    reviewStates,
    summaryDraft: reviewSummaryDraft,
    format: exportFormat,
    paperSize: exportPaperSize,
    sections: exportSections,
    markdownExport,
    preview: reportPreview,
    setSummaryDraft: setReviewSummaryDraft,
    setFormat: setExportFormat,
    setPaperSize: setExportPaperSize,
    toggleSection: toggleExportSection,
    reviewItem,
    save: saveLocalReport,
  } = reportWorkflow;
  const selectedRecording = recordings.find((item) => item.recordingId === selectedRecordingId);
  const selectedTitle = selectedRecording?.label || recordingTitle || "Untitled local meeting";
  const combinedCaptureAvailable = asBool(asObject(asObject(captureStatus.sources).system).simultaneousMicAndSystem);
  const licenseKeyInvalid = licenseKeyTouched && !licenseKey.trim();
  const captureActions = useCaptureActions({
    api,
    captureSession,
    captureStatus,
    consentStatus,
    activeCapture,
    combinedCaptureAvailable,
    recordingTitle,
    run,
    refreshCapture,
    refreshLibrary,
    loadRecording: loadSelectedRecording,
    onOpenRecordingSettings: () => { setSettingsSection("recording"); setView("settings"); },
    onShowLive: () => setView("meeting"),
    onSelectRecording: setSelectedRecordingId,
    onPinRecording: pinRecording,
    onNotice: setNotice,
    onError: setError,
  });
  const {
    startSystem: startSystemRecording,
    startCombined: startMicAndSystemRecording,
    startPreferred: startPreferredRecording,
  } = captureActions;

  const refresh = useCallback(async () => {
    if (!api || !client) {
      throw new Error("Candor preload API is unavailable");
    }
    const [, nextRecordings] = await Promise.all([
      loadCritical(),
      refreshLibrary(0),
    ]);
    const nextSelected = chooseInitialSelection(selectedRecordingId, nextRecordings);
    setSelectedRecordingId(nextSelected);
    if (nextSelected) await loadSelectedRecording(nextSelected);
    void loadDiagnostics();
  }, [api, client, loadCritical, loadDiagnostics, loadSelectedRecording, refreshLibrary, selectedRecordingId, setSelectedRecordingId]);
  const retryWorkspaceLoad = refresh;

  useEffect(() => {
    if (startupLoaded.current) return;
    startupLoaded.current = true;
    void refresh().then(() => {
      setStartupPhase("ready");
      setStartupError("");
    }).catch((reason) => {
      const message = reason instanceof Error ? reason.message : String(reason);
      setStartupError(message);
      setStartupPhase("failed");
    });
  }, [refresh]);

  useEffect(() => {
    if (!licenseLoaded) return;
    if (!licenseApi) {
      setOnboardingStep("app");
      return;
    }
    const currentState = asString(licenseStatus.state, "inactive");
    if (currentState === "inactive") {
      setOnboardingStep(recordings.length > 0 || licensePromptDismissed ? "app" : "activate");
    } else if (onboardingStep === "activate") {
      setOnboardingStep("app");
    }
  }, [licenseApi, licenseLoaded, licensePromptDismissed, licenseStatus, onboardingStep, recordings.length]);

  async function activateLicense() {
    await run("license", async () => {
      await license.activate();
      setOnboardingStep("yours");
      setNotice("Candor activated locally");
    });
  }

  async function startTrial() {
    await run("license", async () => {
      await license.startTrial();
      setOnboardingStep("yours");
      setNotice("Local trial started");
    });
  }

  async function deactivateLicense() {
    await run("license", async () => {
      await license.deactivate();
      setOnboardingStep("app");
      setView(recordings.length ? "library" : "home");
      setNotice("Local activation removed from this device");
    });
  }

  function continueWithoutActivation() {
    setLicensePromptDismissed(true);
    setOnboardingStep("app");
    setView(recordings.length ? "library" : "home");
    setNotice("Local workspace opened. Existing data remains available.");
  }

  function retryStartup() {
    setStartupPhase("loading");
    setStartupError("");
    void retryWorkspaceLoad().then(() => {
      setStartupPhase("ready");
    }).catch((reason) => {
      setStartupError(reason instanceof Error ? reason.message : String(reason));
      setStartupPhase("failed");
    });
  }

  async function completeMicOnboarding() {
    if (!api) return;
    if (asBool(consentStatus.readyForMicRecording)) {
      setOnboardingStep("system-audio");
      return;
    }
    await run("consent", async () => {
      const result = await api.consentAcknowledge({ items: ["localOnlyStorage", "micRecording"] });
      setConsentStatus(asObject(result));
      await refreshCapture();
      setOnboardingStep("system-audio");
      setNotice("Microphone recording consent saved locally");
    });
  }

  async function completeSystemAudioOnboarding() {
    if (!api) return;
    const systemImplemented = asBool(asObject(asObject(captureStatus.sources).system).implemented);
    if (!systemImplemented || asBool(consentStatus.readyForSystemAudioRecording)) {
      setOnboardingStep("storage");
      return;
    }
    const required = asArray(consentStatus.requiredForSystemAudio).map((item) => asString(item)).filter(Boolean);
    await run("consent", async () => {
      const result = await api.consentAcknowledge({ items: required.length ? required : ["localOnlyStorage", "systemAudioRecording"] });
      setConsentStatus(asObject(result));
      await refreshCapture();
      setOnboardingStep("storage");
      setNotice("System audio consent saved locally");
    });
  }

  async function completeStorageOnboarding() {
    if (!api) return;
    await run("storage", async () => {
      if (asBool(vaultStatus.localOpenAvailable)) {
        await api.vaultOpenLocal();
      }
      await refreshVaultAndRetention();
      setOnboardingStep("local-ai");
      setNotice("Local storage is ready");
    });
  }

  function finishOnboarding() {
    setOnboardingStep("app");
    setView("home");
    setNotice("Candor is ready");
  }

  async function acknowledgeMicConsent() {
    if (!api) return;
    await run("consent", async () => {
      const result = await api.consentAcknowledge({ items: ["localOnlyStorage", "micRecording"] });
      setConsentStatus(asObject(result));
      setNotice("Microphone recording consent saved locally");
      await refreshCapture();
    });
  }

  async function acknowledgeSystemConsent() {
    if (!api) return;
    const required = asArray(consentStatus.requiredForSystemAudio).map((item) => asString(item)).filter(Boolean);
    await run("consent", async () => {
      const result = await api.consentAcknowledge({ items: required.length ? required : ["localOnlyStorage", "systemAudioRecording"] });
      setConsentStatus(asObject(result));
      setNotice("System audio consent saved locally");
      await refreshCapture();
    });
  }

  async function refreshLocalSettings() {
    await run("refresh settings", async () => {
      await Promise.all([
        refreshCapture(),
        refreshModelsAndAi(),
        refreshPrivacyFacts(),
        refreshVaultAndRetention(),
      ]);
      setNotice("Local settings refreshed");
    }, "settings-refresh");
  }

  function toggleAdvancedSettings() {
    setAdvancedSettingsOpen((current) => {
      if (!current) void refreshPrivacyFacts().catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
      return !current;
    });
  }

  const captureStatusLabel = captureMachine.phase === "idle"
    ? "Ready"
    : captureMachine.phase === "recording"
      ? "Recording"
      : captureMachine.phase === "requesting-permission"
        ? "Checking permission"
        : captureMachine.phase[0].toUpperCase() + captureMachine.phase.slice(1).replace("-", " ");
  const jobStatusLabel = jobMachine.phase === "running" && jobMachine.kind
    ? `${jobMachine.kind.replace("-", " ")} running locally`
    : jobMachine.phase === "failed"
      ? "Local job needs attention"
      : "Processing stays local";
  const custodyItems: Array<[string, string]> = [
    ["Network", metric(coreStatus.networkPolicy, "disabled-by-default")],
    ["Updates", asBool(updateStatus.backgroundChecks) ? "background" : metric(updateStatus.policy, "manual-check-only")],
    ["Vault", metric(vaultStatus.backend, "sqlcipher")],
    ["Consent", asBool(consentStatus.readyForMicAndSystemAudioRecording) ? "all ready" : asBool(consentStatus.readyForMicRecording) ? "mic ready" : "required"],
    ["Notes", notesDirty ? "unsaved" : asBool(notesStatus.savedLocally) ? "saved" : "empty"],
    ["Retention", metric(retentionStatus.policy, "manual-delete-only")],
    ["External calls", metric(privacyAudit.externalCallsAttempted, "0")],
    ["Transport", metric(coreStatus.sidecarTransport, "stdio-json-lines")],
    ["Local AI", instructReady ? "model ready" : asBool(aiStatus.heuristicRecapImplemented) ? "fast fallback" : "pending"],
    ["V2 import", asBool(v2ImportStatus.implemented) ? "native picker" : "pending"],
    ["Scheduler", asBool(schedulerStatus.whisperLlmConcurrent) ? "unsafe" : "single job"],
    ["Model import", metric(modelStatus.manualImportMethod, "native picker")],
    ["Diagnostics", diagnosticFailures.length ? `${diagnosticFailures.length} unavailable` : "ready"],
  ];

  const filteredRecordings = recordings.filter((recording) => {
    if (libraryFilter === "transcribed") return recording.transcriptSegmentCount > 0;
    if (libraryFilter === "audio") return recording.audioChunkCount > 0;
    return true;
  });

  const recapSuggestions = recap ? [...recap.decisions, ...recap.actions, ...recap.risks, ...recap.questions] : [];
  const timelineDurationMs = Math.max(
    asNumber(replay.durationMs),
    selectedRecording?.audioDurationMs ?? 0,
    asNumber(asObject(captureStatus.activeSession).durationMs),
    transcript.length ? transcript[transcript.length - 1].endMs : 0,
  );
  const evidenceMarkers = useMemo<EvidenceMarker[]>(() => {
    const transcriptMarkers = transcript.slice(0, 24).map((segment) => ({
      id: `transcript-${segment.index}-${segment.startMs}`,
      timeMs: segment.startMs,
      label: `${segment.speaker}: ${segment.text.slice(0, 64)}`,
      kind: "transcript" as const,
    }));
    const noteMarkers = markedMoments.map((moment) => ({
      id: moment.id,
      timeMs: moment.timeMs,
      label: moment.label,
      kind: "note" as const,
    }));
    const decisionMarkers = (recap?.decisions ?? []).map((item) => ({
      id: `decision-${item.segmentIndex}-${item.startMs}`,
      timeMs: item.startMs,
      label: item.text,
      kind: "decision" as const,
    }));
    const actionMarkers = (recap?.actions ?? []).map((item) => ({
      id: `action-${item.segmentIndex}-${item.startMs}`,
      timeMs: item.startMs,
      label: item.text,
      kind: "action" as const,
    }));
    return [...transcriptMarkers, ...noteMarkers, ...decisionMarkers, ...actionMarkers];
  }, [markedMoments, recap, transcript]);

  function renderTranscriptList() {
    return (
      <div className="transcript-page-wrap">
        <AnimatedTranscript
          emptyMessage="No transcript yet. Record or transcribe this meeting locally to begin."
          segments={transcript.map((segment) => ({
            id: `${segment.index}-${segment.startMs}`,
            speaker: segment.speaker,
            startMs: segment.startMs,
            channel: segment.channel,
            text: segment.text,
          }))}
        />
        {transcriptHasMore ? <button type="button" className="load-more-button" onClick={() => void loadMoreTranscript()} disabled={Boolean(busy)}>Load more transcript</button> : null}
        {transcriptTotalCount > 0 ? <span className="page-count">Showing {transcript.length} of {transcriptTotalCount} segments</span> : null}
      </div>
    );
  }

  function renderActivationGate() {
    return (
      <ActivationGate
        licenseKey={licenseKey}
        licenseEmail={licenseEmail}
        licenseKeyInvalid={licenseKeyInvalid}
        licenseBusy={busy === "license"}
        licenseStatus={licenseStatus}
        onLicenseKeyChange={(value) => { setLicenseKey(value); setLicenseKeyTouched(false); }}
        onLicenseEmailChange={setLicenseEmail}
        onLicenseKeyBlur={() => setLicenseKeyTouched(true)}
        onActivate={() => void activateLicense()}
        onStartTrial={() => void startTrial()}
        onContinueLocal={continueWithoutActivation}
      />
    );
  }

  function renderOnboardingSetup() {
    return (
      <OnboardingSetup
        step={onboardingStep}
        licenseState={licenseState}
        licenseStatus={licenseStatus}
        captureStatus={captureStatus}
        consentStatus={consentStatus}
        vaultStatus={vaultStatus}
        modelStatus={modelStatus}
        aiModeStatus={aiModeStatus}
        instructAssetsReady={instructAssetsReady}
        busy={busy}
        onStepChange={setOnboardingStep}
        onCompleteMic={() => void completeMicOnboarding()}
        onCompleteSystemAudio={() => void completeSystemAudioOnboarding()}
        onCompleteStorage={() => void completeStorageOnboarding()}
        onImportSpeechModel={() => void importModel()}
        onFinish={finishOnboarding}
      />
    );
  }

  function renderHome() {
    return (
      <HomeView
        recordings={recordings}
        activeCapture={activeCapture}
        combinedCaptureAvailable={combinedCaptureAvailable}
        busy={Boolean(busy)}
        importAvailable={asBool(v2ImportStatus.implemented)}
        recordingTitle={recordingTitle}
        vaultBackend={vaultStatus.backend}
        instructReady={instructReady}
        verifiedModelCount={modelStatus.verifiedModelCount}
        aiModeStatus={aiModeStatus}
        onStartRecording={() => void startPreferredRecording()}
        onOpenLibrary={() => setView("library")}
        onImport={() => void importV2Folder()}
        onRecordingTitleChange={setRecordingTitle}
        onOpenRecording={(recordingId) => void openRecording(recordingId, "detail")}
      />
    );
  }

  function renderMeeting() {
    return (
      <LiveMeetingView
        title={selectedTitle}
        selectedRecording={selectedRecording}
        selectedRecordingId={selectedRecordingId}
        activeRecordingId={activeRecordingId}
        activeCapture={activeCapture}
        consentReady={asBool(consentStatus.readyForMicRecording)}
        durationMs={timelineDurationMs}
        audioUrl={audioUrl}
        markers={evidenceMarkers}
        compactPane={compactMeetingPane}
        notesPanelMode={notesPanelMode}
        notesMarkdown={notesMarkdown}
        notesDirty={notesDirty}
        notesSaved={asBool(notesStatus.savedLocally)}
        recapSuggestions={recapSuggestions}
        aiMode={aiMode}
        aiModeStatus={aiModeStatus}
        captureStatusLabel={captureStatusLabel}
        jobStatusLabel={jobStatusLabel}
        busy={Boolean(busy)}
        transcriptContent={renderTranscriptList()}
        onReview={() => setView("review")}
        onReviewConsent={() => { setSettingsSection("recording"); setView("settings"); }}
        onLoadAudio={() => void loadAudio()}
        onMarkMoment={markMoment}
        onCompactPaneChange={setCompactMeetingPane}
        onNotesPanelModeChange={setNotesPanelMode}
        onTranscribe={() => void transcribeRecording()}
        onNotesChange={updateNotes}
        onSaveNotes={() => void saveMeetingNotes()}
        onGenerateRecap={() => void generateRecap()}
        onAiModeChange={setAiMode}
        onStartStop={() => void startPreferredRecording()}
      />
    );
  }

  function renderLibrary() {
    return (
      <LibraryView
        recordings={recordings}
        filteredRecordings={filteredRecordings}
        recordingTotalCount={recordingTotalCount}
        recordingsHaveMore={recordingsHaveMore}
        searchQuery={searchQuery}
        searchMatches={searchMatches}
        libraryFilter={libraryFilter}
        busy={Boolean(busy)}
        onSearchQueryChange={setSearchQuery}
        onSearch={() => void searchRecordings()}
        onFilterChange={setLibraryFilter}
        onOpenRecording={(recordingId) => void openRecording(recordingId, "detail")}
        onStartRecording={() => void startPreferredRecording()}
        onLoadMore={() => void loadMoreRecordings()}
      />
    );
  }

  function renderDetail() {
    return (
      <MeetingDetailView
        title={selectedTitle}
        selectedRecording={selectedRecording}
        selectedRecordingId={selectedRecordingId}
        detailSection={detailSection}
        transcriptContent={renderTranscriptList()}
        transcriptTotalCount={transcriptTotalCount}
        notesMarkdown={notesMarkdown}
        notesDirty={notesDirty}
        recap={recap}
        askQuestion={askQuestion}
        askAnswer={askAnswer}
        aiModeStatus={aiModeStatus}
        privacyReceipt={privacyReceipt}
        networkCapabilities={networkCapabilities}
        busy={Boolean(busy)}
        onDetailSectionChange={setDetailSection}
        onReview={() => setView("review")}
        onNotesChange={updateNotes}
        onSaveNotes={() => void saveMeetingNotes()}
        onGenerateRecap={() => void generateRecap()}
        onAskQuestionChange={setAskQuestion}
        onAsk={() => void askSelectedRecording()}
      />
    );
  }

  function renderReview() {
    return (
      <ReviewView
        title={selectedTitle}
        reviewSection={reviewSection}
        reviewStates={reviewStates}
        summaryDraft={reviewSummaryDraft}
        recap={recap}
        notesMarkdown={notesMarkdown}
        notesDirty={notesDirty}
        transcriptContent={renderTranscriptList()}
        exportFormat={exportFormat}
        includeSummary={exportSections.summary}
        includeNotes={exportSections.notes}
        includeTranscript={exportSections.transcript}
        previewDecisions={reportPreview.decisions}
        previewActions={reportPreview.actions}
        previewRisks={reportPreview.risks}
        previewQuestions={reportPreview.questions}
        selectedRecordingId={selectedRecordingId}
        busy={Boolean(busy)}
        onSectionChange={setReviewSection}
        onSummaryDraftChange={setReviewSummaryDraft}
        onNotesChange={updateNotes}
        onSaveNotes={() => void saveMeetingNotes()}
        onGenerateRecap={() => void generateRecap()}
        onReviewItem={reviewItem}
        onOpenExport={() => setView("export")}
      />
    );
  }

  function renderSettings() {
    return (
      <SettingsView
        section={settingsSection}
        advancedOpen={advancedSettingsOpen}
        busy={busy}
        activeCapture={activeCapture}
        combinedCaptureAvailable={combinedCaptureAvailable}
        statuses={{
          core: coreStatus,
          consent: consentStatus,
          capture: captureStatus,
          vault: vaultStatus,
          updates: updateStatus,
          retention: retentionStatus,
          transcription: transcriptionStatus,
        }}
        models={models}
        selectedModel={selectedModel}
        defaultModel={DEFAULT_MODEL}
        aiMode={aiMode}
        aiModeStatus={aiModeStatus}
        instructSetupOpen={instructSetupOpen}
        instructAssetsReady={instructAssetsReady}
        instructRunnerAsset={instructRunnerAsset}
        instructModelAsset={instructModelAsset}
        instructAssetKind={instructAssetKind}
        instructExpectedSha256={instructExpectedSha256}
        instructAssetError={instructAssetError}
        licenseStatus={licenseStatus}
        licensePortalInfo={licensePortalInfo}
        licenseActive={licenseActive}
        privacyReceipt={privacyReceipt}
        networkCapabilities={networkCapabilities}
        custodyItems={custodyItems}
        onSectionChange={setSettingsSection}
        onToggleAdvanced={toggleAdvancedSettings}
        onVerifyModel={() => void verifyModel()}
        onImportModel={() => void importModel()}
        onSelectedModelChange={setSelectedModel}
        onAiModeChange={setAiMode}
        onInstructSetupOpenChange={setInstructSetupOpen}
        onInstructAssetKindChange={(kind) => { setInstructAssetKind(kind); setInstructAssetError(""); }}
        onInstructExpectedShaChange={(value) => { setInstructExpectedSha256(value); setInstructAssetError(""); }}
        onImportInstructAsset={() => void importInstructAsset()}
        onRefreshLicense={() => void refreshLicense()}
        onDeactivateLicense={() => void deactivateLicense()}
        onAcknowledgeMic={() => void acknowledgeMicConsent()}
        onAcknowledgeSystem={() => void acknowledgeSystemConsent()}
        onRecordSystem={() => void startSystemRecording()}
        onRecordBoth={() => void startMicAndSystemRecording()}
        onOpenExport={() => setView("export")}
        onRefreshLocalSettings={() => void refreshLocalSettings()}
      />
    );
  }

  function renderExport() {
    return <ExportView title={selectedTitle} summary={reviewSummaryDraft || recap?.summary || ""} format={exportFormat} paperSize={exportPaperSize} sections={exportSections} decisions={reportPreview.decisions} actions={reportPreview.actions} risks={reportPreview.risks} questions={reportPreview.questions} markdownExport={markdownExport} canExport={Boolean(selectedRecordingId)} saving={busy === "export"} onFormatChange={setExportFormat} onPaperSizeChange={setExportPaperSize} onToggleSection={toggleExportSection} onBack={() => setView("review")} onSave={() => void saveLocalReport()} />;
  }

  function renderCurrentView() {
    if (view === "home") return renderHome();
    if (view === "meeting") return renderMeeting();
    if (view === "library") return renderLibrary();
    if (view === "detail") return renderDetail();
    if (view === "review") return renderReview();
    if (view === "settings") return renderSettings();
    if (view === "export") return renderExport();
    return renderExport();
  }

  if (!licenseLoaded || startupPhase === "loading") return <StartupLoading />;

  if (startupPhase === "failed") {
    return <StartupRecovery message={startupError} retrying={false} onRetry={retryStartup} />;
  }

  const showActivationPrompt = shouldShowActivationPrompt({
    licenseAvailable: Boolean(licenseApi),
    licenseActive,
    promptDismissed: licensePromptDismissed,
    existingRecordingCount: recordings.length,
  });
  if (licenseApi && (showActivationPrompt || (licenseActive && onboardingStep !== "app"))) {
    return showActivationPrompt || onboardingStep === "activate"
      ? renderActivationGate()
      : renderOnboardingSetup();
  }

  return (
    <AppShell
      view={view}
      recordings={recordings}
      openMeetingIds={openMeetingIds}
      selectedRecordingId={selectedRecordingId}
      activeCapture={activeCapture}
      combinedCaptureAvailable={combinedCaptureAvailable}
      busy={Boolean(busy)}
      notice={notice}
      error={error}
      onHome={() => setView("home")}
      onStartRecording={() => void startPreferredRecording()}
      onNavigate={setView}
      onOpenRecording={(recordingId) => void openRecording(recordingId, "meeting")}
      onCloseMeeting={closeMeetingTab}
      onDismissNotice={() => setNotice("")}
      onDismissError={() => setError("")}
    >
      {renderCurrentView()}
    </AppShell>
  );
}
