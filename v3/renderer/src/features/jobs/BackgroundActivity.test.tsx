import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BackgroundActivity } from "./BackgroundActivity";

describe("BackgroundActivity", () => {
  it("shows pathless progress, an estimate, and meeting controls for active work", () => {
    const markup = renderToStaticMarkup(
      <BackgroundActivity
        jobs={[{
          jobId: "a".repeat(32),
          type: "transcription",
          state: "running",
          stage: "transcribing",
          recordingId: "recording-1",
          progress: { completed: 2, total: 4, unit: "stage" },
          estimatedRemainingMs: 120_000,
          terminal: false,
          retryable: false,
        }]}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onCancelAll={vi.fn()}
        onOpenMeeting={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(markup).toContain("1 job running");
    expect(markup).toContain("Transcribing meeting");
    expect(markup).toContain("50%");
    expect(markup).toContain("About 2 minutes remaining");
    expect(markup).toContain('aria-label="Open meeting for Transcribing meeting"');
    expect(markup).toContain('aria-label="Cancel Transcribing meeting"');
  });

  it("keeps failed work retryable and dismissible without displaying user content", () => {
    const markup = renderToStaticMarkup(
      <BackgroundActivity
        jobs={[{
          jobId: "b".repeat(32),
          type: "recap",
          state: "failed",
          stage: "failed",
          recordingId: "recording-2",
          terminal: true,
          retryable: true,
          error: { message: "The local recap could not be completed. Your meeting is safe." },
        }]}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onCancelAll={vi.fn()}
        onOpenMeeting={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(markup).toContain("1 job needs attention");
    expect(markup).toContain("Your meeting is safe");
    expect(markup).toContain('aria-label="Retry Creating recap"');
    expect(markup).toContain('aria-label="Dismiss Creating recap"');
  });
});
