import { useState } from "react";
import type { ImportMedia, MediaImportResult, MediaImportState } from "./types";

export interface MediaImportControlProps {
  importMedia?: ImportMedia;
  compact?: boolean;
  disabled?: boolean;
  disabledMessage?: string;
  onImported?: (result: MediaImportResult) => void | Promise<void>;
}

function nativeImportMedia(): ImportMedia | null {
  const api = window.candor;
  return typeof api?.meetings?.importMedia === "function" ? api.meetings.importMedia : null;
}

export function mediaImportStateFromResult(result: MediaImportResult): MediaImportState {
  if (result.canceled) return { status: "canceled" };
  if (new Set([
    "UNSUPPORTED_DECODER",
    "MEDIA_DECODER_UNSUPPORTED",
    "MEDIA_IMPORT_CODEC_UNSUPPORTED",
    "MEDIA_IMPORT_DECODER_UNAVAILABLE",
  ]).has(result.failureCode ?? "")) {
    return { status: "unsupported-decoder" };
  }
  if (result.imported) return { status: "imported" };
  return { status: "error", message: "The media file could not be imported." };
}

export async function runMediaImport(
  importMedia: ImportMedia,
  onImported?: (result: MediaImportResult) => void | Promise<void>,
): Promise<MediaImportState> {
  try {
    const result = await importMedia();
    if (result.imported && onImported) {
      try {
        await onImported(result);
      } catch {
        // Import completion is authoritative even if its renderer refresh fails.
      }
    }
    return mediaImportStateFromResult(result);
  } catch {
    return { status: "error", message: "The media file could not be imported. Try another supported file." };
  }
}

export function MediaImportStatus({ state }: { state: MediaImportState }) {
  if (state.status === "idle") {
    return <p className="media-import-status">Imports PCM16 WAV, MP3, AAC-LC or ALAC in M4A and MP4, and Vorbis in WebM. WebM Opus and video-only files are rejected.</p>;
  }
  if (state.status === "importing") {
    return <p className="media-import-status" role="status" aria-live="polite">Importing media locally...</p>;
  }
  if (state.status === "imported") {
    return <p className="media-import-status success" role="status" aria-live="polite">Media imported. Candor is preparing the meeting.</p>;
  }
  if (state.status === "canceled") {
    return <p className="media-import-status" role="status" aria-live="polite">Import canceled. No files were changed.</p>;
  }
  if (state.status === "unsupported-decoder") {
    return <p className="media-import-status error" role="alert">That codec is not supported. Candor imports PCM16 WAV, MP3, AAC-LC or ALAC in M4A and MP4, and Vorbis in WebM. WebM Opus is not supported.</p>;
  }
  return <p className="media-import-status error" role="alert">{state.message}</p>;
}

export function MediaImportControl({
  importMedia,
  compact = false,
  disabled = false,
  disabledMessage,
  onImported,
}: MediaImportControlProps) {
  const [state, setState] = useState<MediaImportState>({ status: "idle" });
  const importing = state.status === "importing";

  const startImport = async () => {
    if (disabled) return;
    const invoke = importMedia ?? nativeImportMedia();
    if (!invoke) {
      setState({ status: "error", message: "Media import is unavailable in this Candor build." });
      return;
    }
    setState({ status: "importing" });
    setState(await runMediaImport(invoke, onImported));
  };

  return (
    <section className={`media-import-control${compact ? " compact" : ""}`} aria-labelledby="media-import-heading">
      <div>
        <h3 id="media-import-heading">Import recorded media</h3>
        <p>Choose an existing recording to create a new local Candor meeting.</p>
      </div>
      <button type="button" onClick={() => void startImport()} disabled={disabled || importing} aria-describedby="media-import-status">
        {importing ? "Importing..." : "Import media file"}
      </button>
      <div id="media-import-status">
        {disabled && disabledMessage
          ? <p className="media-import-status" role="status">{disabledMessage}</p>
          : <MediaImportStatus state={state} />}
      </div>
    </section>
  );
}
