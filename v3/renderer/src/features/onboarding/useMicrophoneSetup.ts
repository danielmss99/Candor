import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LocalJsonValue } from "../../core/contracts";
import {
  asSetupRecord,
  currentNativeSetupApi,
  setupBoolean,
  setupNumber,
  setupString,
  type NativeSetupApi,
} from "./setup-api";

const MIC_TEST_DURATION_MS = 5_000;
const MIC_STATUS_POLL_MS = 200;
// Five seconds of 16 kHz mono PCM16 plus a 44-byte WAV header, base64 encoded.
const MAX_WAV_BASE64_CHARACTERS = 213_392;

export interface MicrophoneDevice {
  id: string;
  label: string;
  isDefault: boolean;
  fingerprint?: string;
  ordinal?: number;
}

export interface MicrophoneTestStatus {
  state: string;
  rms: number;
  peak: number;
  clipping: boolean;
  signalDetected: boolean;
  captureComplete: boolean;
  durationMs: number;
  accessError: string;
  selectionResolution: string;
  reselectionRequired: boolean;
}

export interface MicrophonePreferenceResolution {
  deviceId: string;
  selectionResolution: string;
  reselectionRequired: boolean;
}

export type MicrophoneUiState =
  | "loading-devices"
  | "no-device"
  | "permission-denied"
  | "ready"
  | "listening"
  | "signal-detected"
  | "no-signal"
  | "clipping"
  | "device-disconnected"
  | "reselection-required"
  | "playback-ready"
  | "playback-complete"
  | "retry";

export interface MicrophoneSetupController {
  devices: MicrophoneDevice[];
  selectedDeviceId: string;
  status: MicrophoneTestStatus;
  uiState: MicrophoneUiState;
  loading: boolean;
  listening: boolean;
  sampleReady: boolean;
  playbackUrl: string;
  playbackCompleted: boolean;
  operationBusy: boolean;
  selectionResolution: string;
  reselectionRequired: boolean;
  error: string;
  selectDevice: (deviceId: string) => Promise<void>;
  startTest: () => Promise<void>;
  preparePlayback: () => Promise<void>;
  clearPlayback: (completed: boolean) => void;
  stopTest: () => Promise<void>;
  retry: () => Promise<void>;
  openPrivacySettings: () => Promise<void>;
}

interface UseMicrophoneSetupOptions {
  active: boolean;
  api?: NativeSetupApi;
}

export class MicrophoneOperationEpoch {
  private generation = 0;
  private active = false;

  activate(): number {
    this.active = true;
    this.generation += 1;
    return this.generation;
  }

  invalidate(): void {
    this.active = false;
    this.generation += 1;
  }

  snapshot(): number {
    return this.generation;
  }

  isCurrent(generation: number): boolean {
    return this.active && generation === this.generation;
  }
}

export interface MicrophoneOperationTicket {
  token: number;
  previous: Promise<void> | null;
}

export class MicrophoneOperationGuard {
  private nextToken = 0;
  private current: { token: number; promise: Promise<void> | null } | null = null;

  begin(replace = false): MicrophoneOperationTicket | null {
    if (this.current && !replace) return null;
    const previous = this.current?.promise ?? null;
    const token = ++this.nextToken;
    this.current = { token, promise: null };
    return { token, previous };
  }

  track(token: number, promise: Promise<void>): void {
    if (this.current?.token === token) this.current.promise = promise;
  }

  finish(token: number): boolean {
    if (this.current?.token !== token) return false;
    this.current = null;
    return true;
  }

  invalidate(): Promise<void> | null {
    const previous = this.current?.promise ?? null;
    this.current = null;
    this.nextToken += 1;
    return previous;
  }

  get busy(): boolean {
    return this.current !== null;
  }
}

