import type { AppView, LocalAiRecap, PersistentAlert } from "../../core/contracts";

const recapViews = new Set<AppView>(["meeting", "review", "export"]);

export function buildRecapFallbackAlert(
  recap: LocalAiRecap | null,
  view: AppView,
  onRetry: () => void,
): PersistentAlert | null {
  if (!recap?.provenance.fallbackUsed || !recapViews.has(view)) return null;
  return {
    id: "recap-local-fallback",
    severity: "warning",
    title: "Recap uses the local fallback",
    message: recap.provenance.fallbackReason === "user-requested"
      ? "This recap was created with the fallback you selected. The existing result stays available while you retry."
      : "The packaged Local AI model was unavailable. The existing result stays available while you retry.",
    actions: [{ label: "Retry with Local AI", primary: true, onActivate: onRetry }],
  };
}
