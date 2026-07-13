import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AnimatedTranscript } from "./meeting-motion";

describe("AnimatedTranscript accessibility", () => {
  it("makes the scrollable transcript region keyboard focusable", () => {
    const markup = renderToStaticMarkup(
      <AnimatedTranscript
        emptyMessage="No transcript"
        segments={[{
          id: "segment-1",
          speaker: "Alex",
          startMs: 1_000,
          channel: "mic",
          text: "Keep the transcript locally accessible.",
        }]}
      />,
    );

    expect(markup).toContain('class="transcript-stream"');
    expect(markup).toContain('role="region"');
    expect(markup).toContain('aria-label="Transcript segments"');
    expect(markup).toContain('tabindex="0"');
  });
});