export async function settleMicrophoneOperation<T>(
  operation: Promise<T>,
  epoch: MicrophoneOperationEpoch,
  generation: number,
  onStale: () => void | Promise<void>,
): Promise<{ current: true; value: T } | { current: false }> {
  const value = await operation;
  if (epoch.isCurrent(generation)) return { current: true, value };
  await onStale();
  return { current: false };
}

const EMPTY_STATUS: MicrophoneTestStatus = {
  state: "idle",
  rms: 0,
  peak: 0,
  clipping: false,
  signalDetected: false,
  captureComplete: false,
  durationMs: 0,
  accessError: "",
  selectionResolution: "",
  reselectionRequired: false,
};

function objectArray(value: LocalJsonValue | undefined): Array<Record<string, LocalJsonValue>> {
  return Array.isArray(value)
    ? value.map((item) => asSetupRecord(item)).filter((item) => Object.keys(item).length > 0)
    : [];
}

export function parseMicrophoneDevices(value: LocalJsonValue): MicrophoneDevice[] {
  const root = asSetupRecord(value);
  const rows = objectArray(root.inputs).length
    ? objectArray(root.inputs)
    : objectArray(root.devices).length
      ? objectArray(root.devices)
      : objectArray(root.inputDevices);
  return rows.flatMap((row, index) => {
    const id = setupString(row.id ?? row.deviceId).trim();
    if (!id) return [];
    const ordinal = setupNumber(row.ordinal, Number.NaN);
    return [{
      id,
      label: setupString(row.label ?? row.name, `Microphone ${index + 1}`),
      isDefault: setupBoolean(row.isDefault),
      fingerprint: setupString(row.fingerprint) || undefined,
      ordinal: Number.isInteger(ordinal) && ordinal >= 0 ? ordinal : undefined,
    }];
  });
}

export function microphoneDevicesWithSystemDefault(value: LocalJsonValue): MicrophoneDevice[] {
  const root = asSetupRecord(value);
  const devices = parseMicrophoneDevices(value).map((device) => ({ ...device, isDefault: false }));
  if (!setupBoolean(root.defaultInputAvailable)) return devices;
  return [{
    id: "default",
    label: "System default microphone",
    isDefault: true,
  }, ...devices];
}

export function parseMicrophoneStatus(value: LocalJsonValue): MicrophoneTestStatus {
  const root = asSetupRecord(value);
  const accessError = asSetupRecord(root.accessError);
  const lastError = asSetupRecord(root.lastError);
  const accessMessage = [
    setupString(accessError.code),
    setupString(accessError.message),
    setupString(root.accessError),
    setupString(lastError.code),
    setupString(lastError.message),
    setupString(root.lastError),
  ].filter(Boolean).join(": ");
  const active = setupBoolean(root.active);
  const signalState = setupString(root.signalState);
  const reportedState = setupString(root.state);
  const state = (accessMessage && !active && (!reportedState || reportedState === "idle") ? "device-disconnected" : reportedState)
    || (active && signalState === "signal" ? "signal-detected" : active ? "listening" : "idle");
  return {
    state,
    rms: Math.max(0, Math.min(1, setupNumber(root.rms, setupNumber(root.rmsLevel)))),
    peak: Math.max(0, Math.min(1, setupNumber(root.peak, setupNumber(root.peakLevel)))),
    clipping: setupBoolean(root.clipping),
    signalDetected: setupBoolean(root.signalDetected),
    captureComplete: setupBoolean(root.captureComplete),
    durationMs: Math.max(0, setupNumber(root.durationMs, setupNumber(root.bufferedDurationMs))),
    accessError: accessMessage,
    selectionResolution: setupString(root.selectionResolution),
    reselectionRequired: setupBoolean(root.reselectionRequired),
  };
}

export function parseMicrophonePreferenceResolution(value: LocalJsonValue): MicrophonePreferenceResolution {
  const root = asSetupRecord(value);
  const preferred = asSetupRecord(root.preferredMicrophone);
  return {
    deviceId: setupString(
      preferred.deviceId,
      setupString(root.preferredMicrophoneId, setupString(root.preferredMicrophoneDeviceId, setupString(root.deviceId))),
    ),
    selectionResolution: setupString(preferred.resolution, setupString(root.selectionResolution)),
    reselectionRequired: setupBoolean(preferred.reselectionRequired, setupBoolean(root.reselectionRequired)),
  };
}

