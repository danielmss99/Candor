import { useCallback, useEffect, useState } from "react";
import type { LocalJsonValue } from "../../core/contracts";
import { asSetupRecord, currentNativeSetupApi, setupBoolean, setupString, type NativeSetupApi } from "./setup-api";
import { SUGGESTED_SHORTCUT } from "./setup-types";
import { recorderShortcutTestGate } from "./shortcut-test-gate";

export interface ShortcutSetupStatus {
  enabled: boolean;
  registered: boolean;
  accelerator: string;
  conflict: boolean;
  message: string;
}

export interface ShortcutSetupController {
  status: ShortcutSetupStatus;
  draftAccelerator: string;
  loading: boolean;
  saving: boolean;
  awaitingTest: boolean;
  testPassed: boolean;
  error: string;
  setDraftAccelerator: (value: string) => void;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
  reset: () => Promise<void>;
  beginTest: () => void;
  retry: () => Promise<void>;
}

interface UseShortcutSetupOptions {
  active: boolean;
  api?: NativeSetupApi;
}

const EMPTY_STATUS: ShortcutSetupStatus = {
  enabled: false,
  registered: false,
  accelerator: SUGGESTED_SHORTCUT,
  conflict: false,
  message: "",
};

export function parseShortcutStatus(value: LocalJsonValue): ShortcutSetupStatus {
  const root = asSetupRecord(value);
  const shortcut = Object.keys(asSetupRecord(root.shortcut)).length ? asSetupRecord(root.shortcut) : root;
  return {
    enabled: setupBoolean(shortcut.enabled),
    registered: setupBoolean(shortcut.registered),
    accelerator: setupString(shortcut.accelerator, SUGGESTED_SHORTCUT),
    conflict: setupBoolean(shortcut.conflict) || setupString(shortcut.state).toLowerCase() === "conflict",
    message: setupString(shortcut.message, setupString(shortcut.error)),
  };
}

function shortcutError(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export function useShortcutSetup({ active, api = currentNativeSetupApi() }: UseShortcutSetupOptions): ShortcutSetupController {
  const [status, setStatus] = useState<ShortcutSetupStatus>(EMPTY_STATUS);
  const [draftAccelerator, setDraftAcceleratorState] = useState(SUGGESTED_SHORTCUT);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [awaitingTest, setAwaitingTest] = useState(false);
  const [testPassed, setTestPassed] = useState(false);
  const [error, setError] = useState("");

  const applyStatus = useCallback((value: LocalJsonValue) => {
    const next = parseShortcutStatus(value);
    setStatus(next);
    setDraftAcceleratorState(next.accelerator);
    return next;
  }, []);

  const refreshShortcutStatus = useCallback(async () => {
    if (!api?.shortcuts) {
      setError("Global shortcuts are unavailable in this build.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      applyStatus(await api.shortcuts.getStatus());
    } catch (reason) {
      setError(shortcutError(reason));
    } finally {
      setLoading(false);
    }
  }, [api, applyStatus]);

  const setDraftAccelerator = useCallback((value: string) => {
    setDraftAcceleratorState(value.slice(0, 64));
    setError("");
    recorderShortcutTestGate.disarm();
    setAwaitingTest(false);
    setTestPassed(false);
  }, []);

  const enable = useCallback(async () => {
    if (!api?.shortcuts) {
      setError("Global shortcuts are unavailable in this build.");
      return;
    }
    setSaving(true);
    setError("");
    recorderShortcutTestGate.disarm();
    setAwaitingTest(false);
    setTestPassed(false);
    try {
      const next = applyStatus(await api.shortcuts.update({ enabled: true, accelerator: draftAccelerator.trim() }));
      if (!next.registered) setError(next.message || "That shortcut could not be registered. Another application may already use it.");
    } catch (reason) {
      setError(shortcutError(reason));
    } finally {
      setSaving(false);
    }
  }, [api, applyStatus, draftAccelerator]);

  const disable = useCallback(async () => {
    if (!api?.shortcuts) return;
    setSaving(true);
    setError("");
    recorderShortcutTestGate.disarm();
    setAwaitingTest(false);
    setTestPassed(false);
    try {
      applyStatus(await api.shortcuts.update({ enabled: false, accelerator: status.accelerator }));
    } catch (reason) {
      setError(shortcutError(reason));
    } finally {
      setSaving(false);
    }
  }, [api, applyStatus, status.accelerator]);

  const reset = useCallback(async () => {
    if (!api?.shortcuts) return;
    setSaving(true);
    setError("");
    recorderShortcutTestGate.disarm();
    setAwaitingTest(false);
    setTestPassed(false);
    try {
      applyStatus(await api.shortcuts.reset());
    } catch (reason) {
      setError(shortcutError(reason));
    } finally {
      setSaving(false);
    }
  }, [api, applyStatus]);

  const beginTest = useCallback(() => {
    recorderShortcutTestGate.arm();
    setAwaitingTest(true);
    setTestPassed(false);
  }, []);

  useEffect(() => {
    if (active) {
      recorderShortcutTestGate.disarm();
      void refreshShortcutStatus();
      return () => recorderShortcutTestGate.disarm();
    }
    recorderShortcutTestGate.disarm();
    setAwaitingTest(false);
  }, [active, refreshShortcutStatus]);

  useEffect(() => {
    if (!active || !api?.events) return;
    return api.events.subscribe("shortcut.triggered", () => {
      if (!recorderShortcutTestGate.consumeTrigger()) return;
      setAwaitingTest(false);
      setTestPassed(true);
    });
  }, [active, api]);

  return {
    status,
    draftAccelerator,
    loading,
    saving,
    awaitingTest,
    testPassed,
    error,
    setDraftAccelerator,
    enable,
    disable,
    reset,
    beginTest,
    retry: refreshShortcutStatus,
  };
}
