import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BackgroundActivity, terminalTaskAnnouncement } from "./BackgroundActivity";

describe("BackgroundActivity", () => {
  it("shows pathless progress, an estimate, and meeting controls for active work", () => {
    const markup = renderToStaticMarkup(
      <BackgroundActivity
        jobs={[{
          jobId: "a".repeat(32),
          type: "transcription",
          state: "running",
          createdAt: "2026-07-14T05:00:00Z",
          updatedAt: "2026-07-14T05:00:01Z",
          stage: "transcribing",
          recordingId: "recording-1",
          progress: { completed: 50, total: 100, unit: "percent" },
          estimatedRemainingMs: 120_000,
          terminal: false,
          retryable: false,
          cancelRequested: false,
          retryCount: 0,
          sourceDataPreserved: true,
          rawPathExposed: false,
          keyMaterialExposedToRenderer: false,
        }]}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onCancelAll={vi.fn()}
        onOpenMeeting={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(markup).toContain("1 running");
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
          createdAt: "2026-07-14T05:00:00Z",
          updatedAt: "2026-07-14T05:00:01Z",
          stage: "failed",
          recordingId: "recording-2",
          terminal: true,
          retryable: true,
          cancelRequested: false,
          retryCount: 0,
          sourceDataPreserved: true,
          rawPathExposed: false,
          keyMaterialExposedToRenderer: false,
          error: {
            code: "LOCAL_AI_FAILED",
            title: "Local work failed",
            message: "The local recap could not be completed. Your meeting is safe.",
            retryable: true,
            severity: "error",
            correlationId: "b".repeat(32),
            rawPathExposed: false,
          },
        }]}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onCancelAll={vi.fn()}
        onOpenMeeting={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(markup).toContain("1 task needs attention");
    expect(markup).toContain("Your meeting is safe");
    expect(markup).toContain('aria-label="Retry Creating recap"');
    expect(markup).toContain('aria-label="Dismiss Creating recap"');
  });

  it("renders every background task state accurately", () => {
    const states: BackgroundTask["state"][] = [
      "queued",
      "running",
      "paused",
      "cancelling",
      "completed",
      "failed",
      "cancelled",
    ];
    const jobs = states.map((state, index): BackgroundTask => ({
      jobId: String(index + 1).repeat(32),
      type: "export",
      state,
      createdAt: "2026-07-14T05:00:00Z",
      updatedAt: "2026-07-14T05:00:01Z",
      stage: state,
      progress: state === "running" ? { completed: 2, total: 4, unit: "chunks" } : null,
      estimatedRemainingMs: state === "running" ? 30_000 : null,
      terminal: state === "completed" || state === "failed" || state === "cancelled",
      retryable: state === "failed" || state === "paused",
      cancelRequested: state === "cancelling" || state === "cancelled",
      retryCount: 0,
      sourceDataPreserved: true,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
      error: state === "failed" ? {
        code: "EXPORT_FAILED",
        title: "Export failed",
        message: "The local export could not be completed.",
        retryable: true,
        severity: "error",
        correlationId: String(index + 1).repeat(32),
        rawPathExposed: false,
      } : null,
    }));
    const markup = renderToStaticMarkup(
      <BackgroundActivity
        jobs={jobs}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onCancelAll={vi.fn()}
        onOpenMeeting={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(markup).toContain("Background tasks");
    expect(markup).toContain("1 running / 1 queued / 1 paused / 1 cancelling");
    expect(markup).toContain("Waiting to start");
    expect(markup).toContain("2 of 4 chunks");
    expect(markup).toContain("Paused");
    expect(markup).toContain('aria-label="Resume Creating export"');
    expect(markup).toContain("Cancelling");
    expect(markup).toContain("Ready");
    expect(markup).toContain("The local export could not be completed.");
    expect(markup).toContain("Cancelled");
  });

  it("announces cancellation without describing it as a failure", () => {
    const cancelled = {
      jobId: "c".repeat(32),
      type: "recap",
      state: "cancelled",
      createdAt: "2026-07-14T05:00:00Z",
      updatedAt: "2026-07-14T05:00:01Z",
      stage: "cancelled",
      terminal: true,
      retryable: false,
      cancelRequested: true,
      retryCount: 0,
      sourceDataPreserved: true,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    } satisfies BackgroundTask;

    expect(terminalTaskAnnouncement(cancelled)).toBe("Creating recap cancelled.");
    expect(terminalTaskAnnouncement(cancelled)).not.toContain("needs attention");
  });
});