export function microphoneSelectionAfterPreference(
  devices: readonly MicrophoneDevice[],
  value: LocalJsonValue,
): MicrophonePreferenceResolution {
  const preference = parseMicrophonePreferenceResolution(value);
  const deviceId = devices.some((device) => device.id === preference.deviceId)
    ? preference.deviceId
    : devices.find((device) => device.isDefault)?.id ?? devices[0]?.id ?? "";
  return { ...preference, deviceId };
}

export function deriveMicrophoneUiState(input: {
  loading: boolean;
  deviceCount: number;
  listening: boolean;
  sampleReady: boolean;
  playbackReady: boolean;
  playbackCompleted: boolean;
  reselectionRequired?: boolean;
  error: string;
  status: MicrophoneTestStatus;
}): MicrophoneUiState {
  const state = input.status.state.toLowerCase();
  const error = `${input.error} ${input.status.accessError}`.toLowerCase();
  if (input.loading) return "loading-devices";
  if (state.includes("permission") || state.includes("denied") || /permission|denied|not.?allowed|access.?blocked|access.?denied|stream.?access/.test(error)) return "permission-denied";
  if (input.deviceCount === 0) return "no-device";
  if (state.includes("disconnect") || state.includes("device-lost") || error.includes("disconnect")) return "device-disconnected";
  if (input.error) return "retry";
  if (input.status.accessError) return "retry";
  if (input.reselectionRequired || input.status.reselectionRequired) return "reselection-required";
  if (input.playbackReady) return "playback-ready";
  if (input.playbackCompleted) return "playback-complete";
  if (input.status.clipping) return "clipping";
  if (input.sampleReady && input.status.signalDetected) return "signal-detected";
  if (input.sampleReady) return "no-signal";
  if (input.listening && input.status.signalDetected) return "signal-detected";
  if (input.listening && input.sampleReady && !input.status.signalDetected) return "no-signal";
  if (input.listening) return "listening";
  return "ready";
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function decodeWavBase64(base64: string): Blob {
  if (!base64 || base64.length > MAX_WAV_BASE64_CHARACTERS) {
    throw new Error("The microphone test sample was empty or exceeded the local playback limit.");
  }
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw new Error("The microphone test sample was not valid local audio.");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: "audio/wav" });
}

