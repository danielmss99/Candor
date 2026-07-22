import { useCallback } from "react";
import { asArray, asBool, asNumber, asObject, asString, type JsonObject, type RecordingSummary } from "../../core/contracts";
import type { useCaptureSession } from "./useCaptureSession";
import type { RunOperation } from "../jobs/useOperationRunner";

type CoreApi = NonNullable<Window["candor"]>;
type CaptureSession = ReturnType<typeof useCaptureSession>;

interface UseCaptureActionsOptions {
  api: CoreApi | undefined;
  captureSession: CaptureSession;
  captureStatus: JsonObject;
  consentStatus: JsonObject;
  activeCapture: boolean;
  combinedCaptureAvailable: boolean;
  liveTranscriptRuntimeAvailable: boolean;
  verifiedLiveModelIds: string[];
  recordingTitle: string;
  run: RunOperation;
  refreshCapture: () => Promise<void>;
  refreshLibrary: (offset?: number) => Promise<RecordingSummary[]>;
  loadRecording: (recordingId: string) => Promise<void>;
  onOpenRecordingSettings: () => void;
  onShowLive: () => void;
  onSelectRecording: (recordingId: string) => void;
  onPinRecording: (recordingId: string) => void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}

export type PreferredCaptureAction = "stop" | "combined" | "microphone";

export interface ActiveMeetingProfile {
  id: string;
  version: number;
  captureSource: "microphone" | "system-audio" | "combined";
  localModelTier: "fast" | "balanced" | "maximum";
  language: string;
  dictionaryIds: string[];
  liveTranscription: boolean;
}

export function liveModelIdForProfile(profile: ActiveMeetingProfile): string {
  if (profile.localModelTier === "maximum") return "large-v3";
  if (profile.localModelTier === "balanced") return "large-v3-turbo";
  return /^en(?:-|$)/i.test(profile.language) ? "small.en" : "small";
}

export function profilePostStartActions(
  profile: ActiveMeetingProfile,
  runtimeAvailable: boolean,
  verifiedModelIds: readonly string[],
): Array<"live-transcription"> {
  if (!runtimeAvailable || !verifiedModelIds.includes(liveModelIdForProfile(profile))) return [];
  return profile.liveTranscription ? ["live-transcription"] : [];
}

export function profileCaptureBinding(profile: ActiveMeetingProfile | null | undefined) {
  return profile ? { profileId: profile.id, profileVersion: profile.version } : {};
}

export function activeMeetingProfile(value: unknown): ActiveMeetingProfile | null {
  const root = asObject(value);
  const activeProfileId = asString(root.activeProfileId);
  const profile = asArray(root.profiles)
    .map(asObject)
    .find((item) => asString(item.id) === activeProfileId);
  if (!profile) return null;
  const captureSource = asString(profile.captureSource);
  const localModelTier = asString(profile.localModelTier);
  const profileId = asString(profile.id);
  const version = asNumber(profile.version);
  if (
    !profileId
    || !Number.isSafeInteger(version)
    || version < 1
    || !["microphone", "system-audio", "combined"].includes(captureSource)
    || !["fast", "balanced", "maximum"].includes(localModelTier)
  ) return null;
  return {
    id: profileId,
    version,
    captureSource: captureSource as ActiveMeetingProfile["captureSource"],
    localModelTier: localModelTier as ActiveMeetingProfile["localModelTier"],
    language: asString(profile.language, "auto"),
    dictionaryIds: asArray(profile.dictionaryIds).map((item) => asString(item)).filter(Boolean),
    liveTranscription: asBool(profile.liveTranscription),
  };
}

export function preferredCaptureAction(active: boolean, combinedAvailable: boolean, combinedConsent: boolean): PreferredCaptureAction {
  if (active) return "stop";
  if (combinedAvailable && combinedConsent) return "combined";
  return "microphone";
}

export function preferredCaptureActionForProfile(
  profile: ActiveMeetingProfile | null,
  combinedAvailable: boolean,
  combinedConsent: boolean,
): "system" | "combined" | "microphone" {
  if (profile?.captureSource === "system-audio") return "system";
  if (profile?.captureSource === "combined") return "combined";
  if (profile?.captureSource === "microphone") return "microphone";
  return combinedAvailable && combinedConsent ? "combined" : "microphone";
}

