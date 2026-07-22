import type { OnboardingStep } from "../../core/contracts";

export const SETUP_STEPS = [
  { id: "yours", label: "License" },
  { id: "microphone", label: "Microphone" },
  { id: "shortcut", label: "Shortcut" },
  { id: "system-audio", label: "System audio" },
  { id: "storage", label: "Storage" },
  { id: "local-ai", label: "Local AI" },
] as const satisfies ReadonlyArray<{ id: OnboardingStep; label: string }>;

export type SetupFlowStep = (typeof SETUP_STEPS)[number]["id"];
export type PersistedSetupStep = "license" | Exclude<SetupFlowStep, "yours">;

export function persistedSetupStep(step: SetupFlowStep): PersistedSetupStep {
  return step === "yours" ? "license" : step;
}

export interface SetupNavigationProps {
  onBack: () => void | Promise<void>;
  onContinue: () => void | Promise<void>;
  onDefer?: () => void | Promise<void>;
  navigationBusy?: boolean;
}

export const SUGGESTED_SHORTCUT = "CommandOrControl+Shift+Space";
