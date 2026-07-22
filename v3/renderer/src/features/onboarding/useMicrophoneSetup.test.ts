import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import {
  deriveMicrophoneUiState,
  MicrophoneOperationGuard,
  MicrophoneOperationEpoch,
  microphoneDevicesWithSystemDefault,
  microphoneSelectionAfterPreference,
  parseMicrophoneDevices,
  parseMicrophonePreferenceResolution,
  parseMicrophoneStatus,
  settleMicrophoneOperation,
} from "./useMicrophoneSetup";

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("native microphone setup parsing", () => {
  it("rejects a same-tick duplicate start before either native call can settle", async () => {
    const guard = new MicrophoneOperationGuard();
    const first = guard.begin();
    expect(first).not.toBeNull();
    const nativeStart = deferred<void>();
    guard.track(first!.token, nativeStart.promise);

    expect(guard.begin()).toBeNull();
    expect(guard.busy).toBe(true);

    nativeStart.resolve();
    await nativeStart.promise;
    expect(guard.finish(first!.token)).toBe(true);
    expect(guard.busy).toBe(false);
  });

  it("invalidates an in-flight start on device change and waits for stale probe cleanup", async () => {
    const guard = new MicrophoneOperationGuard();
    const epoch = new MicrophoneOperationEpoch();
    const startGeneration = epoch.activate();
    const nativeStart = deferred<{ active: boolean }>();
    const cleanup = vi.fn(async () => undefined);
    const startTicket = guard.begin();
    const staleStart = settleMicrophoneOperation(nativeStart.promise, epoch, startGeneration, cleanup).then(() => undefined);
    guard.track(startTicket!.token, staleStart);

    const deviceGeneration = epoch.activate();
    const deviceTicket = guard.begin(true);
    expect(deviceTicket?.previous).toBe(staleStart);
    expect(epoch.isCurrent(startGeneration)).toBe(false);
    expect(epoch.isCurrent(deviceGeneration)).toBe(true);

    nativeStart.resolve({ active: true });
    await deviceTicket?.previous;
    expect(cleanup).toHaveBeenCalledOnce();
    expect(guard.finish(startTicket!.token)).toBe(false);
    expect(guard.finish(deviceTicket!.token)).toBe(true);
  });

  it("cleans up a delayed native start that completes after step exit", async () => {
    const epoch = new MicrophoneOperationEpoch();
    const generation = epoch.activate();
    const operation = deferred<{ active: boolean }>();
    const cleanup = vi.fn(async () => undefined);
    const settled = settleMicrophoneOperation(operation.promise, epoch, generation, cleanup);
    epoch.invalidate();
    operation.resolve({ active: true });
    await expect(settled).resolves.toEqual({ current: false });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("discards a delayed sample payload that returns after step exit", async () => {
    const epoch = new MicrophoneOperationEpoch();
    const generation = epoch.activate();
    const operation = deferred<{ dataBase64: string }>();
    const cleanup = vi.fn(async () => undefined);
    const settled = settleMicrophoneOperation(operation.promise, epoch, generation, cleanup);
    epoch.invalidate();
    operation.resolve({ dataBase64: "late-private-audio" });
    await expect(settled).resolves.toEqual({ current: false });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("keeps only bounded pathless input device metadata", () => {
    expect(parseMicrophoneDevices({
      inputs: [
        { id: "input-0", label: "USB microphone", isDefault: true, fingerprint: "abc123", ordinal: 0, rawPathExposed: false },
        { id: "", label: "invalid" },
      ],
      rawPathExposed: false,
    })).toEqual([{
      id: "input-0",
      label: "USB microphone",
      isDefault: true,
      fingerprint: "abc123",
      ordinal: 0,
    }]);
  });

  it("uses one virtual system-default choice instead of trusting ambiguous device labels", () => {
    expect(microphoneDevicesWithSystemDefault({
      defaultInputAvailable: true,
      inputs: [
        { id: "input-0", label: "USB microphone", isDefault: true, fingerprint: "abc123", ordinal: 0 },
        { id: "input-1", label: "USB microphone", isDefault: true, fingerprint: "def456", ordinal: 1 },
      ],
    })).toEqual([
      { id: "default", label: "System default microphone", isDefault: true },
      { id: "input-0", label: "USB microphone", isDefault: false, fingerprint: "abc123", ordinal: 0 },
      { id: "input-1", label: "USB microphone", isDefault: false, fingerprint: "def456", ordinal: 1 },
    ]);
  });

  it("does not invent a default device while hardware is missing or the OS has none", () => {
    expect(microphoneDevicesWithSystemDefault({
      defaultInputAvailable: false,
      inputs: [],
    })).toEqual([]);
    expect(microphoneDevicesWithSystemDefault({
      defaultInputAvailable: false,
      inputs: [
        { id: "input-0", label: "USB microphone", isDefault: true, fingerprint: "abc123", ordinal: 0 },
      ],
    })).toEqual([
      { id: "input-0", label: "USB microphone", isDefault: false, fingerprint: "abc123", ordinal: 0 },
    ]);
  });

  it("normalizes levels and permission errors", () => {
    expect(parseMicrophoneStatus({
      state: "permission-denied",
      rms: -1,
      peak: 5,
      clipping: false,
      signalDetected: false,
      captureComplete: false,
      accessError: { message: "Permission denied by Windows" },
    })).toEqual({
      state: "permission-denied",
      rms: 0,
      peak: 1,
      clipping: false,
      signalDetected: false,
      captureComplete: false,
      durationMs: 0,
      accessError: "Permission denied by Windows",
      selectionResolution: "",
      reselectionRequired: false,
    });
  });

  it.each([
    ["default-fallback", "saved fingerprint is missing"],
    ["ambiguous-fingerprint", "saved fingerprint is ambiguous"],
  ])("preserves %s as an explicit reselection request when the %s", (resolution) => {
    const preference = {
      preferredMicrophoneId: "default",
      preferredMicrophone: {
        deviceId: "default",
        resolution,
        reselectionRequired: true,
      },
    };
    expect(parseMicrophonePreferenceResolution(preference)).toEqual({
      deviceId: "default",
      selectionResolution: resolution,
      reselectionRequired: true,
    });
    expect(microphoneSelectionAfterPreference([
      { id: "default", label: "System default microphone", isDefault: true },
      { id: "input-0", label: "Replacement microphone", isDefault: false },
    ], preference)).toEqual({
      deviceId: "default",
      selectionResolution: resolution,
      reselectionRequired: true,
    });
  });

  it("derives device loss from an inactive probe with a retained core error", () => {
    expect(parseMicrophoneStatus({
      active: false,
      state: "idle",
      signalState: "inactive",
      lastError: "capture stream ended after the device was removed",
    })).toMatchObject({
      state: "device-disconnected",
      accessError: "capture stream ended after the device was removed",
    });
  });

  it("prioritizes safety states over normal meter states", () => {
    const base = {
      loading: false,
      deviceCount: 1,
      listening: true,
      sampleReady: true,
      playbackReady: false,
      playbackCompleted: false,
      error: "",
      status: { state: "listening", rms: 0.5, peak: 0.99, clipping: true, signalDetected: true, captureComplete: false, durationMs: 5_000, accessError: "", selectionResolution: "fingerprint", reselectionRequired: false },
    };
    expect(deriveMicrophoneUiState(base)).toBe("clipping");
    expect(deriveMicrophoneUiState({ ...base, status: { ...base.status, state: "device-disconnected", clipping: false } })).toBe("device-disconnected");
    expect(deriveMicrophoneUiState({ ...base, status: { ...base.status, state: "permission-denied", clipping: false } })).toBe("permission-denied");
    expect(deriveMicrophoneUiState({ ...base, status: { ...base.status, state: "idle", clipping: false, accessError: "MICROPHONE_STREAM_ACCESS_FAILED" } })).toBe("permission-denied");
    expect(deriveMicrophoneUiState({ ...base, error: "CANDOR_CORE_ERROR:CAPTURE_MICROPHONE_PERMISSION_DENIED", status: { ...base.status, clipping: false } })).toBe("permission-denied");
    expect(deriveMicrophoneUiState({ ...base, deviceCount: 0, status: { ...base.status, state: "permission-denied", clipping: false } })).toBe("permission-denied");
    expect(deriveMicrophoneUiState({
      ...base,
      listening: false,
      sampleReady: false,
      playbackCompleted: true,
      status: { ...base.status, state: "idle", clipping: false, signalDetected: false },
    })).toBe("playback-complete");
    expect(deriveMicrophoneUiState({
      ...base,
      listening: false,
      sampleReady: false,
      reselectionRequired: true,
      status: { ...base.status, state: "idle", clipping: false, signalDetected: false },
    })).toBe("reselection-required");
  });

  it("moves deterministically from silence through retryable terminal states", () => {
    const base = {
      loading: false,
      deviceCount: 1,
      listening: true,
      sampleReady: false,
      playbackReady: false,
      playbackCompleted: false,
      error: "",
      status: { state: "listening", rms: 0, peak: 0, clipping: false, signalDetected: false, captureComplete: false, durationMs: 0, accessError: "", selectionResolution: "fingerprint", reselectionRequired: false },
    };
    expect(deriveMicrophoneUiState(base)).toBe("listening");
    expect(deriveMicrophoneUiState({
      ...base,
      listening: false,
      sampleReady: true,
      status: { ...base.status, state: "no-signal", captureComplete: true },
    })).toBe("no-signal");
    expect(deriveMicrophoneUiState({
      ...base,
      listening: false,
      status: { ...base.status, state: "device-disconnected", accessError: "MICROPHONE_DEVICE_DISCONNECTED" },
    })).toBe("device-disconnected");
    expect(deriveMicrophoneUiState({
      ...base,
      listening: false,
      status: { ...base.status, state: "permission-denied", accessError: "MICROPHONE_PERMISSION_DENIED" },
    })).toBe("permission-denied");
    expect(deriveMicrophoneUiState({
      ...base,
      listening: false,
      error: "The microphone could not be reopened",
      status: { ...base.status, state: "idle" },
    })).toBe("retry");
  });
});
