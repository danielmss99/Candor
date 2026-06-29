import type { OnboardingState } from "../v2/metadata";

interface OnboardingChecklistProps {
  state: OnboardingState;
  onConnectCalendar: () => void;
  onStartRecording: () => void;
  onOpenMeetings: () => void;
  onOpenTasks: () => void;
}

const STEPS: {
  key: keyof OnboardingState;
  label: string;
  action: (p: OnboardingChecklistProps) => void;
}[] = [
  { key: "calendarConnected", label: "Connect your calendar", action: (p) => p.onConnectCalendar() },
  { key: "firstRecording", label: "Record your first meeting", action: (p) => p.onStartRecording() },
  { key: "recapReviewed", label: "Review a recap", action: (p) => p.onOpenMeetings() },
  { key: "taskCompleted", label: "Complete a task", action: (p) => p.onOpenTasks() },
];

export function OnboardingChecklist(props: OnboardingChecklistProps) {
  const { state } = props;
  const done = STEPS.filter((s) => state[s.key]).length;
  if (done >= STEPS.length) return null;

  return (
    <section className="onboarding-card">
      <div className="onboarding-head">
        <span className="section-label section-label--calm">Getting started</span>
        <span className="onboarding-progress">
          {done}/{STEPS.length}
        </span>
      </div>
      <ul className="onboarding-list">
        {STEPS.map((step) => (
          <li key={step.key} className="onboarding-step">
            <span
              className={`onboarding-check ${state[step.key] ? "onboarding-check--done" : ""}`}
              aria-hidden="true"
            >
              {state[step.key] ? "✓" : ""}
            </span>
            <button
              type="button"
              className="onboarding-label"
              disabled={state[step.key]}
              onClick={() => step.action(props)}
            >
              {step.label}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