export function shouldDisableRecordControl(busy: string, activeCapture: boolean, recordingBlocked: boolean): boolean {
  if (busy === "stop") return true;
  return !activeCapture && (Boolean(busy) || recordingBlocked);
}

export function requireStartedRecordingId(result: unknown): string {
  const recordingId = asString(asObject(asObject(result).capture).recordingId);
  if (!recordingId) {
    throw new Error("Capture start did not return a durable recording ID.");
  }
  return recordingId;
}

export function useCaptureActions(options: UseCaptureActionsOptions) {
  const {
    api,
    captureSession,
    captureStatus,
    consentStatus,
    activeCapture,
    combinedCaptureAvailable,
    liveTranscriptRuntimeAvailable,
    verifiedLiveModelIds,
    recordingTitle,
    run,
    refreshCapture,
    refreshLibrary,
    loadRecording,
    onOpenRecordingSettings,
    onShowLive,
    onSelectRecording,
    onPinRecording,
    onNotice,
    onError,
  } = options;

  const failForConsent = useCallback((message: string, machineMessage: string) => {
    onError(message);
    captureSession.failed(machineMessage);
    onOpenRecordingSettings();
  }, [captureSession, onError, onOpenRecordingSettings]);

  const refreshAfterCaptureAction = useCallback(async (refreshRecordings: boolean) => {
    const refreshes: Array<Promise<unknown>> = [refreshCapture()];
    if (refreshRecordings) refreshes.push(refreshLibrary(0));
    await Promise.allSettled(refreshes);
  }, [refreshCapture, refreshLibrary]);

  const loadActiveProfile = useCallback(async (): Promise<ActiveMeetingProfile | null> => {
    if (!api) return null;
    try {
      return activeMeetingProfile(await api.profiles.list());
    } catch {
      return null;
    }
  }, [api]);

  const applyProfileToRecording = useCallback(async (
    recordingId: string,
    suppliedProfile?: ActiveMeetingProfile | null,
  ) => {
    if (!api) return;
    const profile = suppliedProfile ?? await loadActiveProfile();
    if (!profile) return;
    const profileResult = await Promise.allSettled(
      profilePostStartActions(
        profile,
        liveTranscriptRuntimeAvailable,
        verifiedLiveModelIds,
      ).map(() =>
        (async () => {
          await api.liveTranscript.enable(recordingId);
          await api.liveTranscript.start(recordingId);
        })()
      ),
    );
    if (profileResult.some((result) => result.status === "rejected")) {
      onError("Recording started, but part of the active meeting profile could not be applied.");
    }
  }, [api, liveTranscriptRuntimeAvailable, loadActiveProfile, onError, verifiedLiveModelIds]);

  const startMicrophone = useCallback(async (profile?: ActiveMeetingProfile | null) => {
    if (!api) return;
    captureSession.requestPermission();
    if (!asBool(consentStatus.readyForMicRecording)) {
      failForConsent(
        "Acknowledge local storage and microphone recording consent before recording.",
        "Microphone consent is required.",
      );
      return;
    }
    captureSession.permissionGranted();
    const captureProfile = profile ?? await loadActiveProfile();
    let started = false;
    await run("record", async () => {
      const result = await api.capture.start({
        source: "microphone",
        label: recordingTitle.trim() || "Untitled local meeting",
        chunkMs: 500,
        ...profileCaptureBinding(captureProfile),
      });
      const recordingId = requireStartedRecordingId(result);
      started = true;
      captureSession.started(recordingId);
      await applyProfileToRecording(recordingId, captureProfile);
      onNotice(`Recording ${recordingId}`);
      onShowLive();
    }, "capture");
    await refreshAfterCaptureAction(started);
  }, [api, applyProfileToRecording, captureSession, consentStatus.readyForMicRecording, failForConsent, loadActiveProfile, onNotice, onShowLive, recordingTitle, refreshAfterCaptureAction, run]);

  const startSystem = useCallback(async (profile?: ActiveMeetingProfile | null) => {
    if (!api) return;
    captureSession.requestPermission();
    if (!asBool(asObject(asObject(captureStatus.sources).system).implemented)) {
      onError("System audio capture is not implemented on this OS yet.");
      captureSession.failed("System audio is unavailable on this OS.");
      return;
    }
    if (!asBool(consentStatus.readyForSystemAudioRecording)) {
      failForConsent(
        "Acknowledge local storage and system audio consent before recording system audio.",
        "System audio consent is required.",
      );
      return;
    }
    captureSession.permissionGranted();
    const captureProfile = profile ?? await loadActiveProfile();
    let started = false;
    await run("record", async () => {
      const result = await api.capture.start({
        source: "system-audio",
        label: recordingTitle.trim() || "Untitled local system audio",
        chunkMs: 500,
        ...profileCaptureBinding(captureProfile),
      });
      const recordingId = requireStartedRecordingId(result);
      started = true;
      captureSession.started(recordingId);
      await applyProfileToRecording(recordingId, captureProfile);
      onNotice("System audio recording started locally");
      onShowLive();
    }, "capture");
    await refreshAfterCaptureAction(started);
  }, [api, applyProfileToRecording, captureSession, captureStatus.sources, consentStatus.readyForSystemAudioRecording, failForConsent, loadActiveProfile, onError, onNotice, onShowLive, recordingTitle, refreshAfterCaptureAction, run]);

  const startCombined = useCallback(async (profile?: ActiveMeetingProfile | null) => {
    if (!api) return;
    captureSession.requestPermission();
    if (!combinedCaptureAvailable) {
      onError("Combined mic and system capture is not implemented on this OS yet.");
      captureSession.failed("Combined capture is unavailable on this OS.");
      return;
    }
    if (!asBool(consentStatus.readyForMicAndSystemAudioRecording)) {
      failForConsent(
        "Acknowledge local storage, microphone, and system audio consent before combined recording.",
        "Microphone and system audio consent are required.",
      );
      return;
    }
    captureSession.permissionGranted();
    const captureProfile = profile ?? await loadActiveProfile();
    let started = false;
    await run("record", async () => {
      const result = await api.capture.start({
        source: "microphone-and-system-audio",
        label: recordingTitle.trim() || "Untitled local meeting",
        chunkMs: 500,
        ...profileCaptureBinding(captureProfile),
      });
      const recordingId = requireStartedRecordingId(result);
      started = true;
      captureSession.started(recordingId);
      await applyProfileToRecording(recordingId, captureProfile);
      onNotice("Microphone and system audio recording started locally");
      onShowLive();
    }, "capture");
    await refreshAfterCaptureAction(started);
  }, [api, applyProfileToRecording, captureSession, combinedCaptureAvailable, consentStatus.readyForMicAndSystemAudioRecording, failForConsent, loadActiveProfile, onError, onNotice, onShowLive, recordingTitle, refreshAfterCaptureAction, run]);

  const stop = useCallback(async () => {
    if (!api) return;
    captureSession.stopRequested();
    let savedRecordingId = "";
    await run("stop", async () => {
      captureSession.finalizing();
      const result = await api.capture.stop();
      const recordingId = asString(asObject(asObject(result).capture).recordingId);
      if (!recordingId) throw new Error("Recording finalization did not return a durable recording ID.");
      savedRecordingId = recordingId;
      captureSession.saved(recordingId);
      onSelectRecording(recordingId);
      onPinRecording(recordingId);
    }, "capture");
    await refreshAfterCaptureAction(Boolean(savedRecordingId));
    if (!savedRecordingId) return;
    try {
      await loadRecording(savedRecordingId);
      onNotice("Recording saved locally");
    } catch {
      onError("Recording was saved locally, but its detail view could not be loaded. Open it again from Meetings.");
    }
  }, [api, captureSession, loadRecording, onError, onNotice, onPinRecording, onSelectRecording, refreshAfterCaptureAction, run]);

  const startPreferred = useCallback(async () => {
    if (activeCapture) {
      await stop();
      return;
    }
    const profile = await loadActiveProfile();
    const action = preferredCaptureActionForProfile(
      profile,
      combinedCaptureAvailable,
      asBool(consentStatus.readyForMicAndSystemAudioRecording),
    );
    if (action === "system") await startSystem(profile);
    else if (action === "combined") await startCombined(profile);
    else await startMicrophone(profile);
  }, [activeCapture, combinedCaptureAvailable, consentStatus.readyForMicAndSystemAudioRecording, loadActiveProfile, startCombined, startMicrophone, startSystem, stop]);

  return { startMicrophone, startSystem, startCombined, startPreferred, stop };
}
