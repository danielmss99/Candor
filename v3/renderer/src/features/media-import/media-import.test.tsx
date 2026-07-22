import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  MediaImportControl,
  MediaImportStatus,
  mediaImportStateFromResult,
  runMediaImport,
} from "./MediaImportControl";
import type { MediaImportResult } from "./types";

function result(overrides: Partial<MediaImportResult> = {}): MediaImportResult {
  return {
    canceled: false,
    imported: true,
    failureCode: null,
    recordingId: "rec_1",
    jobId: "job_1",
    localOnly: true,
    networkAttempted: false,
    rawPathExposed: false,
    keyMaterialExposedToRenderer: false,
    ...overrides,
  };
}

describe("media import renderer", () => {
  it("renders an accessible no-path import control with fixed supported formats", () => {
    const markup = renderToStaticMarkup(<MediaImportControl importMedia={vi.fn()} />);
    expect(markup).toContain("Import recorded media");
    expect(markup).toContain("Import media file");
    expect(markup).toContain("AAC-LC or ALAC");
    expect(markup).toContain("Vorbis in WebM");
    expect(markup).toContain("WebM Opus and video-only files are rejected");
    expect(markup).toContain('aria-describedby="media-import-status"');
    expect(markup).not.toContain("sourcePath");
    expect(markup).not.toContain('type="file"');
  });

  it("notifies the host after an imported meeting without exposing a path", async () => {
    const onImported = vi.fn();
    const importMedia = vi.fn(async () => result());
    await expect(runMediaImport(importMedia, onImported)).resolves.toEqual({ status: "imported" });
    expect(onImported).toHaveBeenCalledWith(result());

    const markup = renderToStaticMarkup(<MediaImportControl importMedia={importMedia} onImported={onImported} compact />);
    expect(markup).toContain("media-import-control compact");
    expect(markup).not.toContain("sourcePath");
  });

  it("disables media import with a clear reason while capture is active", () => {
    const markup = renderToStaticMarkup(
      <MediaImportControl
        importMedia={vi.fn()}
        disabled
        disabledMessage="Finish the current recording before importing media."
      />,
    );
    expect(markup).toContain("disabled");
    expect(markup).toContain("Finish the current recording before importing media.");
  });

  it("maps imported, canceled, unsupported decoder, and generic failure results", async () => {
    await expect(runMediaImport(async () => result())).resolves.toEqual({ status: "imported" });
    await expect(runMediaImport(async () => result({ canceled: true, imported: false }))).resolves.toEqual({ status: "canceled" });
    expect(mediaImportStateFromResult(result({ imported: false, failureCode: "UNSUPPORTED_DECODER" })))
      .toEqual({ status: "unsupported-decoder" });
    expect(mediaImportStateFromResult(result({ imported: false, failureCode: "MEDIA_IMPORT_CODEC_UNSUPPORTED" })))
      .toEqual({ status: "unsupported-decoder" });
    await expect(runMediaImport(async () => { throw new Error("private path"); })).resolves.toEqual({
      status: "error",
      message: "The media file could not be imported. Try another supported file.",
    });
  });

  it("shows clear live-region copy for every terminal state", () => {
    expect(renderToStaticMarkup(<MediaImportStatus state={{ status: "imported" }} />)).toContain("Media imported");
    expect(renderToStaticMarkup(<MediaImportStatus state={{ status: "canceled" }} />)).toContain("No files were changed");
    const unsupported = renderToStaticMarkup(<MediaImportStatus state={{ status: "unsupported-decoder" }} />);
    expect(unsupported).toContain('role="alert"');
    expect(unsupported).toContain("WebM Opus is not supported");
    const error = renderToStaticMarkup(<MediaImportStatus state={{ status: "error", message: "Import failed safely." }} />);
    expect(error).toContain('role="alert"');
    expect(error).toContain("Import failed safely.");
  });
});
