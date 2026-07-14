import { describe, expect, it, vi } from "vitest";
import type { LocalAiRecap } from "../../core/contracts";
import { buildRecapFallbackAlert } from "./fallback-alert";

const fallbackRecap: LocalAiRecap = {
  engine: "heuristic",
  summary: "Fallback summary",
  markdown: "Fallback summary",
  decisions: [],
  actions: [],
  risks: [],
  questions: [],
  citations: [],
  provenance: {
    engine: "heuristic",
    modelId: null,
    fallbackUsed: true,
    fallbackReason: "llm-unavailable",
    promptVersion: "recap-v3",
    generatedAt: "2026-07-14T12:00:00Z",
  },
};

describe("recap fallback alert", () => {
  it("persists in every view that can display or export the fallback result", () => {
    const retry = vi.fn();
    for (const view of ["meeting", "review", "export"] as const) {
      const alert = buildRecapFallbackAlert(fallbackRecap, view, retry);
      expect(alert?.actions?.[0]?.label).toBe("Retry with Local AI");
      alert?.actions?.[0]?.onActivate();
    }
    expect(retry).toHaveBeenCalledTimes(3);
    expect(buildRecapFallbackAlert(fallbackRecap, "home", retry)).toBeNull();
  });

  it("distinguishes an explicit fallback selection from an unavailable model", () => {
    const explicit = {
      ...fallbackRecap,
      provenance: { ...fallbackRecap.provenance, fallbackReason: "user-requested" as const },
    };
    expect(buildRecapFallbackAlert(explicit, "review", vi.fn())?.message)
      .toContain("fallback you selected");
    expect(buildRecapFallbackAlert(fallbackRecap, "review", vi.fn())?.message)
      .toContain("model was unavailable");
  });
});
