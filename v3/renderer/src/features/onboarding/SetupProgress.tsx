import type { OnboardingStep } from "../../core/contracts";
import { persistedSetupStep, SETUP_STEPS, type PersistedSetupStep } from "./setup-types";

interface OnboardingProgressProps {
  step: OnboardingStep;
  completed?: readonly PersistedSetupStep[];
  deferred?: readonly PersistedSetupStep[];
}

export function OnboardingProgress({ step, completed = [], deferred = [] }: OnboardingProgressProps) {
  return (
    <ol className="onboarding-progress" aria-label="Setup progress">
      {SETUP_STEPS.map(({ id, label }, index) => {
        const persistedStep = persistedSetupStep(id);
        const current = id === step;
        const complete = completed.includes(persistedStep);
        const wasDeferred = deferred.includes(persistedStep);
        const disposition = current
          ? complete
            ? "current step, complete"
            : wasDeferred
              ? "current step, previously deferred"
              : "current step"
          : complete
            ? "complete"
            : wasDeferred
              ? "deferred"
              : "not started";
        return (
          <li
            key={id}
            aria-label={`${label}, ${disposition}`}
            aria-current={current ? "step" : undefined}
            data-active={current}
            data-complete={complete}
            data-deferred={wasDeferred}
            data-disposition={complete ? "completed" : wasDeferred ? "deferred" : "pending"}
          >
            <span aria-hidden="true">{index + 1}</span>
            <strong>{label}</strong>
          </li>
        );
      })}
    </ol>
  );
}
