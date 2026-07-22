import { useEffect, useState } from "react";

export interface ProvisionalTranscriptSegment {
  recordingId: string;
  sequence: number;
  startMs: number;
  endMs: number;
  text: string;
}

const MAX_PROVISIONAL_SEGMENTS = 256;

export function mergePartialTranscript(
  current: readonly ProvisionalTranscriptSegment[],
  payload: LiveTranscriptPartialPayload,
): ProvisionalTranscriptSegment[] {
  const next: ProvisionalTranscriptSegment = {
    recordingId: payload.recordingId,
    sequence: payload.sequence,
    startMs: payload.startMs,
    endMs: payload.endMs,
    text: payload.text,
  };
  return [...current.filter((segment) => segment.sequence !== next.sequence), next]
    .sort((left, right) => left.sequence - right.sequence)
    .slice(-MAX_PROVISIONAL_SEGMENTS);
}

export function useLiveTranscript(
  api: NonNullable<Window["candor"]> | undefined,
  activeRecordingId: string,
) {
  const [segments, setSegments] = useState<ProvisionalTranscriptSegment[]>([]);

  useEffect(() => {
    setSegments([]);
    if (!api?.events || !activeRecordingId) return;
    return api.events.subscribe("transcript.partial", (payload) => {
      if (payload.recordingId !== activeRecordingId) return;
      setSegments((current) => mergePartialTranscript(current, payload));
    });
  }, [activeRecordingId, api]);

  return { recordingId: activeRecordingId, segments };
}
