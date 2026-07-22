import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RecorderPanel } from "./RecorderPanel";

const baseProps = {
  open: true,
  activeCapture: false,
  combinedCaptureAvailable: true,
  disabled: false,
  recordingBlocked: false,
  recordingTitle: "Weekly planning",
  onRecordingTitleChange: vi.fn(),
  onStart: vi.fn(),
  onClose: vi.fn(),
};

describe("RecorderPanel", () => {
  it("opens as a modal confirmation without starting capture", () => {
    const markup = renderToStaticMarkup(<RecorderPanel {...baseProps} />);

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain("Opening this panel never starts recording.");
    expect(markup).toContain("Start recording");
    expect(baseProps.onStart).not.toHaveBeenCalled();
  });

  it("does not offer another start action while capture is active", () => {
    const markup = renderToStaticMarkup(<RecorderPanel {...baseProps} activeCapture />);

    expect(markup).toContain("A recording is already active");
    expect(markup).not.toContain(">Start recording<");
  });

  it("fails closed when storage blocks recording", () => {
    const markup = renderToStaticMarkup(<RecorderPanel {...baseProps} recordingBlocked />);

    expect(markup).toContain("Recording is unavailable until the local storage warning is resolved.");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Start recording<\/button>/);
  });
});