export function useMicrophoneSetup({ active, api = currentNativeSetupApi() }: UseMicrophoneSetupOptions): MicrophoneSetupController {
  const [devices, setDevices] = useState<MicrophoneDevice[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  const [status, setStatus] = useState<MicrophoneTestStatus>(EMPTY_STATUS);
  const [loading, setLoading] = useState(false);
  const [listening, setListening] = useState(false);
  const [sampleReady, setSampleReady] = useState(false);
  const [playbackUrl, setPlaybackUrl] = useState("");
  const [playbackCompleted, setPlaybackCompleted] = useState(false);
  const [operationBusy, setOperationBusy] = useState(false);
  const [selectionResolution, setSelectionResolution] = useState("");
  const [reselectionRequired, setReselectionRequired] = useState(false);
  const [error, setError] = useState("");
  const startedAtRef = useRef(0);
  const playbackUrlRef = useRef("");
  const operationEpochRef = useRef(new MicrophoneOperationEpoch());
  const operationGuardRef = useRef(new MicrophoneOperationGuard());

  const executeOperation = useCallback(async (
    replace: boolean,
    rejectedMessage: string,
    task: (previous: Promise<void> | null) => Promise<void>,
  ): Promise<boolean> => {
    const ticket = operationGuardRef.current.begin(replace);
    if (!ticket) {
      if (rejectedMessage) setError(rejectedMessage);
      return false;
    }
    setOperationBusy(true);
    const work = task(ticket.previous);
    operationGuardRef.current.track(ticket.token, work);
    try {
      await work;
      return true;
    } finally {
      if (operationGuardRef.current.finish(ticket.token)) setOperationBusy(false);
    }
  }, []);

  const revokePlayback = useCallback(() => {
    if (playbackUrlRef.current && typeof URL !== "undefined") URL.revokeObjectURL(playbackUrlRef.current);
    playbackUrlRef.current = "";
    setPlaybackUrl("");
  }, []);

  const clearPlayback = useCallback((completed: boolean) => {
    const hadPlayback = Boolean(playbackUrlRef.current);
    revokePlayback();
    setPlaybackCompleted(completed && hadPlayback);
  }, [revokePlayback]);

  const releaseNativeProbe = useCallback(async () => {
    if (!api?.capture.stopMicTest) return;
    try {
      await api.capture.stopMicTest();
    } catch {
      // Cleanup is best effort. A later retry surfaces actionable errors.
    }
  }, [api]);

  const refreshMicrophoneSetup = useCallback(async () => {
    if (!api) {
      setError("Native microphone testing is unavailable in this build.");
      return;
    }
    const generation = operationEpochRef.current.activate();
    await executeOperation(true, "", async (previous) => {
      setLoading(true);
      setError("");
      try {
        await releaseNativeProbe();
        await previous?.catch(() => undefined);
        if (!operationEpochRef.current.isCurrent(generation)) return;
        setListening(false);
        setSampleReady(false);
        setPlaybackCompleted(false);
        revokePlayback();
        const [deviceResult, preferenceResult] = await Promise.all([
          api.capture.getDevices(),
          api.capture.getPreferences?.() ?? Promise.resolve({}),
        ]);
        if (!operationEpochRef.current.isCurrent(generation)) return;
        const nextDevices = microphoneDevicesWithSystemDefault(deviceResult);
        const preference = microphoneSelectionAfterPreference(nextDevices, preferenceResult);
        setDevices(nextDevices);
        setSelectedDeviceId(preference.deviceId);
        setSelectionResolution(preference.selectionResolution);
        setReselectionRequired(preference.reselectionRequired);
        setStatus(EMPTY_STATUS);
      } catch (reason) {
        if (!operationEpochRef.current.isCurrent(generation)) return;
        setError(errorMessage(reason));
        setDevices([]);
      } finally {
        if (operationEpochRef.current.isCurrent(generation)) setLoading(false);
      }
    });
  }, [api, executeOperation, releaseNativeProbe, revokePlayback]);

  const selectDevice = useCallback(async (deviceId: string) => {
    const device = devices.find((candidate) => candidate.id === deviceId);
    if (!device || !api) return;
    const generation = operationEpochRef.current.activate();
    setSelectedDeviceId(deviceId);
    await executeOperation(true, "", async (previous) => {
      try {
        await releaseNativeProbe();
        await previous?.catch(() => undefined);
        if (!operationEpochRef.current.isCurrent(generation)) return;
        setListening(false);
        setSampleReady(false);
        setPlaybackCompleted(false);
        setStatus(EMPTY_STATUS);
        setError("");
        revokePlayback();
        if (!api.capture.setPreferredMicrophone) return;
        const preference = await settleMicrophoneOperation(
          api.capture.setPreferredMicrophone({
            deviceId: device.id,
            fingerprint: device.fingerprint,
            ordinal: device.ordinal,
          }),
          operationEpochRef.current,
          generation,
          releaseNativeProbe,
        );
        if (!preference.current) return;
        const resolution = parseMicrophonePreferenceResolution(preference.value);
        setSelectionResolution(resolution.selectionResolution);
        setReselectionRequired(resolution.reselectionRequired);
      } catch (reason) {
        if (!operationEpochRef.current.isCurrent(generation)) {
          await releaseNativeProbe();
          return;
        }
        setError(errorMessage(reason));
      }
    });
  }, [api, devices, executeOperation, releaseNativeProbe, revokePlayback]);

  const startTest = useCallback(async () => {
    if (!active || !api?.capture.startMicTest || !selectedDeviceId) {
      setError(selectedDeviceId ? "Native microphone testing is unavailable in this build." : "Choose a microphone before testing.");
      return;
    }
    const startMicTest = api.capture.startMicTest;
    const generation = operationEpochRef.current.snapshot();
    await executeOperation(false, "A microphone test is already starting. Wait for it to finish before trying again.", async () => {
      setError("");
      setStatus({ ...EMPTY_STATUS, state: "starting" });
      setSampleReady(false);
      setPlaybackCompleted(false);
      revokePlayback();
      try {
        const device = devices.find((candidate) => candidate.id === selectedDeviceId);
        if (device && api.capture.setPreferredMicrophone) {
          const preference = await settleMicrophoneOperation(
            api.capture.setPreferredMicrophone({
              deviceId: device.id,
              fingerprint: device.fingerprint,
              ordinal: device.ordinal,
            }),
            operationEpochRef.current,
            generation,
            releaseNativeProbe,
          );
          if (!preference.current) return;
          const resolution = parseMicrophonePreferenceResolution(preference.value);
          setSelectionResolution(resolution.selectionResolution);
          setReselectionRequired(resolution.reselectionRequired);
        }
        const started = await settleMicrophoneOperation(
          startMicTest(),
          operationEpochRef.current,
          generation,
          releaseNativeProbe,
        );
        if (!started.current) return;
        const nextStatus = parseMicrophoneStatus(started.value);
        setStatus(nextStatus);
        setSelectionResolution(nextStatus.selectionResolution);
        setReselectionRequired(nextStatus.reselectionRequired);
        startedAtRef.current = Date.now();
        setListening(true);
      } catch (reason) {
        if (!operationEpochRef.current.isCurrent(generation)) {
          await releaseNativeProbe();
          return;
        }
        setListening(false);
        setStatus(EMPTY_STATUS);
        setError(errorMessage(reason));
      }
    });
  }, [active, api, devices, executeOperation, releaseNativeProbe, revokePlayback, selectedDeviceId]);

  const stopTest = useCallback(async () => {
    const generation = operationEpochRef.current.activate();
    await executeOperation(true, "", async (previous) => {
      await releaseNativeProbe();
      await previous?.catch(() => undefined);
      await releaseNativeProbe();
      if (!operationEpochRef.current.isCurrent(generation)) return;
      setListening(false);
      setSampleReady(false);
      setPlaybackCompleted(false);
      setStatus(EMPTY_STATUS);
    });
  }, [executeOperation, releaseNativeProbe]);

  const preparePlayback = useCallback(async () => {
    if (!active || !api?.capture.getMicTestSample || !sampleReady) return;
    const getMicTestSample = api.capture.getMicTestSample;
    const generation = operationEpochRef.current.snapshot();
    if (!status.signalDetected) {
      setError("No microphone signal was detected. Retry the test or set up the microphone later.");
      return;
    }
    await executeOperation(false, "A microphone setup operation is already in progress.", async () => {
      setError("");
      try {
        const sample = await settleMicrophoneOperation(
          getMicTestSample(),
          operationEpochRef.current,
          generation,
          releaseNativeProbe,
        );
        if (!sample.current) return;
        const result = asSetupRecord(sample.value);
        const mimeType = setupString(result.mimeType, "audio/wav");
        if (mimeType !== "audio/wav") throw new Error("The microphone test returned an unsupported audio format.");
        const base64 = setupString(result.base64, setupString(result.dataBase64));
        const nextUrl = URL.createObjectURL(decodeWavBase64(base64));
        revokePlayback();
        setPlaybackCompleted(false);
        playbackUrlRef.current = nextUrl;
        setPlaybackUrl(nextUrl);
        await releaseNativeProbe();
        setListening(false);
        setSampleReady(false);
      } catch (reason) {
        if (!operationEpochRef.current.isCurrent(generation)) {
          await releaseNativeProbe();
          return;
        }
        setError(errorMessage(reason));
      }
    });
  }, [active, api, executeOperation, releaseNativeProbe, revokePlayback, sampleReady, status.signalDetected]);

  const openPrivacySettings = useCallback(async () => {
    if (!api?.capture.openMicrophoneSettings) return;
    setError("");
    try {
      await api.capture.openMicrophoneSettings();
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }, [api]);

  useEffect(() => {
    if (!active) {
      operationEpochRef.current.invalidate();
      operationGuardRef.current.invalidate();
      setOperationBusy(false);
      setLoading(false);
      setListening(false);
      setSampleReady(false);
      setPlaybackCompleted(false);
      setStatus(EMPTY_STATUS);
      setSelectionResolution("");
      setReselectionRequired(false);
      revokePlayback();
      void releaseNativeProbe();
      return;
    }
    void refreshMicrophoneSetup();
    return () => {
      operationEpochRef.current.invalidate();
      operationGuardRef.current.invalidate();
      void releaseNativeProbe();
    };
  }, [active, refreshMicrophoneSetup, releaseNativeProbe, revokePlayback]);

  useEffect(() => {
    if (!active || !listening || !api?.capture.getMicTestStatus) return;
    const generation = operationEpochRef.current.snapshot();
    let disposed = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const next = parseMicrophoneStatus(await api.capture.getMicTestStatus!());
        if (disposed || !operationEpochRef.current.isCurrent(generation)) return;
        setStatus(next);
        if (next.selectionResolution) setSelectionResolution(next.selectionResolution);
        setReselectionRequired(next.reselectionRequired);
        const state = next.state.toLowerCase();
        if (next.captureComplete || state.includes("playback-ready") || state.includes("no-signal")) {
          setSampleReady(true);
          setListening(false);
        } else if (state.includes("disconnect") || state.includes("denied") || state.includes("error")) {
          setListening(false);
        }
      } catch (reason) {
        if (!disposed && operationEpochRef.current.isCurrent(generation)) {
          setError(errorMessage(reason));
          setListening(false);
        }
      } finally {
        if (!disposed && operationEpochRef.current.isCurrent(generation)) timer = window.setTimeout(() => void poll(), MIC_STATUS_POLL_MS);
      }
    };
    void poll();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [active, api, listening]);

  useEffect(() => {
    if (!listening || sampleReady) return;
    const generation = operationEpochRef.current.snapshot();
    const remaining = Math.max(0, MIC_TEST_DURATION_MS - (Date.now() - startedAtRef.current));
    const timer = window.setTimeout(() => {
      if (operationEpochRef.current.isCurrent(generation)) setSampleReady(true);
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [listening, sampleReady]);

  useEffect(() => () => {
    if (playbackUrlRef.current && typeof URL !== "undefined") URL.revokeObjectURL(playbackUrlRef.current);
  }, []);

  const uiState = useMemo(() => deriveMicrophoneUiState({
    loading,
    deviceCount: devices.length,
    listening,
    sampleReady,
    playbackReady: Boolean(playbackUrl),
    playbackCompleted,
    reselectionRequired,
    error,
    status,
  }), [devices.length, error, listening, loading, playbackCompleted, playbackUrl, reselectionRequired, sampleReady, status]);

  return {
    devices,
    selectedDeviceId,
    status,
    uiState,
    loading,
    listening,
    sampleReady,
    playbackUrl,
    playbackCompleted,
    operationBusy,
    selectionResolution,
    reselectionRequired,
    error,
    selectDevice,
    startTest,
    preparePlayback,
    clearPlayback,
    stopTest,
    retry: refreshMicrophoneSetup,
    openPrivacySettings,
  };
}
