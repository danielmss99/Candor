import type { LocalJsonValue } from "../../core/contracts";

export interface NativeSetupApi {
  capture: {
    getDevices(): Promise<LocalJsonValue>;
    getPreferences?(): Promise<LocalJsonValue>;
    setPreferredMicrophone?(input: {
      deviceId: string;
      fingerprint?: string;
      ordinal?: number;
    }): Promise<LocalJsonValue>;
    startMicTest?(): Promise<LocalJsonValue>;
    getMicTestStatus?(): Promise<LocalJsonValue>;
    getMicTestSample?(): Promise<LocalJsonValue>;
    stopMicTest?(): Promise<LocalJsonValue>;
    openMicrophoneSettings?(): Promise<LocalJsonValue>;
  };
  shortcuts?: {
    getStatus(): Promise<LocalJsonValue>;
    update(input: { enabled: boolean; accelerator: string }): Promise<LocalJsonValue>;
    reset(): Promise<LocalJsonValue>;
  };
  events?: {
    subscribe(eventName: string, listener: (payload: LocalJsonValue) => void): () => void;
  };
}

export function currentNativeSetupApi(): NativeSetupApi | undefined {
  if (typeof window === "undefined" || !window.candor) return undefined;
  return window.candor as unknown as NativeSetupApi;
}

export function asSetupRecord(value: LocalJsonValue | undefined): Record<string, LocalJsonValue> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, LocalJsonValue>
    : {};
}

export function setupString(value: LocalJsonValue | undefined, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function setupNumber(value: LocalJsonValue | undefined, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function setupBoolean(value: LocalJsonValue | undefined, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}
