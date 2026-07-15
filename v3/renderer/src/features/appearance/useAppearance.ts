import { useCallback, useLayoutEffect, useSyncExternalStore } from "react";

export type AppearanceMode = "light" | "dark";

const STORAGE_KEY = "candor.appearance";
const subscribers = new Set<() => void>();
let appearanceState: AppearanceMode | undefined;

function preferredAppearance(): AppearanceMode {
  if (typeof window === "undefined") return "light";
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // Appearance still follows the operating system when storage is unavailable.
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function appearanceSnapshot(): AppearanceMode {
  appearanceState ??= preferredAppearance();
  return appearanceState;
}

function subscribeAppearance(listener: () => void): () => void {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

function updateAppearance(next: AppearanceMode): void {
  if (appearanceSnapshot() === next) return;
  appearanceState = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // A blocked preference store should not block the rest of the workspace.
  }
  subscribers.forEach((listener) => listener());
}

export function useAppearance() {
  const appearance = useSyncExternalStore(subscribeAppearance, appearanceSnapshot, () => "light");

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = appearance;
    document.documentElement.style.colorScheme = appearance;
  }, [appearance]);

  const setAppearance = useCallback((next: AppearanceMode) => {
    updateAppearance(next);
  }, []);

  const toggleAppearance = useCallback(() => {
    setAppearance(appearance === "dark" ? "light" : "dark");
  }, [appearance, setAppearance]);

  return { appearance, setAppearance, toggleAppearance };
}
