import { useCallback } from "react";
import { asBool, asObject, asString, type JsonObject, type RecordingSummary } from "../../core/contracts";
import type { useCaptureSession } from "./useCaptureSession";
import type { RunOperation } from "../jobs/useOperationRunner";

type CoreApi = NonNullable<Window["candor"]>["core"];
type CaptureSession = ReturnType<typeof useCaptureSession>;

interface UseCaptureActionsOptions {
  api: CoreApi | undefined;
  captureSession: CaptureSession;
  captureStatus: JsonObject;
  consentStatus: JsonObject;
  activeCapture: boolean;
  combinedCaptureAvailable: boolean;
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

export function preferredCaptureAction(active: boolean, combinedAvailable: boolean, combinedConsent: boolean): PreferredCaptureAction {
  if (active) return "stop";
  if (combinedAvailable && combinedConsent) return "combined";
  return "microphone";
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

  const startMicrophone = useCallback(async () => {
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
    let started = false;
    await run("record", async () => {
      const result = await api.captureStartMic({ label: recordingTitle.trim() || "Untitled local meeting", chunkMs: 500 });
      const recordingId = requireStartedRecordingId(result);
      started = true;
      captureSession.started(recordingId);
      onNotice(`Recording ${recordingId}`);
      onShowLive();
    }, "capture");
    await refreshAfterCaptureAction(started);
  }, [api, captureSession, consentStatus.readyForMicRecording, failForConsent, onNotice, onShowLive, recordingTitle, refreshAfterCaptureAction, run]);

  const startSystem = useCallback(async () => {
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
    let started = false;
    await run("record", async () => {
      const result = await api.captureStartSystem({ label: recordingTitle.trim() || "Untitled local system audio", chunkMs: 500 });
      const recordingId = requireStartedRecordingId(result);
      started = true;
      captureSession.started(recordingId);
      onNotice("System audio recording started locally");
      onShowLive();
    }, "capture");
    await refreshAfterCaptureAction(started);
  }, [api, captureSession, captureStatus.sources, consentStatus.readyForSystemAudioRecording, failForConsent, onError, onNotice, onShowLive, recordingTitle, refreshAfterCaptureAction, run]);

  const startCombined = useCallback(async () => {
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
    let started = false;
    await run("record", async () => {
      const result = await api.captureStartMicAndSystem({ label: recordingTitle.trim() || "Untitled local meeting", chunkMs: 500 });
      const recordingId = requireStartedRecordingId(result);
      started = true;
      captureSession.started(recordingId);
      onNotice("Microphone and system audio recording started locally");
      onShowLive();
    }, "capture");
    await refreshAfterCaptureAction(started);
  }, [api, captureSession, combinedCaptureAvailable, consentStatus.readyForMicAndSystemAudioRecording, failForConsent, onError, onNotice, onShowLive, recordingTitle, refreshAfterCaptureAction, run]);

  const stop = useCallback(async () => {
    if (!api) return;
    captureSession.stopRequested();
    let savedRecordingId = "";
    await run("stop", async () => {
      captureSession.finalizing();
      const result = await api.captureStop();
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
    const action = preferredCaptureAction(
      activeCapture,
      combinedCaptureAvailable,
      asBool(consentStatus.readyForMicAndSystemAudioRecording),
    );
    if (action === "stop") await stop();
    else if (action === "combined") await startCombined();
    else await startMicrophone();
  }, [activeCapture, combinedCaptureAvailable, consentStatus.readyForMicAndSystemAudioRecording, startCombined, startMicrophone, stop]);

  return { startMicrophone, startSystem, startCombined, startPreferred, stop };
}
